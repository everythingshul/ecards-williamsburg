// Disccardpromos account creation/linking/reconciliation — everything that
// decides WHICH real disccardpromos customer an applicant's money should go
// onto, and keeps that in sync over time. services/giftcard.js stays a pure
// adapter (only knows how to talk to disccardpromos' actual API); this file
// is the business logic sitting between it and routes/applicants.js.
import { db } from '../db.js';
import * as giftcard from '../services/giftcard.js';
import { getActiveSeasonId } from '../utils/formSchedule.js';
import { lockApplicantCards } from './cardSync.js';
import { getApplicantBalances } from './applicantBalance.js';

// Old rows can carry a corrupted "74421.0" id (see giftcard.js's
// normalizeCustomerId) — stripped here too so a comparison against a clean
// id from a fresh customer-list pull isn't fooled by it.
function cleanId(id) { return id == null ? null : String(id).replace(/\.0$/, ''); }

// ============================= Account creation/linking =============================

// Which applicant fields Settings > Organization > Gift Card Loading lets an
// admin choose to push to disccardpromos — external_id and the shul's group
// name are always included regardless (they're how a customer gets matched
// and organized at all, not "applicant info" in the sense being toggled).
// Default (no setting saved yet) is everything, matching the original
// always-push-it-all behavior so existing orgs see no change until someone
// deliberately narrows it.
export const PROVIDER_PUSH_FIELDS = ['first_name', 'last_name', 'home_phone', 'husband_cell', 'wife_cell', 'email', 'address', 'city', 'state', 'zip'];

function getProviderPushFields(orgId) {
  const row = db.prepare(`SELECT value FROM settings WHERE org_id = ? AND key = 'disccardpromos_push_fields'`).get(orgId);
  if (!row) return PROVIDER_PUSH_FIELDS;
  try {
    const saved = JSON.parse(row.value);
    return Array.isArray(saved) ? saved.filter(f => PROVIDER_PUSH_FIELDS.includes(f)) : PROVIDER_PUSH_FIELDS;
  } catch { return PROVIDER_PUSH_FIELDS; }
}

// Builds the opts object giftcard.js's create/updateCustomer expect, limited
// to whichever fields are configured to push. husband_cell/wife_cell map to
// disccardpromos' cell/phone2 slots respectively.
export function buildProviderOpts(orgId, applicant, groupName) {
  const allowed = getProviderPushFields(orgId);
  const opts = { externalId: applicant.external_id, groupName };
  if (allowed.includes('first_name')) opts.firstName = applicant.first_name;
  if (allowed.includes('last_name')) opts.lastName = applicant.last_name;
  if (allowed.includes('home_phone')) opts.homePhone = applicant.home_phone;
  if (allowed.includes('husband_cell')) opts.cell = applicant.husband_cell;
  if (allowed.includes('wife_cell')) opts.phone2 = applicant.wife_cell;
  if (allowed.includes('email')) opts.email = applicant.email;
  if (allowed.includes('address')) opts.address = applicant.address;
  if (allowed.includes('city')) opts.city = applicant.city;
  if (allowed.includes('state')) opts.state = applicant.state;
  if (allowed.includes('zip')) opts.zip = applicant.zip;
  return opts;
}

// True if this applicant was merged into another shul's record as the same
// real person (see services/duplicates.js's mergeApplicants) — merge_group_id
// is set to the PRIMARY member's own id on every member of a merged group,
// so a secondary is any row where that id differs from its own.
export function isMergedSecondary(applicant) {
  return !!applicant.merge_group_id && applicant.merge_group_id !== applicant.id;
}

// 'mock_leftover': this applicant's provider_account_id is one of
// giftcard.js's fake `mock_acct_<externalId>`/`mock_<uuid>` placeholders
// (see upsertAccountForApproval/assignCard) — it was approved while this
// season had no real disccardpromos keys configured, and NOTHING ever
// replaces it once real keys are added, because ensureProviderAccount's
// very first check ("does this applicant already have a
// provider_account_id?") trusts ANY non-null value forever and returns
// immediately, real or fake — the account, and any funds meant to be on
// it, were never actually created on disccardpromos. Only reported once the
// season itself is no longer in mock mode — while still legitimately in
// mock mode, a mock_ id is exactly the intended, correct value, not
// something wrong. See POST /applicants/fix-mock-accounts for the repair.
export function providerSyncStatus(a) {
  if (a.approval_status !== 'approved') return null;
  if (a.provider_exempt) return 'exempt';
  if (a.provider_account_id) {
    if (String(a.provider_account_id).startsWith('mock_') && !giftcard.isMockMode(a.season_id)) return 'mock_leftover';
    return 'synced';
  }
  return 'missing';
}

// Resolves which real disccardpromos identity a FUNDS WRITE for this
// applicant must target — the merge group's PRIMARY member's own
// provider_account_id/external_id, never a secondary's, even when the
// secondary carries its own (pre-merge) provider_account_id. Every write
// that loads or removes money for an applicant who might be part of a merge
// group must resolve through this, not use the applicant's own row
// directly: a secondary very often already has its own separate
// disccardpromos customer from before the duplicate was ever caught/merged
// (approval isn't blocked on duplicate resolution), and ensureProviderAccount
// itself only reconciles onto the shared account the first time a member
// gets ITS OWN provider_account_id assigned — once a row already has one set
// (from before the merge), ensureProviderAccount's own early-return skips
// the merge-group check entirely, so that stale, separate account id must
// never be trusted for a write. Read fresh from the DB (not off a possibly-
// stale in-memory `applicant`) since ensureProviderAccount may have just
// updated the primary's row moments earlier in the same request.
export function resolveFundingAnchor(applicant) {
  if (!applicant.merge_group_id || applicant.merge_group_id === applicant.id) return applicant;
  return db.prepare('SELECT * FROM applicants WHERE id = ?').get(applicant.merge_group_id) || applicant;
}

// The single shared entry point for getting an applicant a real
// disccardpromos account — replaces the ad hoc create-or-link logic that
// used to be duplicated inline in every approve path. A merge-group member
// with no account yet checks whether ANY other member of its group already
// holds one first (linking + reactivating that one instead of creating a
// second, duplicate account — the group shares one real customer no matter
// which member disccard actually knows it under); only creates/refreshes a
// new one when no group member has one at all. Returns
// { accountId, created, linked, error } so a caller can tell "this call is
// what created the account" (only that case should ever load first-time
// funds) apart from "this call merely linked to an already-existing one"
// (the person already has their card through the other record).
// index: an optional pre-built giftcard.buildCustomerIndex() result — when
// present, the account-existence check below reuses it instead of making
// its own live GET (see upsertAccountForApproval's existingHint param in
// giftcard.js). A caller processing many applicants in one run (mass-approve,
// runProviderEnforce) should build ONE index and pass it into every call
// here rather than pulling disccardpromos' customer list fresh per applicant.
export async function ensureProviderAccount(orgId, applicant, index) {
  if (applicant.provider_exempt) return { accountId: null, created: false, linked: false, error: 'This applicant is exempt from disccardpromos provisioning.' };
  if (!applicant.shul_id) return { accountId: null, created: false, linked: false, error: 'Applicant has no shul on file.' };
  if (applicant.provider_account_id) return { accountId: applicant.provider_account_id, created: false, linked: false, error: null };

  const groupId = applicant.merge_group_id || applicant.id;
  // The shared customer is always registered under the group's PRIMARY
  // identity (merge_group_id === id) — every PATCH to it, no matter which
  // member's own action triggered this call, must use the PRIMARY's own
  // external_id, never the calling member's, or the customer's stored
  // external_id gets silently overwritten with the wrong value (see
  // giftcard.js's linkCardToCustomer note on any PATCH omitting/mismatching
  // external_id).
  const anchor = applicant.merge_group_id
    ? (db.prepare('SELECT * FROM applicants WHERE id = ?').get(applicant.merge_group_id) || applicant)
    : applicant;

  if (applicant.merge_group_id) {
    const groupAccount = db.prepare(`SELECT provider_account_id FROM applicants WHERE (id = ? OR merge_group_id = ?) AND provider_account_id IS NOT NULL LIMIT 1`).get(groupId, groupId);
    if (groupAccount?.provider_account_id) {
      try {
        // Reactivate in case it had been locked (e.g. this applicant's own
        // earlier reject deactivated it before the merge, or the OTHER
        // member it's shared with was since rejected) — a merge means the
        // account should be live again as long as ANY member is approved.
        await giftcard.updateCustomer(anchor.season_id, groupAccount.provider_account_id, { isActive: true, externalId: anchor.external_id });
      } catch (e) {
        return { accountId: null, created: false, linked: false, error: e.message };
      }
      db.prepare(`UPDATE applicants SET provider_account_id = ? WHERE id = ?`).run(groupAccount.provider_account_id, applicant.id);
      return { accountId: groupAccount.provider_account_id, created: false, linked: true, error: null };
    }
  }

  const shul = db.prepare('SELECT name_en FROM shuls WHERE id = ?').get(anchor.shul_id);
  // With an index in hand, we already know whether the anchor's external_id
  // has an account (and what it looks like) — pass that straight through as
  // the hint so upsertAccountForApproval skips its own live existence GET.
  // An explicit `null` (not undefined) here correctly means "confirmed
  // absent, create new" rather than "no index, do your own lookup".
  const existingHint = index ? (index.byExt.get(String(anchor.external_id)) || null) : undefined;
  try {
    const result = await giftcard.upsertAccountForApproval(anchor.season_id, buildProviderOpts(orgId, anchor, shul?.name_en || 'Unknown'), existingHint);
    if (result.accountId) {
      // Every member of this merge group (for a non-merged applicant, just
      // itself) shares this one account id.
      db.prepare(`UPDATE applicants SET provider_account_id = ? WHERE id = ? OR merge_group_id = ?`).run(result.accountId, groupId, groupId);
    }
    return { accountId: result.accountId || null, created: !!result.created, linked: false, error: null };
  } catch (e) {
    return { accountId: null, created: false, linked: false, error: e.message };
  }
}

// Shared repair routine for a set of applicants whose stored
// provider_account_id is known-stale — either a mock-mode placeholder (see
// providerSyncStatus's 'mock_leftover', a pure local string check) or a
// real-looking id runProviderAudit's live pull confirmed doesn't match any
// actual disccardpromos customer any more (deleted on their side, or the
// create call never actually finished — see ensureProviderAccount's header:
// it trusts ANY already-set id forever, real or not, which is the actual
// bug behind both cases). Clears the stale id (every applicant currently
// sharing that exact value together, in case it's a merge group's shared
// account, in one pass) and re-runs the same account-creation + fund-load
// an approval does. Only ever touches the applicant ids explicitly passed
// in — nothing is cleared/recreated for anyone not listed.
export async function repairStaleProviderAccounts(orgId, applicantIds) {
  const discountId = db.prepare(`SELECT value FROM settings WHERE org_id = ? AND key = 'disccardpromos_discount_id'`).get(orgId)?.value;
  let fixed = 0, failed = 0;
  const errors = [];
  const clearedStaleIds = new Set();
  for (const id of applicantIds) {
    const a = db.prepare('SELECT * FROM applicants WHERE id = ? AND org_id = ?').get(id, orgId);
    if (!a || !a.provider_account_id) continue;
    if (clearedStaleIds.has(a.provider_account_id)) continue;
    const staleId = a.provider_account_id;
    clearedStaleIds.add(staleId);
    db.prepare(`UPDATE applicants SET provider_account_id = NULL WHERE org_id = ? AND provider_account_id = ?`).run(orgId, staleId);
    const fresh = db.prepare('SELECT * FROM applicants WHERE id = ?').get(a.id);
    const acctResult = await ensureProviderAccount(orgId, fresh);
    if (acctResult.error) { failed++; errors.push({ applicantId: a.id, name: `${a.first_name} ${a.last_name}`.trim(), error: acctResult.error }); continue; }
    if (discountId) {
      const refreshed = db.prepare('SELECT * FROM applicants WHERE id = ?').get(a.id);
      const anchor = resolveFundingAnchor(refreshed);
      try { await creditGapToMatchLedger(orgId, anchor, discountId); }
      catch (e) { errors.push({ applicantId: a.id, name: `${a.first_name} ${a.last_name}`.trim(), error: `Account created but funds failed to load: ${e.message}` }); }
    }
    fixed++;
  }
  return {
    checked: applicantIds.length, fixed, failed, errors,
    fundsWarning: discountId ? null : 'No disccardpromos Package/Discount ID configured (Settings > Organization > Gift Card Loading) — accounts were created but no funds were pushed.',
  };
}

// ============================= Historical merge reconciliation =============================

// A merged-duplicate secondary (services/duplicates.js's mergeApplicants)
// only ever gets linked onto its primary's disccardpromos account by the
// approve routes' own propagation logic — which never ran for a merge that
// happened before that logic existed, or for a secondary approved before
// its primary. Given any member of a merge group, this is a pure DB-level
// fix (no disccardpromos call needed): find whichever member already holds
// a real provider_account_id and propagate it onto every other member that
// has none. Never overwrites a member that already holds its OWN different
// real account — surfaces that as a conflict for a human to reconcile
// instead (there's no confirmed API to merge two live disccardpromos
// accounts into one).
export function reconcileAccountsForGroup(applicantId) {
  const applicant = db.prepare('SELECT * FROM applicants WHERE id = ?').get(applicantId);
  if (!applicant) return { accountId: null, linked: 0, conflict: false, error: 'Applicant not found' };
  const groupId = applicant.merge_group_id || applicant.id;
  const members = db.prepare('SELECT * FROM applicants WHERE id = ? OR merge_group_id = ?').all(groupId, groupId);
  const distinctAccounts = [...new Set(members.map(m => m.provider_account_id).filter(Boolean).map(cleanId))];
  if (!distinctAccounts.length) return { accountId: null, linked: 0, conflict: false };
  if (distinctAccounts.length > 1) return { accountId: null, linked: 0, conflict: true, accounts: distinctAccounts, memberIds: members.map(m => m.id) };
  const accountId = distinctAccounts[0];
  const without = members.filter(m => !m.provider_account_id);
  if (!without.length) return { accountId, linked: 0, conflict: false };
  const ids = without.map(m => m.id);
  db.prepare(`UPDATE applicants SET provider_account_id = ? WHERE id IN (${ids.map(() => '?').join(',')})`).run(accountId, ...ids);
  return { accountId, linked: without.length, conflict: false };
}

// Runs reconcileAccountsForGroup across every existing merge group in a
// season/org, for fixing historical data in one pass — see
// routes/applicants.js's POST /reconcile-merged-accounts.
export function reconcileAllMergedAccounts(orgId, seasonId) {
  let where = 'WHERE org_id = ? AND merge_group_id IS NOT NULL';
  const params = [orgId];
  if (seasonId) { where += ' AND season_id = ?'; params.push(seasonId); }
  const groupIds = [...new Set(db.prepare(`SELECT DISTINCT merge_group_id FROM applicants ${where}`).all(...params).map(r => r.merge_group_id))];
  let linked = 0;
  const conflicts = [];
  for (const groupId of groupIds) {
    const result = reconcileAccountsForGroup(groupId);
    linked += result.linked;
    if (result.conflict) conflicts.push({ groupId, accounts: result.accounts, memberIds: result.memberIds });
  }
  return { groupsChecked: groupIds.length, linked, conflicts };
}

// ============================= Deactivation retry (item 4) =============================

// Re-attempts services/cardSync.js's lockApplicantCards for one applicant
// currently flagged with a provider_deactivate_error — same call, just
// exposed here so both the single and bulk retry routes share one path.
export async function retryDeactivation(orgId, applicant) {
  return lockApplicantCards(orgId, applicant);
}

// ============================= Full two-way audit (item 5) =============================

const auditJobs = new Map(); // orgId -> job state
export function getProviderAuditJob(orgId) { return auditJobs.get(orgId) || null; }

// Kicks off (or returns the already-running) audit job for this org. Async,
// fire-and-forget — poll getProviderAuditJob for progress/result.
export function startProviderAudit(orgId, seasonId) {
  const existing = auditJobs.get(orgId);
  if (existing?.status === 'running') return existing;
  const job = { status: 'running', progress: 0, total: 0, result: null, error: null, startedAt: new Date().toISOString(), finishedAt: null };
  auditJobs.set(orgId, job);
  runProviderAudit(orgId, seasonId, job).then(result => {
    job.result = result; job.status = 'done'; job.finishedAt = new Date().toISOString();
  }).catch(e => {
    job.status = 'error'; job.error = e.message; job.finishedAt = new Date().toISOString();
  });
  return job;
}

// The actual audit — reasons from BOTH sides at once instead of trusting our
// own database. Pulls disccardpromos' full customer list ONCE (see
// giftcard.js's listAllCustomers), then classifies everything from that one
// in-memory pull — never one GET per applicant.
export async function runProviderAudit(orgId, seasonId, job = { progress: 0, total: 0 }) {
  const applicants = db.prepare(`SELECT * FROM applicants WHERE org_id = ? AND season_id = ?`).all(orgId, seasonId);
  job.total = applicants.length;
  const isMock = giftcard.isMockMode(seasonId);
  const index = isMock ? null : await giftcard.buildCustomerIndex(seasonId);
  // Same rule as runProviderEnforce: a failed bulk pull ends the audit
  // rather than reasoning from an empty list (which would report every
  // applicant as "not found" and could relink/orphan on bad data).
  if (!isMock && !index) throw new Error('disccardpromos bulk customer list pull failed — audit aborted (never falls back to one call per applicant). See Logs > Provider Calls for the failed request.');
  const allCustomers = index?.list || [];
  // cleanId here (not the index's own normalizeCustomerId-keyed maps
  // directly) since this function's ids come from applicants.provider_account_id,
  // which can carry the ".0"-corrupted form (see cleanId's own comment) —
  // both normalize the same way, so re-keying with cleanId keeps this
  // function's existing lookups exactly as before.
  const byId = new Map(allCustomers.map(c => [cleanId(c.id), c]));
  const byExt = new Map(allCustomers.filter(c => c.external_id != null && c.external_id !== '').map(c => [String(c.external_id), c]));

  const active = [], inactive = [], notFound = [], mock = [], relinked = [];
  for (const a of applicants) {
    job.progress++;
    if (isMock) { if (a.provider_account_id) mock.push(a.id); continue; }
    if (a.provider_account_id) {
      const c = byId.get(cleanId(a.provider_account_id));
      if (!c) { notFound.push(a.id); continue; }
      (c.is_active ? active : inactive).push(a.id);
      continue;
    }
    // Approved-but-no-account: we may have simply lost the pointer while
    // they still have a real account — relink by external_id rather than
    // ever creating a second one.
    if (a.approval_status === 'approved' && !a.provider_exempt && a.external_id) {
      const c = byExt.get(String(a.external_id));
      if (c) {
        db.prepare('UPDATE applicants SET provider_account_id = ? WHERE id = ?').run(cleanId(c.id), a.id);
        relinked.push({ applicantId: a.id, accountId: cleanId(c.id) });
      }
    }
  }

  // Reverse direction: customers disccardpromos holds that nothing on our
  // side points at any more — trace where they likely came from rather than
  // just listing bare ids.
  const knownIds = new Set(db.prepare(`SELECT provider_account_id FROM applicants WHERE org_id = ? AND provider_account_id IS NOT NULL`).all(orgId).map(r => cleanId(r.provider_account_id)));
  const orphans = [];
  if (!isMock) {
    for (const c of allCustomers) {
      const id = cleanId(c.id);
      if (knownIds.has(id)) continue;
      let tracedTo = null;
      if (c.external_id) {
        const otherSeason = db.prepare(`SELECT a.id, a.first_name, a.last_name, s.name AS season_name FROM applicants a JOIN seasons s ON s.id = a.season_id WHERE a.org_id = ? AND a.external_id = ?`).get(orgId, c.external_id);
        if (otherSeason) tracedTo = { type: 'other_season', ...otherSeason };
        else {
          const auditRow = db.prepare(`SELECT id, entity_id, created_at FROM audit_log WHERE org_id = ? AND entity_type = 'applicant' AND (after_json LIKE ? OR before_json LIKE ?) ORDER BY created_at DESC LIMIT 1`)
            .get(orgId, `%"external_id":"${c.external_id}"%`, `%"external_id":"${c.external_id}"%`);
          if (auditRow) tracedTo = { type: 'deleted_applicant', auditLogId: auditRow.id, entityId: auditRow.entity_id, at: auditRow.created_at };
        }
      }
      orphans.push({ customerId: id, externalId: c.external_id || null, name: `${c.first_name || ''} ${c.last_name || ''}`.trim(), isActive: !!c.is_active, tracedTo });
    }
  }

  return {
    checked: applicants.length, customersOnProvider: allCustomers.length,
    // disccardpromos' own claimed total (from listAllCustomers' pagination
    // metadata) vs. what actually got collected — if these ever disagree,
    // the customer list is being silently truncated (see that function's
    // comment on why), and this is the visible proof, right in the admin
    // UI, that something's wrong with the pull itself rather than every
    // number downstream of it just happening to look off.
    providerReportedTotal: allCustomers.reportedTotal ?? null,
    mockMode: isMock,
    active: active.length, inactive: inactive.length, notFound: notFound.length,
    activeIds: active, inactiveIds: inactive, notFoundIds: notFound, mockIds: mock,
    relinked, orphans,
  };
}

// ============================= "Make Disccardpromos Match" enforcement (item 8) =============================

const enforceJobs = new Map(); // orgId -> job state
export function getProviderEnforceJob(orgId) { return enforceJobs.get(orgId) || null; }

export function startProviderEnforce(orgId, seasonId, { fullSync = false } = {}) {
  const existing = enforceJobs.get(orgId);
  if (existing?.status === 'running') return existing;
  const job = { status: 'running', progress: 0, total: 0, result: null, error: null, startedAt: new Date().toISOString(), finishedAt: null };
  enforceJobs.set(orgId, job);
  runProviderEnforce(orgId, seasonId, job, { fullSync }).then(result => {
    job.result = result; job.status = 'done'; job.finishedAt = new Date().toISOString();
  }).catch(e => {
    job.status = 'error'; job.error = e.message; job.finishedAt = new Date().toISOString();
  });
  return job;
}

// Corrects an EXISTING account's balance to match this app's own ledger
// total. REVERTED (2026-09-16, explicit instruction) from the add-funds/
// live-gap approach back to a plain absolute push — add-funds turned out
// to have the SAME failure mode as the 'amount' PATCH (a genuinely new
// allocation still read $0 on the correctly-matched package afterward), so
// switching endpoints didn't fix anything. giftcard.js's
// setPackageAmountAbsolute now verifies its own write (reads the PATCH
// response's own packages array, throws if the real amount doesn't match
// what was requested) whenever discountId is passed, so a write that
// silently fails to land shows up as a real, visible error here insteadof
// a false "ok" the way it used to.
export async function creditGapToMatchLedger(orgId, applicant, discountId) {
  const anchor = resolveFundingAnchor(applicant);
  if (!anchor.provider_account_id) return { skipped: 'no provider account' };
  // Pushes `loaded` (total ever granted), not `remaining` (loaded minus
  // this app's own locally-tracked spend) — confirmed (2026-09-16)
  // disccardpromos deducts real store purchases from "amount" automatically
  // on its own side, so subtracting this app's own separately-unreliable
  // spend tracking before writing would double-count that deduction.
  const ledger = getApplicantBalances(orgId, [applicant.id]).get(applicant.id) || { loaded: applicant.card_amount || 0 };
  await giftcard.setPackageAmountAbsolute(applicant.season_id, { customerId: anchor.provider_account_id, externalId: anchor.external_id, totalAmount: ledger.loaded, discountId });
  return { target: ledger.loaded };
}

// Live-checks, BEFORE any destructive merge write happens, whether merging
// this group is a REAL money decision — see the merge-conflict-resolution
// spec this implements: only ask when BOTH the surviving account and a
// losing account are confirmed (or unknown, which fails toward "assume
// there might be money" rather than skipping the check) to hold actual
// money right now. Never trusts a cached/locally-synced balance column —
// always a live disccardpromos read, the same rule every other money
// decision in this app already follows. Returns [] (auto-merge, no ask
// needed) when there's at most one real account in the group, or when the
// non-primary account(s) are confirmed empty. Pure read — mutates nothing.
export async function checkAccountConflicts(orgId, primaryId, memberIds) {
  const groupIds = Array.isArray(memberIds) && memberIds.length ? memberIds : [primaryId];
  const members = db.prepare(`SELECT * FROM applicants WHERE org_id = ? AND id IN (${groupIds.map(() => '?').join(',')})`).all(orgId, ...groupIds);
  const primary = members.find(m => m.id === primaryId);
  if (!primary) return [];
  const withAccount = members.filter(m => m.provider_account_id);
  const primaryAccountId = primary.provider_account_id ? cleanId(primary.provider_account_id) : null;
  const distinctLoserIds = [...new Set(withAccount.map(m => cleanId(m.provider_account_id)))].filter(id => id !== primaryAccountId);
  if (!primaryAccountId || !distinctLoserIds.length) return [];
  // Mock mode (no real disccardpromos keys configured yet — see CLAUDE.md)
  // has no real money to lose at all; every provider_account_id here is a
  // synthetic mock_acct_... placeholder, not a live balance that could
  // fail to read. Treating that as "unknown, assume there might be money"
  // (the right call for a genuine read FAILURE) would instead flag every
  // single merge with more than one mock account as a conflict, which is
  // just noise until the org actually goes live — so this returns no
  // conflicts at all while still mocked, same as the auto-merge path
  // already used before this feature existed.
  if (giftcard.isMockMode(primary.season_id)) return [];
  const readLiveBalance = async (accountId) => {
    try {
      const live = await giftcard.getCustomerById(primary.season_id, accountId, { balances: true, suppressNotFound: true });
      if (!live) return { balance: 0, unknown: false };
      const bal = (live.packages || []).reduce((s, p) => s + (Number(p.balance) || 0), 0);
      return { balance: Math.round(bal * 100) / 100, unknown: false };
    } catch (e) {
      console.error(`[providerAccount] checkAccountConflicts: live balance read failed for account ${accountId} — assuming there might be money rather than skipping the check:`, e.message);
      return { balance: null, unknown: true };
    }
  };
  const primaryRead = await readLiveBalance(primaryAccountId);
  const primaryHasMoney = primaryRead.unknown || primaryRead.balance > 0;
  const conflicts = [];
  for (const loserId of distinctLoserIds) {
    const rep = withAccount.find(m => cleanId(m.provider_account_id) === loserId);
    const secondaryRead = await readLiveBalance(loserId);
    const secondaryHasMoney = secondaryRead.unknown || secondaryRead.balance > 0;
    if (primaryHasMoney && secondaryHasMoney) {
      conflicts.push({
        primaryId, primaryAccountId, primaryExternalId: primary.external_id, primaryName: `${primary.first_name || ''} ${primary.last_name || ''}`.trim(), primaryBalance: primaryRead.balance,
        secondaryId: rep.id, secondaryAccountId: loserId, secondaryExternalId: rep.external_id, secondaryName: `${rep.first_name || ''} ${rep.last_name || ''}`.trim(), secondaryBalance: secondaryRead.balance,
      });
    }
  }
  return conflicts;
}

// After a merge (services/duplicates.js's mergeApplicants) where MORE THAN
// ONE member already held its own real disccardpromos account — i.e. two
// profiles were each approved and funded before anyone noticed they were
// the same person — this closes every non-primary account and folds its
// unspent money onto the primary's, so the person ends up with ONE live
// card. Money-safe by construction:
//  - the losing account is read live first (top-level `amount` = what was
//    committed to it, packages[].balance = what's still unspent); the
//    difference is what that person already spent on it. That spend is
//    recorded on the losing member as merged_spend_adjustment, which
//    services/applicantBalance.js subtracts from the group's `loaded` — so
//    the primary's next amount push carries (everything ever granted to
//    the person) minus (what was already spent on the closed account),
//    never re-crediting spent money — and from `spent`, so the app's own
//    remaining figure stays "unspent money on the live card".
//  - the losing account is deactivated (never deleted), with its own
//    external_id resent so the PATCH doesn't wipe it.
//  - every member's provider_account_id is repointed at the primary's, and
//    the primary is re-pushed immediately. A live-read or deactivate
//    failure on one losing account leaves THAT account untouched (still
//    live, still pointed at) and is reported, rather than half-merging.
// If the primary itself has no account, the earliest-created member's
// becomes the group's account and the rest are closed onto it.
//
// resolutions (optional): { [loserAccountId]: 'transfer' | 'keep_primary' |
// 'use_secondary' } — an admin's explicit choice from checkAccountConflicts'
// modal, for a loser account that turned out to hold real money alongside
// the primary's own. Any loser NOT in this map (the overwhelming majority
// — most merges have at most one funded account at all) gets 'transfer',
// which is exactly this function's original, unconditional behavior:
// nothing changes for that case.
//   - 'transfer': unchanged from before — mergeApplicantRowsInto (called
//     before this ever runs) has already repointed the loser's own
//     shul_allocations onto the primary, so the group's combined ledger
//     total ALREADY equals the sum of both sides; only what was already
//     spent on the closed account needs excluding (as always).
//   - 'keep_primary': the loser's ENTIRE contribution (not just what was
//     already spent) is written off — none of it should count toward the
//     group's future funding target, since the admin explicitly chose not
//     to move it.
//   - 'use_secondary': overrides the group's combined target to be exactly
//     the loser's own live balance, ignoring the primary's own natural
//     contribution — done as a permanent merged_spend_adjustment delta
//     (not a one-time push) so it survives every later recomputation
//     (runProviderEnforce, a future approval, ...) instead of quietly
//     being overwritten back to the natural sum on the next sync. The
//     SAME disccardpromos account keeps surviving either way (swapping
//     which real customer id is "the" account would mean re-anchoring the
//     whole group's identity, far more invasive for the same outcome) —
//     what changes is only the dollar figure that ends up on it.
//
// preMergeMembers (required in practice): the group's full applicant rows
// (each optionally carrying a `_cardIds` array of that member's own card
// ids) as they stood immediately BEFORE mergeApplicants ran. This is not
// optional dressing — mergeApplicants always collapses every non-primary
// member to a single surviving row first (services/duplicates.js's
// mergeApplicantRowsInto DELETEs the loser rows and repoints their cards
// onto the primary) before this function is ever called, so a query of the
// applicants/cards tables run from in here would find no trace of which
// disccardpromos account a loser had, or which cards were originally
// theirs — every loser-scoped write below would silently affect zero rows.
// The one caller (the merge route) captures this snapshot right before
// calling mergeApplicants, while the data still exists. Falls back to a
// fresh (now known-unreliable post-collapse) DB query only if ever called
// without it, so this stays a usable general utility rather than crashing.
export async function consolidateProviderAccounts(orgId, primaryId, resolutions = {}, preMergeMembers = null) {
  const usingSnapshot = !!(preMergeMembers && preMergeMembers.length);
  const members = usingSnapshot
    ? preMergeMembers
    : db.prepare(`SELECT * FROM applicants WHERE org_id = ? AND (id = ? OR merge_group_id = ?) ORDER BY (id = ?) DESC, created_at ASC`).all(orgId, primaryId, primaryId, primaryId);
  const primary = members.find(m => m.id === primaryId);
  if (!primary) return { closed: 0, errors: ['Primary not found'] };
  const withAccount = members.filter(m => m.provider_account_id);
  const keepAccount = primary.provider_account_id || withAccount[0]?.provider_account_id || null;
  if (!keepAccount) return { closed: 0, errors: [] };
  const losers = [...new Set(withAccount.map(m => cleanId(m.provider_account_id)))].filter(id => id !== cleanId(keepAccount));
  const errors = [], details = [];
  const shulName = (id) => (id ? db.prepare('SELECT name_en FROM shuls WHERE id = ?').get(id)?.name_en : null) || null;
  let closed = 0, movedUnspent = 0;
  for (const loserAccountId of losers) {
    const loserMembers = withAccount.filter(m => cleanId(m.provider_account_id) === loserAccountId);
    const rep = loserMembers[0];
    try {
      let spentOnLoser = 0, unspent = 0, committed = 0, found = false;
      if (!giftcard.isMockMode(rep.season_id)) {
        const live = await giftcard.getCustomerById(rep.season_id, loserAccountId, { balances: true, suppressNotFound: true });
        if (live) {
          found = true;
          committed = live.amount != null ? Number(live.amount) : 0;
          unspent = Math.round((live.packages || []).reduce((s, p) => s + (Number(p.balance) || 0), 0) * 100) / 100;
          spentOnLoser = Math.max(0, Math.round((committed - unspent) * 100) / 100);
          await giftcard.updateCustomer(rep.season_id, loserAccountId, { isActive: false, externalId: live.external_id || rep.external_id });
        }
      }
      const action = resolutions[loserAccountId] || 'transfer';
      // merged_spend_adjustment (db.js) ALWAYS gets exactly what was really
      // spent, regardless of which resolution the admin picked — "was money
      // spent on this account" is a fact, not a decision, and this column
      // also subtracts from `spent` (see applicantBalance.js), so it must
      // never carry anything but genuine spend history or it'll wrongly
      // deflate the survivor's own unrelated real purchases.
      details.push({
        accountId: loserAccountId, memberName: `${rep.first_name || ''} ${rep.last_name || ''}`.trim(), shulName: shulName(rep.shul_id),
        externalId: rep.external_id, foundOnProvider: found, committed: Math.round(committed * 100) / 100, alreadySpent: spentOnLoser,
        unspentMoved: action === 'keep_primary' ? 0 : unspent, resolution: action,
      });
      // Attribute the write-off to the SURVIVING primary row, not the
      // loser's own id (`rep.id`) — when called with a preMergeMembers
      // snapshot (the real, only call site), `rep.id` no longer exists in
      // the applicants table by the time this runs (mergeApplicantRowsInto
      // already deleted it), so a write targeting it would silently affect
      // zero rows and the adjustment would just be lost. The group SUM is
      // what getApplicantBalances actually reads (see applicantBalance.js),
      // and post-collapse the group has exactly one live row — primaryId —
      // so that's the only id this can safely land on.
      db.prepare(`UPDATE applicants SET merged_spend_adjustment = merged_spend_adjustment + ? WHERE id = ?`).run(spentOnLoser, primaryId);
      // merged_funding_adjustment (db.js) is where every resolution-specific
      // FUNDING correction goes — `loaded` only, never `spent` (none of this
      // is spend history). A loser's own approval-time card_amount is never
      // migrated anywhere by mergeApplicantRowsInto (only shul_allocations
      // rows get repointed onto the primary — it's a raw column on a row
      // that's about to be DELETED), so it simply vanishes from the local
      // ledger unless credited back here. Only relevant in snapshot mode: on
      // the legacy non-snapshot fallback path (called before any collapse),
      // the loser's own card_amount is still its own row in the same merge
      // group and already correctly counted — crediting it again would be
      // wrong, so this is 0 there and every branch below is a no-op.
      const loserCardAmount = usingSnapshot
        ? loserMembers.reduce((s, m) => s + (m.approval_status === 'approved' ? (m.card_amount || 0) : 0), 0)
        : 0;
      let fundingAdjustment = 0;
      if (action === 'keep_primary') {
        // Cancel out whatever the local ledger actually still holds for
        // this loser — `committed` minus whatever portion was never locally
        // reflected in the first place (loserCardAmount): there's nothing
        // to "abandon" for money the group's own ledger never counted as
        // available to begin with.
        fundingAdjustment = -Math.max(0, Math.round((committed - loserCardAmount) * 100) / 100);
      } else if (loserCardAmount) {
        // 'transfer' (and, provisionally, 'use_secondary' below — its own
        // override corrects for this either way): mergeApplicantRowsInto
        // already repointed any Give-action money (shul_allocations) onto
        // the primary, so only the card_amount portion is missing — credit
        // it back, net of nothing (spend is excluded separately above).
        fundingAdjustment = Math.round(loserCardAmount * 100) / 100;
      }
      if (fundingAdjustment) db.prepare(`UPDATE applicants SET merged_funding_adjustment = merged_funding_adjustment + ? WHERE id = ?`).run(fundingAdjustment, primaryId);
      if (action === 'use_secondary') {
        // Override the group's combined future target to be exactly this
        // loser's own live balance (`unspent`, read above) instead of the
        // natural primary+loser sum — see this function's header comment
        // for why this is a permanent ledger adjustment, not a one-time
        // push. Read the group's ledger AFTER the spend/funding adjustments
        // above already landed (better-sqlite3 statements run synchronously)
        // so the delta accounts for everything already true of the group at
        // this exact point, then corrects the rest in one more funding-only
        // adjustment (never touching `spent`, unlike the pre-fix version of
        // this override).
        // merged_funding_adjustment is added to `loaded` (see
        // applicantBalance.js), so — unlike the old merged_spend_adjustment
        // version of this same override, which was SUBTRACTED — the delta
        // needed here is (target - current), not (current - target).
        const naturalLoaded = getApplicantBalances(orgId, [primaryId]).get(primaryId)?.loaded ?? 0;
        const extraAdjustment = Math.round((unspent - naturalLoaded) * 100) / 100;
        if (extraAdjustment !== 0) db.prepare(`UPDATE applicants SET merged_funding_adjustment = merged_funding_adjustment + ? WHERE id = ?`).run(extraAdjustment, primaryId);
      }
      db.prepare(`UPDATE applicants SET provider_account_id = ? WHERE id IN (${loserMembers.map(() => '?').join(',')})`).run(keepAccount, ...loserMembers.map(m => m.id));
      // Same "loser row is already gone" problem as the merged_spend_adjustment
      // write above, one level deeper: mergeApplicantRowsInto also already
      // repointed every card's own applicant_id onto the primary, so by now
      // "WHERE applicant_id IN (loser ids)" matches nothing (or, worse, if it
      // ever DID match, it'd really be matching the primary's own cards,
      // since that's who those ids now belong to). With a preMergeMembers
      // snapshot, each member's own card ids were captured as `_cardIds`
      // before any of that happened — deactivate by explicit id instead.
      const cardIds = usingSnapshot ? loserMembers.flatMap(m => m._cardIds || []) : null;
      if (usingSnapshot) {
        if (cardIds.length) db.prepare(`UPDATE cards SET status = 'deactivated', deactivated_at = datetime('now') WHERE id IN (${cardIds.map(() => '?').join(',')}) AND status != 'deactivated'`).run(...cardIds);
      } else {
        db.prepare(`UPDATE cards SET status = 'deactivated', deactivated_at = datetime('now') WHERE applicant_id IN (${loserMembers.map(() => '?').join(',')}) AND status != 'deactivated'`).run(...loserMembers.map(m => m.id));
      }
      closed++; movedUnspent += (action === 'keep_primary' ? 0 : unspent);
    } catch (e) {
      errors.push(`Account ${loserAccountId}: ${e.message}`);
    }
  }
  // Every member (primary included, in case it had none) now points at the
  // surviving account; push the group's new ledger total onto it.
  db.prepare(`UPDATE applicants SET provider_account_id = ? WHERE (id = ? OR merge_group_id = ?) AND (provider_account_id IS NULL OR provider_account_id = ?)`).run(keepAccount, primaryId, primaryId, keepAccount);
  let newPrimaryTotal = null;
  if (closed) {
    const discountId = db.prepare(`SELECT value FROM settings WHERE org_id = ? AND key = 'disccardpromos_discount_id'`).get(orgId)?.value;
    const anchor = db.prepare('SELECT * FROM applicants WHERE id = ?').get(primaryId);
    if (discountId && anchor?.provider_account_id) {
      try { newPrimaryTotal = (await creditGapToMatchLedger(orgId, anchor, discountId)).target ?? null; }
      catch (e) { errors.push(`Re-push to the surviving account failed (will retry automatically): ${e.message}`); scheduleProviderEnforceSoon(orgId, `consolidation re-push failed for ${primaryId}`); }
    }
  }
  return {
    closed, movedUnspent: Math.round(movedUnspent * 100) / 100, keptAccountId: cleanId(keepAccount), errors, details,
    primaryName: `${primary.first_name || ''} ${primary.last_name || ''}`.trim(), primaryShulName: shulName(primary.shul_id), newPrimaryTotal,
  };
}

// One idempotent pass that enforces the whole rule end to end: every
// approved, non-exempt applicant holds exactly one ACTIVE disccardpromos
// customer (a merge group shares one, per ensureProviderAccount above);
// funds are loaded only onto an account THIS RUN just created (never an
// already-existing one — that's first-time issuance, not a top-up
// feature); any customer held only by non-approved applicants, or by
// nobody our side points at at all, gets deactivated. Nothing is ever
// deleted on either side. Re-pulls disccardpromos' list at the end and
// reports our approved-count vs their active-count side by side, plus
// exactly which applicants are still mismatched and why.
export async function runProviderEnforce(orgId, seasonId, job = { progress: 0, total: 0 }, { fullSync = false } = {}) {
  const discountId = db.prepare(`SELECT value FROM settings WHERE org_id = ? AND key = 'disccardpromos_discount_id'`).get(orgId)?.value;
  const applicants = db.prepare(`SELECT * FROM applicants WHERE org_id = ? AND season_id = ?`).all(orgId, seasonId);
  const approved = applicants.filter(a => a.approval_status === 'approved' && !a.provider_exempt && a.shul_id);
  job.total = approved.length;

  const isMock = giftcard.isMockMode(seasonId);
  // ONE bulk customer pull for the whole run, reused below by both the
  // account-existence check (in the ensureProviderAccount loop) and the
  // deactivation scan — this used to be a live GET per approved applicant
  // (via upsertAccountForApproval's own findCustomerByExternalId) plus a
  // SECOND full listAllCustomers() pull later in this same function for
  // deactivation, on every run of this scheduled-every-15-minutes job. A
  // stale/created-mid-run account just falls back to the old per-record
  // behavior (ensureProviderAccount treats a miss in the index the same as
  // "no index" for that one lookup) — nothing depends on this index staying
  // perfectly fresh through the whole run.
  const index = isMock ? null : await giftcard.buildCustomerIndex(seasonId);
  // EMERGENCY FIX (2026-09-17): if the ONE bulk customer pull fails, this
  // job must stop here — not continue into ensureProviderAccount with no
  // index, where every approved applicant would trigger its own live
  // existence GET (and, worse, a miss would be treated as "create a new
  // customer"). Reported as a failed run; the scheduler retries later.
  if (!isMock && !index) {
    return {
      ourApprovedCount: approved.length, theirActiveCount: null, mockMode: false,
      accountsCreated: 0, accountsDeactivated: 0, fundsErrors: [], mismatches: [],
      bulkCustomerPull: false, customersInBulkPull: null, accountExistenceCallsAvoided: 0,
      error: 'disccardpromos bulk customer list pull failed — nothing was checked or written this run (never falls back to one call per applicant). See Logs > Provider Calls for the failed request.',
    };
  }

  const mismatches = [];
  const createdApplicantIds = new Set();
  for (const a of approved) {
    job.progress++;
    // Re-fetch — an earlier member of this same merge group processed
    // earlier in this same loop may have just given this row an account.
    const fresh = db.prepare('SELECT * FROM applicants WHERE id = ?').get(a.id);
    const result = await ensureProviderAccount(orgId, fresh, index);
    if (result.error) { mismatches.push({ applicantId: a.id, name: `${a.first_name} ${a.last_name}`.trim(), reason: result.error }); continue; }
    if (result.created) createdApplicantIds.add(a.id);
  }

  const fundsErrors = [];
  if (discountId) {
    for (const applicantId of createdApplicantIds) {
      const a = db.prepare('SELECT * FROM applicants WHERE id = ?').get(applicantId);
      if (!(a.card_amount > 0) || !a.provider_account_id) continue;
      // REVERTED AGAIN (2026-09-16, explicit instruction) — add-funds had
      // the same failure mode as the 'amount' PATCH (a genuinely new
      // allocation still read $0 afterward), so back to the absolute push.
      // setPackageAmountAbsolute now verifies its own write when discountId
      // is passed — a silent no-op write shows up as a real error here.
      const anchor = resolveFundingAnchor(a);
      // Pushes `loaded`, not `remaining` — see creditGapToMatchLedger's note above.
      const ledger = getApplicantBalances(orgId, [a.id]).get(a.id) || { loaded: a.card_amount };
      try {
        await giftcard.setPackageAmountAbsolute(a.season_id, { customerId: a.provider_account_id, externalId: anchor.external_id, totalAmount: ledger.loaded, discountId });
      } catch (e) {
        fundsErrors.push({ applicantId: a.id, name: `${a.first_name} ${a.last_name}`.trim(), error: e.message });
      }
    }
  } else if (createdApplicantIds.size) {
    fundsErrors.push({ applicantId: null, name: null, error: 'No disccardpromos Package/Discount ID configured (Settings > Organization > Gift Card Loading) — new accounts were created but no funds were loaded onto them.' });
  }

  // Retry any allocation that never made it onto the real card the first
  // time (services/matching.js's createAllocation/reverseAllocation never
  // block on this write failing — the shul's own balance/ledger is the
  // source of truth and always updates — so a bad discount ID, a dropped
  // network request, or disccardpromos being briefly down just left
  // giftcard_status='failed' sitting there with nobody watching it, and the
  // money never actually arrived on/left the card despite this app showing
  // the give/undo as successful). This 15-minute sweep is the self-heal —
  // every write in this app pushes the applicant's FULL absolute ledger
  // total (see setPackageAmountAbsolute), so a retry always converges to
  // the correct number regardless of which specific row failed; several
  // failed rows for the same applicant are deduped into one retry.
  const touchedApplicantIds = new Set(createdApplicantIds);
  if (discountId) {
    const failedApplicantIds = [...new Set(
      db.prepare(`SELECT applicant_id FROM shul_allocations WHERE org_id = ? AND season_id = ? AND giftcard_status = 'failed'`)
        .all(orgId, seasonId).map(r => r.applicant_id)
    )].filter(id => !touchedApplicantIds.has(id));
    for (const applicantId of failedApplicantIds) {
      touchedApplicantIds.add(applicantId);
      const a = db.prepare('SELECT * FROM applicants WHERE id = ?').get(applicantId);
      if (!a || !a.provider_account_id) continue;
      try {
        // See creditGapToMatchLedger above — pushes the applicant's full
        // ledger total (`loaded`) as an absolute rewrite of "amount".
        await creditGapToMatchLedger(orgId, a, discountId);
        db.prepare(`UPDATE shul_allocations SET giftcard_status = 'ok', giftcard_error = NULL WHERE applicant_id = ? AND giftcard_status = 'failed'`).run(a.id);
      } catch (e) {
        db.prepare(`UPDATE shul_allocations SET giftcard_error = ? WHERE applicant_id = ? AND giftcard_status = 'failed'`).run(e.message, a.id);
        fundsErrors.push({ applicantId: a.id, name: `${a.first_name} ${a.last_name}`.trim(), error: `Retry of a previously-failed card sync still failing: ${e.message}` });
      }
    }
  }

  // FULL SYNC — every OTHER approved applicant not already touched above
  // gets its "amount" rewritten to this app's own ledger total (`loaded`)
  // too. Gated behind `fullSync` (2026-09-16, REVERTED after a real
  // incident) — briefly made this unconditional on every run, including the
  // automatic 15-minute sweep, on the theory that it's now always a safe
  // no-op (see creditGapToMatchLedger's comment: disccardpromos deducts
  // real spend from "amount" on its own side, so re-asserting the same
  // total repeatedly shouldn't erase anything). That reasoning about the
  // MONEY was fine — what it missed is that every one of these calls is
  // also a write to provider_call_log (services/apiCallLog.js), request
  // and response body included. Multiplying that by every approved
  // applicant, every 15 minutes, forever, filled the org's disk within
  // hours and took the whole app down (every request needs the DB) faster
  // than the existing 30-day/24-hour log-pruning job could ever catch up.
  // So: automatic (boot + 15-minute interval) runs no longer do this pass
  // at all — same as before that incident, only new-account and
  // previously-failed applicants get touched automatically. The admin's
  // "Make Disccardpromos Match" button passes `fullSync: true` so a human
  // can still trigger a real, one-off full self-heal on demand, without it
  // ever running unattended on a 15-minute timer.
  if (fullSync && discountId) {
    for (const a of approved) {
      if (touchedApplicantIds.has(a.id)) continue;
      const fresh = db.prepare('SELECT * FROM applicants WHERE id = ?').get(a.id);
      if (!fresh || !fresh.provider_account_id) continue;
      try {
        await creditGapToMatchLedger(orgId, fresh, discountId);
      } catch (e) {
        fundsErrors.push({ applicantId: fresh.id, name: `${fresh.first_name} ${fresh.last_name}`.trim(), error: `Full sync failed: ${e.message}` });
      }
    }
  }

  let deactivated = 0;
  if (!isMock) {
    // Reuse the same index pulled at the top of this run rather than a
    // second listAllCustomers() call — a customer created moments ago by
    // this very run's ensureProviderAccount loop just won't be in it yet,
    // which is fine: a newly-created account for a just-approved applicant
    // is never a deactivation candidate.
    const allCustomers = index?.list || [];
    const approvedAccountIds = new Set(approved.map(a => db.prepare('SELECT provider_account_id FROM applicants WHERE id = ?').get(a.id)?.provider_account_id).filter(Boolean).map(cleanId));
    for (const c of allCustomers) {
      if (!c.is_active) continue;
      if (approvedAccountIds.has(cleanId(c.id))) continue;
      try {
        await giftcard.updateCustomer(seasonId, c.id, { isActive: false, externalId: c.external_id });
        deactivated++;
      } catch (e) {
        mismatches.push({ applicantId: null, name: c.external_id || cleanId(c.id), reason: `Failed to deactivate an orphan/non-approved customer: ${e.message}` });
      }
    }
  }

  let theirActiveCount = null;
  if (!isMock) {
    const finalCustomers = await giftcard.listAllCustomers(seasonId);
    theirActiveCount = finalCustomers.filter(c => c.is_active).length;
  }

  return {
    ourApprovedCount: approved.length, theirActiveCount, mockMode: isMock,
    accountsCreated: createdApplicantIds.size, accountsDeactivated: deactivated,
    fundsErrors, mismatches,
    // Self-service proof that the batching fix (see giftcard.js's
    // buildCustomerIndex) is actually active on THIS run, without needing
    // server console access — this whole object is dumped verbatim in the
    // admin's "Make Disccardpromos Match" result panel. bulkCustomerPull
    // false with approved applicants present would mean the index build
    // failed and every run silently fell back to one live GET per
    // applicant — the exact pattern the fix was meant to eliminate.
    bulkCustomerPull: !!index,
    customersInBulkPull: index ? index.list.length : null,
    accountExistenceCallsAvoided: index ? approved.length : 0,
  };
}

// ============================= Automatic scheduling (item 9) =============================

function kickEnforce(orgId, reason) {
  const seasonId = getActiveSeasonId(orgId);
  if (!seasonId) { console.log(`[providerAccount] provider-enforce (${reason}) skipped — no active season`); return; }
  console.log(`[providerAccount] running provider-enforce (${reason})`);
  startProviderEnforce(orgId, seasonId);
}

// Called once at boot (src/index.js) — sets up the standing 15-minute sweep
// plus an initial run shortly after startup so a deploy heals any drift
// that built up while the server was down. No admin click ever required.
export function startProviderEnforceScheduler(orgId) {
  setTimeout(() => kickEnforce(orgId, 'boot'), 45 * 1000);
  setInterval(() => kickEnforce(orgId, 'interval'), 15 * 60 * 1000);
}

let pendingRetryTimer = null;
// Called from any catch block that logs a disccardpromos write failure
// (approve routes, mass-approve, lockApplicantCards, ...) — coalesces
// multiple near-simultaneous failures into one retry run ~1 minute later,
// rather than scheduling a pile of redundant enforce runs.
export function scheduleProviderEnforceSoon(orgId, reason) {
  if (pendingRetryTimer) return;
  pendingRetryTimer = setTimeout(() => { pendingRetryTimer = null; kickEnforce(orgId, `retry: ${reason}`); }, 60 * 1000);
}
