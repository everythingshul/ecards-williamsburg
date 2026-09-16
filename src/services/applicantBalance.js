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
// `spent` is deliberately, strictly "money actually spent in stores" —
// summed from card_transactions, nothing else. A brief 2026-09 attempt to
// back-compute it as loaded-minus-disccard's-real-balance (so it wouldn't
// read $0 while the transactions sync was broken) was reverted per direct
// product direction: that conflated "spent in stores" with "any reason the
// real balance is lower than our ledger," which is a different, less
// trustworthy claim — this app doesn't assert a real transaction happened
// unless it actually captured one. Until disccardpromos' transactions-array
// field name is confirmed (see services/cardSync.js's diagnostic banner),
// `spent` correctly reads 0 rather than a guessed figure, and `remaining`
// is exactly `loaded - spent` — "how much of what was loaded hasn't been
// used in stores YET, as far as this app can currently confirm."
export function getApplicantBalances(orgId, applicantIds) {
  const result = new Map();
  if (!applicantIds.length) return result;
  const rows = db.prepare(`SELECT id, merge_group_id, approval_status, card_amount FROM applicants WHERE org_id = ? AND id IN (${applicantIds.map(() => '?').join(',')})`).all(orgId, ...applicantIds);
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
    const memberRows = db.prepare(`SELECT id, merge_group_id, approval_status, card_amount FROM applicants WHERE org_id = ? AND merge_group_id IN (${trueGroupKeys.map(() => '?').join(',')})`).all(orgId, ...trueGroupKeys);
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
  // Net of refunds — a purchase (stored negative) adds, a refund (stored
  // positive, type='refund') subtracts, a local 'load' row contributes 0.
  // The same expression is used at every spend site (cards.js, dashboard.js,
  // stores.js, donorDashboard.js) so the figures agree with each other and
  // with disccardpromos' own net seasonal number.
  const spentRows = db.prepare(`SELECT c.applicant_id, COALESCE(SUM(CASE WHEN t.type = 'refund' THEN -t.amount WHEN t.amount < 0 THEN -t.amount ELSE 0 END),0) spent
    FROM card_transactions t JOIN cards c ON c.id = t.card_id WHERE c.applicant_id IN (${placeholders}) GROUP BY c.applicant_id`).all(...allMemberIds);
  const spentById = new Map(spentRows.map(r => [r.applicant_id, r.spent]));

  for (const idSet of idsByGroup.values()) {
    let loaded = 0, spent = 0;
    for (const id of idSet) {
      const a = applicantById.get(id);
      if (a?.approval_status === 'approved') loaded += a.card_amount || 0;
      loaded += allocatedById.get(id) || 0;
      spent += spentById.get(id) || 0;
    }
    const rounded = { loaded: Math.round(loaded * 100) / 100, spent: Math.round(spent * 100) / 100, remaining: Math.round((loaded - spent) * 100) / 100 };
    for (const id of idSet) result.set(id, rounded);
  }
  return result;
}

// Org-wide (optionally season-scoped) funds summary for routes/dashboard.js
// and routes/donorDashboard.js.
//
// FIXED (2026-09) — approvedFunds ("Total Loaded") used to be a plain SUM
// of card_amount, which is only the approval-time BASE amount — it never
// included any match or any subsequent shul-portal "Give" top-up
// (shul_allocations), so it understated the real total on every card the
// moment matching or a second Give action happened. "Total Loaded" must be
// the total amount actually on the card AFTER matching — exactly what
// getApplicantBalances' own `loaded` already computes per applicant/merge
// group (card_amount + every shul_allocations row, base+match combined).
// This now sums THAT figure instead, deduped by merge group so a shared
// disccardpromos account isn't counted once per member (same reasoning as
// totalSpent below, which already worked this way).
export function orgFundsSummary(orgId, seasonId) {
  const seasonClause = seasonId ? ' AND season_id = ?' : '';
  const seasonParams = seasonId ? [seasonId] : [];
  const approved = db.prepare(`SELECT id, merge_group_id FROM applicants WHERE org_id = ? AND approval_status = 'approved'${seasonClause}`).all(orgId, ...seasonParams);
  if (!approved.length) return { approvedFunds: 0, totalSpent: 0 };
  const balances = getApplicantBalances(orgId, approved.map(a => a.id));
  const seenGroups = new Set();
  let approvedFunds = 0, totalSpent = 0;
  for (const a of approved) {
    const groupKey = a.merge_group_id || a.id;
    if (seenGroups.has(groupKey)) continue;
    seenGroups.add(groupKey);
    const b = balances.get(a.id);
    approvedFunds += b?.loaded || 0;
    totalSpent += b?.spent || 0;
  }
  return { approvedFunds: Math.round(approvedFunds * 100) / 100, totalSpent: Math.round(totalSpent * 100) / 100 };
}
