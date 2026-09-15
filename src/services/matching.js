import { db, uuid } from '../db.js';
import * as giftcard from './giftcard.js';
import { approvedBalance } from './shulBalance.js';
import { logAudit } from './audit.js';
import { resolveFundingAnchor, scheduleProviderEnforceSoon } from './providerAccount.js';
import { getApplicantBalances } from './applicantBalance.js';

// Most-specific-wins, consistent with every other override chain in this
// app (min_contribution, required-field overrides, ...): an applicant's own
// override beats the shul's, which beats the season default. A null at any
// tier means "not set here", not zero — it falls through to the next tier.
function resolveRate(applicant, shul, season) {
  return applicant.match_rate_override ?? shul.match_rate_override ?? season.match_rate ?? 0;
}

// The per-applicant cap is the only tier an applicant-level override can
// touch; the per-shul and season-total caps are separate, independent
// ceilings (see db.js's schema comment) and are never applicant-specific.
function resolveApplicantCap(applicant, season) {
  return applicant.match_cap_override ?? season.match_cap_per_applicant ?? null;
}
function resolveShulCap(shul, season) {
  return shul.match_cap_override ?? season.match_cap_per_shul ?? null;
}

// Unconditional SUM, same reasoning as shulBalance.js's approvedBalance —
// a reversal is a second row with a negative match_amount, and filtering
// out the (now-reversed) original while keeping the reversal row would
// double-apply the reversal instead of letting the two net to zero.
function usedMatch(column, id) {
  return db.prepare(`SELECT COALESCE(SUM(match_amount),0) t FROM shul_allocations WHERE ${column} = ?`).get(id).t;
}

// The per-applicant cap means "how much match ONE PERSON can receive" — a
// merged applicant (see services/duplicates.js's mergeApplicants) is
// literally one person split across however many shuls' own rows, so their
// cap usage has to be summed across every member's applicant_id, not just
// whichever row this particular allocation happens to be against. Without
// this, each shul's own copy of the same person would track match usage
// completely independently, letting a per-applicant cap of (say) $100 be
// consumed twice — once per row — for what disccardpromos only ever sees as
// one real account. A non-merged applicant is just a group of one, so this
// is a strict superset of the old per-row behavior, never a narrower one.
function usedMatchForApplicant(applicant) {
  const groupId = applicant.merge_group_id || applicant.id;
  const memberIds = db.prepare('SELECT id FROM applicants WHERE id = ? OR merge_group_id = ?').all(groupId, groupId).map(r => r.id);
  const placeholders = memberIds.map(() => '?').join(',');
  return db.prepare(`SELECT COALESCE(SUM(match_amount),0) t FROM shul_allocations WHERE applicant_id IN (${placeholders})`).get(...memberIds).t;
}

// The REAL match a new allocation actually earns — order-dependent against
// however much room is left in each applicable cap right now (whichever
// shul got there first keeps what they already consumed; a later
// contribution just gets clipped to what's left, possibly zero). All three
// tiers apply at once: real match = min(natural match, room left per-
// applicant, room left per-shul, room left for the season), floored at 0.
export function computeRealMatch({ applicant, shul, season, baseAmount }) {
  const rate = resolveRate(applicant, shul, season);
  let room = baseAmount * rate;

  const applicantCap = resolveApplicantCap(applicant, season);
  if (applicantCap != null) room = Math.min(room, Math.max(0, applicantCap - usedMatchForApplicant(applicant)));

  const shulCap = resolveShulCap(shul, season);
  if (shulCap != null) room = Math.min(room, Math.max(0, shulCap - usedMatch('shul_id', shul.id)));

  if (season.match_cap_total != null) room = Math.min(room, Math.max(0, season.match_cap_total - usedMatch('season_id', season.id)));

  return { rate, matchAmount: Math.round(Math.max(0, room) * 100) / 100 };
}

// What THIS shul sees for THEIR OWN contribution to this applicant — a
// deliberately self-centered "if I were the only one giving" figure, not a
// share of the real total: it never reveals that another shul is involved
// at all, or how much that other shul gave. It's still never allowed to
// OVERSTATE reality, though — capped at whatever room is actually left in
// the per-applicant cap right now (excluding this shul's own already-
// counted usage, via ownMatchAmount), so a shul can believe it received
// the full natural match up to the real limit, but never more than the
// real limit actually allows. Only the per-applicant cap applies here, not
// the shul/season caps — those are operational budget limits, not
// something tied to this one applicant a shul should have to reason about
// in their own view.
export function shulDisplayMatch({ applicant, shul, season, baseAmount, ownMatchAmount = 0 }) {
  const rate = resolveRate(applicant, shul, season);
  const natural = baseAmount * rate;
  const applicantCap = resolveApplicantCap(applicant, season);
  if (applicantCap == null) return Math.round(Math.max(0, natural) * 100) / 100;
  const usedByOthers = Math.max(0, usedMatchForApplicant(applicant) - ownMatchAmount);
  const room = Math.max(0, applicantCap - usedByOthers);
  return Math.round(Math.max(0, Math.min(natural, room)) * 100) / 100;
}

// Every allocation the season/shul/applicant chain would let happen, given
// as ONE combined card top-up (base + match together) — disccardpromos only
// ever sees one number, same as a normal card load at approval time.
// Throws with a user-facing message on any validation failure; never
// partially writes (the DB insert only happens once every check passes).
export async function createAllocation({ orgId, userId, shulId, applicantId, baseAmount, createdBy, isAdminOverride, ip }) {
  if (!(baseAmount > 0)) throw new Error('Amount must be greater than $0');
  const shul = db.prepare('SELECT * FROM shuls WHERE id = ? AND org_id = ?').get(shulId, orgId);
  if (!shul) throw new Error('Shul not found');
  const applicant = db.prepare('SELECT * FROM applicants WHERE id = ? AND org_id = ?').get(applicantId, orgId);
  if (!applicant) throw new Error('Applicant not found');
  if (applicant.approval_status !== 'approved') throw new Error('This applicant has not been approved yet — funds can only be allocated to an approved applicant with an active card.');
  if (applicant.provider_exempt) throw new Error('This applicant is exempt from gift card provisioning and cannot receive an allocation.');
  if (!applicant.provider_account_id) throw new Error('This applicant has no disccardpromos account on file yet — funds cannot be loaded.');
  if (!isAdminOverride && applicant.shul_id !== shulId) throw new Error('This applicant does not belong to your shul.');

  const balance = approvedBalance(shulId);
  if (baseAmount > balance + 1e-9) throw new Error(`Amount ($${baseAmount.toFixed(2)}) exceeds this shul's approved balance ($${balance.toFixed(2)}).`);

  const season = db.prepare('SELECT * FROM seasons WHERE id = ?').get(applicant.season_id);
  const { rate, matchAmount } = computeRealMatch({ applicant, shul, season, baseAmount });
  const totalAmount = Math.round((baseAmount + matchAmount) * 100) / 100;

  // A merge-group secondary (see services/duplicates.js's mergeApplicants
  // and routes/applicants.js's isMergedSecondary) shares one real
  // disccardpromos customer with the rest of its group, but that customer
  // is only ever known to disccard under the group's PRIMARY member's
  // identity — addFunds under a secondary's own external_id/account would
  // either fail (no such customer) or create a second, duplicate one. This
  // shul's real base_amount still gets pushed in full either way; only
  // WHICH identity the write targets changes. See services/providerAccount.js's
  // resolveFundingAnchor for why this must never trust a secondary's own
  // (possibly stale, pre-merge) provider_account_id.
  const fundingAnchor = resolveFundingAnchor(applicant);

  // FIXED (2026-09) — real lost-update race, not just the live-disccard-read
  // one already fixed earlier: this row used to get INSERTed only AFTER the
  // `await` on the disccardpromos write below. Node only switches to another
  // request at an `await`, so two near-simultaneous "give $1000" calls for
  // the SAME applicant (two shuls, or the same shul double-submitting) could
  // both run their cap/match computation (computeRealMatch above, which
  // reads usedMatchForApplicant/usedMatch — a synchronous DB query) BEFORE
  // either one's row existed yet — each one seeing $0 of the cap as already
  // used, so a cap meant to stop after the first $1000 of match let a SECOND
  // contribution slip through as if the cap were untouched. Worse, each
  // call's disccardpromos write computed its own "new total" from the
  // ledger at ITS OWN read time (also pre-insert), so whichever write's
  // network round trip happened to land LAST silently overwrote the other's
  // contribution with a total that never included it — the real cause of a
  // reported "$3000 should be on the card, disccard only shows $2000."
  //
  // The row is now inserted synchronously, immediately after computing the
  // match — with NO await in between — so a concurrent call for the same
  // applicant can only ever see this one's cap usage as either fully
  // present or not started, never half-applied. The disccardpromos write
  // below reads the ledger AFTER this row is already in it, so `newTotal`
  // is simply the applicant's current remaining total (already includes
  // this allocation) rather than a separately-added figure — removing the
  // add-after-read step that was the other half of the race.
  const id = uuid();
  db.prepare(`INSERT INTO shul_allocations (id, org_id, shul_id, applicant_id, season_id, base_amount, match_amount, total_amount, match_rate_used, is_admin_override, created_by, giftcard_status, giftcard_error)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, orgId, shulId, applicantId, applicant.season_id, baseAmount, matchAmount, totalAmount, rate, isAdminOverride ? 1 : 0, createdBy, 'pending', null);

  const discountId = db.prepare(`SELECT value FROM settings WHERE org_id = ? AND key = 'disccardpromos_discount_id'`).get(orgId)?.value;
  let giftcardStatus = 'ok', giftcardError = null;
  if (!discountId) {
    giftcardStatus = 'failed';
    giftcardError = 'No disccardpromos Package/Discount ID configured (Settings > Organization > Gift Card Loading).';
  } else if (!fundingAnchor.provider_account_id) {
    giftcardStatus = 'failed';
    giftcardError = 'This applicant has no disccardpromos account on file yet — funds cannot be loaded.';
  } else {
    // Confirmed (2026-09-15, see giftcard.js's addFunds) POST /v1/add-funds/
    // credits a package by an INCREMENTAL amount — this allocation's own
    // combined base+match (`totalAmount`) is exactly the right delta to
    // send, no ledger read needed: the endpoint itself does the add
    // atomically on disccardpromos' own side, so two near-simultaneous
    // contributions for the same applicant can never race each other out
    // the way a read-then-compute-absolute-total approach could.
    console.log(`[matching] createAllocation applicant=${applicant.id} fundingAnchor=${fundingAnchor.provider_account_id} thisGive=$${totalAmount}`);
    try {
      await giftcard.addFunds(applicant.season_id, { customerId: fundingAnchor.provider_account_id, discountId, amount: totalAmount });
    } catch (e) {
      giftcardStatus = 'failed';
      giftcardError = e.message;
    }
  }
  if (giftcardStatus !== 'ok') {
    db.prepare('UPDATE shul_allocations SET giftcard_status = ?, giftcard_error = ? WHERE id = ?').run(giftcardStatus, giftcardError, id);
  } else {
    db.prepare('UPDATE shul_allocations SET giftcard_status = ? WHERE id = ?').run('ok', id);
  }

  const row = db.prepare('SELECT * FROM shul_allocations WHERE id = ?').get(id);
  logAudit(orgId, userId, 'create', 'shul_allocation', id, null, row, ip);
  return row;
}

// Reverses an allocation as an equal-and-opposite entry (never a delete —
// same reasoning as every other money record in this app). A fungible
// balance can't prove which specific dollars are still sitting there, so
// "how much is left on the card right now" is the only check that's
// actually possible — but unlike before, a lower balance no longer blocks
// the whole reversal: it pulls back whatever's still retrievable (up to the
// full original amount) and WRITES OFF the rest — the shul's balance is
// only restored for the portion actually retrieved, never for money the
// applicant already spent, since that's real money that's genuinely gone.
// The shortfall (if any) is returned so the caller can warn about it.
export async function reverseAllocation({ orgId, userId, allocationId, ip }) {
  const original = db.prepare('SELECT * FROM shul_allocations WHERE id = ? AND org_id = ?').get(allocationId, orgId);
  if (!original) throw new Error('Allocation not found');
  if (original.reversed_at) throw new Error('This allocation has already been reversed');

  const applicant = db.prepare('SELECT * FROM applicants WHERE id = ?').get(original.applicant_id);
  // Same merge-group anchor reasoning as createAllocation above — the
  // shared customer is only ever known to disccard under the group's
  // PRIMARY member's identity.
  const fundingAnchor = applicant ? resolveFundingAnchor(applicant) : null;
  const fundingExternalId = fundingAnchor?.external_id;
  const discountId = db.prepare(`SELECT value FROM settings WHERE org_id = ? AND key = 'disccardpromos_discount_id'`).get(orgId)?.value;
  // getCustomerByExternalId (not getCardBalance, which needs a real 16-digit
  // card number this app never retains — see cards.card_number_masked's own
  // "last 4 only, ever displayed" comment) is the one already live-tested
  // against the real API elsewhere in this file.
  //
  // FIXED (2026-09) — real root cause of "Undo Payment left the money on the
  // card": a failed live-balance read here used to silently fall back to
  // `retrievable = original.total_amount` (assume NOTHING was spent yet),
  // which then computed a disccardpromos write as if the full original
  // amount could be pulled back — when actually the read just failed and
  // the true spent amount was unknown. Retries a few times (network
  // hiccups/rate limits are usually transient); if every attempt still
  // fails, this now REFUSES the whole undo rather than guessing — an admin
  // can retry the undo once disccardpromos is reachable again, instead of
  // silently reversing this shul's balance/ledger for money that may
  // already be spent and unretrievable.
  //
  // FIXED (2026-09-15) — a SECOND, separate root cause of "the shul didn't
  // get their money back": when THIS allocation's own original write to
  // disccardpromos already failed (giftcard_status='failed' — see
  // addFunds/setPackageAmountAbsolute's header comments for the
  // wrong-endpoint bug this used to hit), the applicant's live balance
  // reflects every OTHER contribution ever made to them EXCEPT this one —
  // comparing it against original.total_amount below and writing off
  // whatever "shortfall" that comparison found was punishing the shul for
  // this app's own past sync bug, not real spending: the money never
  // reached the card, so there was nothing for the applicant to have
  // spent, and the full amount belongs back in the shul's balance. Skip the
  // live-balance check entirely in that case — the full amount is always
  // "retrievable" (nothing to claw back FROM the card, since the card
  // never had it) and the shul's balance is restored in full.
  const neverLoaded = original.giftcard_status === 'failed';
  let retrievable = original.total_amount, shortfall = 0;
  if (!neverLoaded && fundingExternalId && discountId) {
    let customer = null, lastError = null;
    for (let attempt = 1; attempt <= 3 && !customer; attempt++) {
      try {
        customer = await giftcard.getCustomerByExternalId(original.season_id, fundingExternalId, { balances: true });
      } catch (e) {
        lastError = e;
        console.error(`[matching] reverseAllocation balance check attempt ${attempt}/3 failed for allocation ${original.id}:`, e.message);
      }
    }
    if (!customer) {
      throw new Error(`Couldn't confirm how much of this is still on the card after ${lastError ? '3 attempts' : 'checking'} — disccardpromos didn't respond${lastError ? ` (${lastError.message})` : ''}. Undo was NOT performed, so nothing was changed here or on the card. Try again once disccardpromos is reachable.`);
    }
    const pkg = customer.packages?.find(p => String(p.id) === String(discountId));
    const currentBalance = pkg ? Number(pkg.amount) : null;
    if (currentBalance == null) {
      throw new Error("Couldn't read this applicant's real balance from disccardpromos (no matching package on their account) — Undo was NOT performed, so nothing was changed here or on the card.");
    }
    if (currentBalance < original.total_amount - 1e-9) {
      retrievable = Math.max(0, Math.round(currentBalance * 100) / 100);
      shortfall = Math.round((original.total_amount - retrievable) * 100) / 100;
    }
  }

  // Split the retrievable amount between base/match in the same proportion
  // as the original allocation, so a partial reversal claws back match-cap
  // room (see usedMatch() above) in proportion to what was actually pulled
  // back, rather than over- or under-crediting either bucket.
  const matchRatio = original.total_amount > 0 ? original.match_amount / original.total_amount : 0;
  const reversalMatch = Math.round(retrievable * matchRatio * 100) / 100;
  const reversalBase = Math.round((retrievable - reversalMatch) * 100) / 100;

  // FIXED (2026-09) — same lost-update race as createAllocation above (see
  // its comment for the full mechanism): this row used to get INSERTed only
  // AFTER the disccardpromos write's `await`, so a concurrent allocation or
  // reversal for the same applicant could read the ledger before this
  // reversal's credit was applied and compute its own disccard write from a
  // stale total, which could then land AFTER this one's and silently wipe
  // out this reversal. Inserted synchronously here, right after computing
  // the split above and BEFORE the write, so any concurrent request's own
  // ledger read either fully includes this reversal or hasn't started yet
  // — never half-applied.
  const id = uuid();
  db.prepare(`INSERT INTO shul_allocations (id, org_id, shul_id, applicant_id, season_id, base_amount, match_amount, total_amount, match_rate_used, is_admin_override, created_by, giftcard_status, giftcard_error, reversal_of)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, orgId, original.shul_id, original.applicant_id, original.season_id, -reversalBase, -reversalMatch, -retrievable, original.match_rate_used, original.is_admin_override, userId, 'pending', null, original.id);
  db.prepare('UPDATE shul_allocations SET reversed_at = datetime(\'now\'), reversed_by = ? WHERE id = ?').run(userId, original.id);

  // giftcardStatus/giftcardError, not a bare try/throw — CRITICAL: unlike
  // the old version of this function, a disccardpromos failure here must
  // NEVER abort the reversal. The local ledger (this shul's restored
  // balance, the applicant's reduced "Loaded" figure) is the real,
  // money-relevant state and has to update regardless of whether the
  // external write succeeded — same best-effort pattern createAllocation
  // and every approval route already use. Previously this call had no
  // try/catch at all: a disccardpromos error (a timeout, a rate limit,
  // anything) threw straight out of this function, so the code below that
  // inserts the reversal row and marks the original reversed_at was never
  // reached — the shul's money never came back and the applicant's card
  // balance never dropped on either side, even though the admin had just
  // clicked "Undo." That silent, all-or-nothing failure was the actual bug
  // behind "Undo Payment doesn't remove the money."
  let giftcardStatus = 'ok', giftcardError = null;
  if (discountId && retrievable > 0 && fundingAnchor?.provider_account_id) {
    // Ledger read AFTER this reversal's own row is already committed above
    // — `remaining` already has this reversal's credit-back applied, so
    // it's sent to disccardpromos as-is (no separate subtraction here,
    // removing the other half of the race).
    const existing = getApplicantBalances(orgId, [applicant.id]).get(applicant.id) || { remaining: 0 };
    const newTotal = Math.max(0, existing.remaining);
    // Diagnostic — see giftcard.js's setPackageAmountAbsolute for the
    // matching log on the actual write.
    console.log(`[matching] reverseAllocation original=${original.id} applicant=${applicant.id} fundingAnchor=${fundingAnchor.provider_account_id} retrievable=$${retrievable} shortfall=$${shortfall} -> newTotal (ledger, already includes this reversal)=$${newTotal}`);
    try {
      await giftcard.setPackageAmountAbsolute(original.season_id, { customerId: fundingAnchor.provider_account_id, externalId: fundingExternalId, totalAmount: newTotal });
    } catch (e) {
      giftcardStatus = 'failed';
      giftcardError = e.message;
      console.error('[matching] reverseAllocation disccardpromos write failed (local reversal still proceeds):', e.message);
      scheduleProviderEnforceSoon(orgId, `reversal fund-write failed for allocation ${original.id}`);
    }
  } else {
    giftcardStatus = discountId ? 'ok' : 'failed';
    giftcardError = discountId ? null : 'No disccardpromos Package/Discount ID configured (Settings > Organization > Gift Card Loading).';
    // Diagnostic: shows WHY the disccard write was skipped entirely — the
    // three most common reasons are no Package/Discount ID configured, this
    // applicant has no provider_account_id, or retrievable computed as $0
    // (the live balance check above found nothing left to claw back, so
    // this reversal is a pure write-off — see the shortfall handling above).
    console.log(`[matching] reverseAllocation original=${original.id} applicant=${applicant?.id} SKIPPED disccard write — discountId=${discountId || '(none)'} retrievable=$${retrievable} accountId=${fundingAnchor?.provider_account_id || '(none)'}`);
  }
  db.prepare('UPDATE shul_allocations SET giftcard_status = ?, giftcard_error = ? WHERE id = ?').run(giftcardStatus, giftcardError, id);

  const reversalRow = db.prepare('SELECT * FROM shul_allocations WHERE id = ?').get(id);
  // neverLoaded: this app's OWN record already shows the original give's
  // disccardpromos write failed at the time it was made — so a shortfall
  // here isn't the applicant having "already spent" the money, it's that
  // the money never reached the real card in the first place (see
  // giftcard.js's addFunds/setPackageAmountAbsolute header comments for the
  // wrong-endpoint bug this used to hit). The frontend uses this to tell
  // the truth instead of guessing "already spent" whenever the live
  // balance simply comes back lower than this app expected. (neverLoaded is
  // computed earlier in this function, right above the live-balance check
  // it's used to skip.)
  logAudit(orgId, userId, 'undo', 'shul_allocation', original.id, original, { ...reversalRow, shortfall }, ip);
  return { ...reversalRow, shortfall, neverLoaded };
}
