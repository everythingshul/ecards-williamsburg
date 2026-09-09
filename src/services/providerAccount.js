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

// null unless this applicant has actually been approved — a pending/draft/
// rejected applicant never has (or needs) a disccardpromos account, so
// "missing" would be meaningless noise for them. Both approve routes push a
// customer account on approval regardless of card_amount (amount only gates
// the separate fund-load) — so "approved but no account" always means a
// write that failed and was never retried, never an amount thing.
export function providerSyncStatus(a) {
  if (a.approval_status !== 'approved') return null;
  if (a.provider_exempt) return 'exempt';
  if (a.provider_account_id) return 'synced';
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
export async function ensureProviderAccount(orgId, applicant) {
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
  try {
    const result = await giftcard.upsertAccountForApproval(anchor.season_id, buildProviderOpts(orgId, anchor, shul?.name_en || 'Unknown'));
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
  const allCustomers = isMock ? [] : await giftcard.listAllCustomers(seasonId);
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
    checked: applicants.length, customersOnProvider: allCustomers.length, mockMode: isMock,
    active: active.length, inactive: inactive.length, notFound: notFound.length,
    activeIds: active, inactiveIds: inactive, notFoundIds: notFound, mockIds: mock,
    relinked, orphans,
  };
}

// ============================= "Make Disccardpromos Match" enforcement (item 8) =============================

const enforceJobs = new Map(); // orgId -> job state
export function getProviderEnforceJob(orgId) { return enforceJobs.get(orgId) || null; }

export function startProviderEnforce(orgId, seasonId) {
  const existing = enforceJobs.get(orgId);
  if (existing?.status === 'running') return existing;
  const job = { status: 'running', progress: 0, total: 0, result: null, error: null, startedAt: new Date().toISOString(), finishedAt: null };
  enforceJobs.set(orgId, job);
  runProviderEnforce(orgId, seasonId, job).then(result => {
    job.result = result; job.status = 'done'; job.finishedAt = new Date().toISOString();
  }).catch(e => {
    job.status = 'error'; job.error = e.message; job.finishedAt = new Date().toISOString();
  });
  return job;
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
export async function runProviderEnforce(orgId, seasonId, job = { progress: 0, total: 0 }) {
  const discountId = db.prepare(`SELECT value FROM settings WHERE org_id = ? AND key = 'disccardpromos_discount_id'`).get(orgId)?.value;
  const applicants = db.prepare(`SELECT * FROM applicants WHERE org_id = ? AND season_id = ?`).all(orgId, seasonId);
  const approved = applicants.filter(a => a.approval_status === 'approved' && !a.provider_exempt && a.shul_id);
  job.total = approved.length;

  const mismatches = [];
  const createdApplicantIds = new Set();
  for (const a of approved) {
    job.progress++;
    // Re-fetch — an earlier member of this same merge group processed
    // earlier in this same loop may have just given this row an account.
    const fresh = db.prepare('SELECT * FROM applicants WHERE id = ?').get(a.id);
    const result = await ensureProviderAccount(orgId, fresh);
    if (result.error) { mismatches.push({ applicantId: a.id, name: `${a.first_name} ${a.last_name}`.trim(), reason: result.error }); continue; }
    if (result.created) createdApplicantIds.add(a.id);
  }

  const fundsErrors = [];
  if (discountId) {
    for (const applicantId of createdApplicantIds) {
      const a = db.prepare('SELECT * FROM applicants WHERE id = ?').get(applicantId);
      if (!(a.card_amount > 0) || !a.provider_account_id) continue;
      // A newly-created account for a merge secondary is created under the
      // group's PRIMARY identity (see ensureProviderAccount's `anchor`
      // resolution above) — so the external_id on this PATCH must be the
      // primary's, not this member's own, or the just-correctly-set
      // external_id gets silently overwritten right back to the wrong value.
      const anchor = resolveFundingAnchor(a);
      // Absolute total from our own ledger (merge-group aware), never a
      // live-read-then-add — see giftcard.js's syncPackageAmount for why
      // (the lost-update race that was undercounting a second shul's
      // contribution). This is the first-ever fund load for a JUST-created
      // account, so the ledger's remaining figure already IS the correct
      // total to set (this applicant's own approved card_amount, plus
      // anything else already on file for the group).
      const ledger = getApplicantBalances(orgId, [a.id]).get(a.id) || { remaining: a.card_amount };
      try {
        await giftcard.syncPackageAmount(a.season_id, { customerId: a.provider_account_id, externalId: anchor.external_id, discountId, totalAmount: ledger.remaining });
      } catch (e) {
        fundsErrors.push({ applicantId: a.id, name: `${a.first_name} ${a.last_name}`.trim(), error: e.message });
      }
    }
  } else if (createdApplicantIds.size) {
    fundsErrors.push({ applicantId: null, name: null, error: 'No disccardpromos Package/Discount ID configured (Settings > Organization > Gift Card Loading) — new accounts were created but no funds were loaded onto them.' });
  }

  let deactivated = 0;
  const isMock = giftcard.isMockMode(seasonId);
  if (!isMock) {
    const allCustomers = await giftcard.listAllCustomers(seasonId);
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
