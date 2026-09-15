import { db } from '../db.js';

// An applicant merged into a group (see services/duplicates.js's
// mergeApplicants) shares exactly one real disccardpromos account with
// every other member of that group — so "this applicant's balance" is
// really "the merge group's balance," the same number on every member's
// record, not something split up per row. A never-merged applicant is
// simply a group of one. Admin-only concept: never called for a shul-portal
// viewer, who must only ever see their own shul's own applicant row.
//
// "Loaded" is the real ledger of everything actually sent to disccardpromos
// for this person — every member's own approval-time card_amount (each
// member can genuinely be funded now; see routes/applicants.js's
// fundingAnchor) plus every shul_allocations row given since (summed
// unconditionally, so a reversal row — always equal-and-opposite, see
// services/matching.js's reverseAllocation — nets correctly against the
// allocation it reverses, partial or full). This is deliberately NOT
// SUM(cards.amount): assigning a physical card is a separate manual step
// from approval/funding (see routes/cards.js), so an approved-and-funded
// applicant with no physical card yet would otherwise show as $0 loaded
// even though real money already moved.
//
// Returns a Map from applicant id -> { loaded, spent, remaining }, covering
// every id in `applicantIds` plus every OTHER member of any merge group any
// of them belong to — so a caller that only asked about one shul's copy of
// a merged person still gets the real combined balance, not just whatever
// happens to be attached to that one row.
//
// FIXED (2026-09) — `remaining` used to be derived as loaded minus spend
// summed from card_transactions, which depends on disccardpromos' real
// transactions-array field name — never confirmed, so that sum silently
// stayed at 0 and "remaining" ran ahead of reality by however much had
// actually been spent. This was the real cause behind both blank $0.00
// dashboard totals (Total Spent has the identical formula) and recurring
// balance-mismatch emails (this exact "expected" figure is what got
// compared against disccard's real balance). Every card's package
// `amount` IS reliably readable, confirmed and already used elsewhere
// (services/cardSync.js keeps cards.amount fresh from it every sync) — now
// persisted per applicant as disccard_balance and used here directly as
// `remaining` whenever a sync has actually populated it, with `spent`
// BACK-COMPUTED as loaded minus that real balance instead of forward-summed
// from individual transactions. Falls back to the old transaction-summed
// computation only for an applicant who has never synced yet (disccard_balance
// still null — e.g. mock mode, or brand new) so nothing regresses before the
// first real sync runs.
export function getApplicantBalances(orgId, applicantIds) {
  const result = new Map();
  if (!applicantIds.length) return result;
  const cols = 'id, merge_group_id, approval_status, card_amount, disccard_balance, disccard_balance_synced_at';
  const rows = db.prepare(`SELECT ${cols} FROM applicants WHERE org_id = ? AND id IN (${applicantIds.map(() => '?').join(',')})`).all(orgId, ...applicantIds);
  if (!rows.length) return result;

  // Group key: an applicant's merge_group_id if it has one, else its own id
  // (a group of one). idsByGroup accumulates every member id under that key;
  // applicantById accumulates every member's own row (card_amount/status),
  // pulling in members not in the original request too.
  const idsByGroup = new Map();
  const applicantById = new Map(rows.map(r => [r.id, r]));
  for (const r of rows) {
    const key = r.merge_group_id || r.id;
    if (!idsByGroup.has(key)) idsByGroup.set(key, new Set());
    idsByGroup.get(key).add(r.id);
  }
  const trueGroupKeys = [...new Set(rows.filter(r => r.merge_group_id).map(r => r.merge_group_id))];
  if (trueGroupKeys.length) {
    const memberRows = db.prepare(`SELECT ${cols} FROM applicants WHERE org_id = ? AND merge_group_id IN (${trueGroupKeys.map(() => '?').join(',')})`).all(orgId, ...trueGroupKeys);
    for (const r of memberRows) {
      idsByGroup.get(r.merge_group_id)?.add(r.id);
      applicantById.set(r.id, r);
    }
  }

  const allMemberIds = [...new Set([...idsByGroup.values()].flatMap(s => [...s]))];
  const placeholders = allMemberIds.map(() => '?').join(',');
  // Every allocation ever given to any member (base + match together, same
  // "one combined card top-up" shape addFunds actually pushes) — reversals
  // are separate, equal-and-opposite rows, so this unconditional SUM already
  // nets a full or partial reversal to the right remainder.
  const allocatedRows = db.prepare(`SELECT applicant_id, COALESCE(SUM(total_amount),0) t FROM shul_allocations WHERE applicant_id IN (${placeholders}) GROUP BY applicant_id`).all(...allMemberIds);
  const allocatedById = new Map(allocatedRows.map(r => [r.applicant_id, r.t]));
  // Only used as a fallback for a group with no real disccard_balance synced
  // yet — see the function comment above. Same negative-amount-is-a-purchase
  // convention as cards.js's /by-shul.
  const spentRows = db.prepare(`SELECT c.applicant_id, COALESCE(SUM(CASE WHEN t.amount < 0 THEN -t.amount ELSE 0 END),0) spent
    FROM card_transactions t JOIN cards c ON c.id = t.card_id WHERE c.applicant_id IN (${placeholders}) GROUP BY c.applicant_id`).all(...allMemberIds);
  const spentById = new Map(spentRows.map(r => [r.applicant_id, r.spent]));

  for (const idSet of idsByGroup.values()) {
    let loaded = 0, transactionSpent = 0;
    // A merge group's real disccard balance is only ever synced onto
    // whichever member's own external_id disccard actually knows the
    // shared account under (in practice the PRIMARY — see
    // services/cardSync.js's syncApplicantCards) — pick the most recently
    // synced non-null reading across the whole group rather than assuming
    // it's any one specific member.
    let realBalance = null, realBalanceSyncedAt = null;
    for (const id of idSet) {
      const a = applicantById.get(id);
      if (a?.approval_status === 'approved') loaded += a.card_amount || 0;
      loaded += allocatedById.get(id) || 0;
      transactionSpent += spentById.get(id) || 0;
      if (a?.disccard_balance != null && (realBalanceSyncedAt == null || a.disccard_balance_synced_at > realBalanceSyncedAt)) {
        realBalance = a.disccard_balance;
        realBalanceSyncedAt = a.disccard_balance_synced_at;
      }
    }
    loaded = Math.round(loaded * 100) / 100;
    const rounded = realBalance != null
      ? { loaded, spent: Math.round(Math.max(0, loaded - realBalance) * 100) / 100, remaining: Math.round(realBalance * 100) / 100 }
      : { loaded, spent: Math.round(transactionSpent * 100) / 100, remaining: Math.round((loaded - transactionSpent) * 100) / 100 };
    for (const id of idSet) result.set(id, rounded);
  }
  return result;
}

// Org-wide (optionally season-scoped) funds summary for routes/dashboard.js
// and routes/donorDashboard.js — approvedFunds is a plain SUM of every
// approved applicant's own card_amount (each one a genuine distinct
// contribution, even within a merge group — see routes/applicants.js's
// fundingAnchor), but totalSpent has to go through getApplicantBalances and
// dedupe by merge group, or a merged group's shared real balance (see that
// function's own comment) would get counted once per member instead of once
// per real disccardpromos account.
export function orgFundsSummary(orgId, seasonId) {
  const seasonClause = seasonId ? ' AND season_id = ?' : '';
  const seasonParams = seasonId ? [seasonId] : [];
  const approved = db.prepare(`SELECT id, merge_group_id, card_amount FROM applicants WHERE org_id = ? AND approval_status = 'approved'${seasonClause}`).all(orgId, ...seasonParams);
  const approvedFunds = Math.round(approved.reduce((s, a) => s + (a.card_amount || 0), 0) * 100) / 100;
  if (!approved.length) return { approvedFunds, totalSpent: 0 };
  const balances = getApplicantBalances(orgId, approved.map(a => a.id));
  const seenGroups = new Set();
  let totalSpent = 0;
  for (const a of approved) {
    const groupKey = a.merge_group_id || a.id;
    if (seenGroups.has(groupKey)) continue;
    seenGroups.add(groupKey);
    totalSpent += balances.get(a.id)?.spent || 0;
  }
  return { approvedFunds, totalSpent: Math.round(totalSpent * 100) / 100 };
}
