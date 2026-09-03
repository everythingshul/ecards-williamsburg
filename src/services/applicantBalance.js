import { db } from '../db.js';

// An applicant merged into a group (see services/duplicates.js's
// mergeApplicants) shares exactly one real disccardpromos account/card with
// every other member of that group — so "this applicant's balance" is
// really "the merge group's balance," the same number on every member's
// record, not something split up per row. A never-merged applicant is
// simply a group of one. Admin-only concept: never called for a shul-portal
// viewer, who must only ever see their own shul's own applicant row.
//
// Returns a Map from applicant id -> { loaded, spent, remaining }, covering
// every id in `applicantIds` plus every OTHER member of any merge group any
// of them belong to — so a caller that only asked about one shul's copy of
// a merged person still gets the real combined balance, not just whatever
// happens to be attached to that one row's own applicant_id.
export function getApplicantBalances(orgId, applicantIds) {
  const result = new Map();
  if (!applicantIds.length) return result;
  const rows = db.prepare(`SELECT id, merge_group_id FROM applicants WHERE org_id = ? AND id IN (${applicantIds.map(() => '?').join(',')})`).all(orgId, ...applicantIds);
  if (!rows.length) return result;

  // Group key: an applicant's merge_group_id if it has one, else its own id
  // (a group of one). idsByGroup accumulates every member id under that key.
  const idsByGroup = new Map();
  for (const r of rows) {
    const key = r.merge_group_id || r.id;
    if (!idsByGroup.has(key)) idsByGroup.set(key, new Set());
    idsByGroup.get(key).add(r.id);
  }
  // Pull in any OTHER members of a real merge group (merge_group_id truthy)
  // that weren't part of the original requested id list, so the balance sums
  // every card the group actually has, not just the ones already in view.
  const trueGroupKeys = [...new Set(rows.filter(r => r.merge_group_id).map(r => r.merge_group_id))];
  if (trueGroupKeys.length) {
    const memberRows = db.prepare(`SELECT id, merge_group_id FROM applicants WHERE org_id = ? AND merge_group_id IN (${trueGroupKeys.map(() => '?').join(',')})`).all(orgId, ...trueGroupKeys);
    for (const r of memberRows) idsByGroup.get(r.merge_group_id)?.add(r.id);
  }

  const allMemberIds = [...new Set([...idsByGroup.values()].flatMap(s => [...s]))];
  const placeholders = allMemberIds.map(() => '?').join(',');
  const loadedRows = db.prepare(`SELECT applicant_id, COALESCE(SUM(amount),0) loaded FROM cards WHERE applicant_id IN (${placeholders}) GROUP BY applicant_id`).all(...allMemberIds);
  // Same negative-amount-is-a-purchase convention as cards.js's /by-shul.
  const spentRows = db.prepare(`SELECT c.applicant_id, COALESCE(SUM(CASE WHEN t.amount < 0 THEN -t.amount ELSE 0 END),0) spent
    FROM card_transactions t JOIN cards c ON c.id = t.card_id WHERE c.applicant_id IN (${placeholders}) GROUP BY c.applicant_id`).all(...allMemberIds);
  const loadedById = new Map(loadedRows.map(r => [r.applicant_id, r.loaded]));
  const spentById = new Map(spentRows.map(r => [r.applicant_id, r.spent]));

  for (const idSet of idsByGroup.values()) {
    let loaded = 0, spent = 0;
    for (const id of idSet) { loaded += loadedById.get(id) || 0; spent += spentById.get(id) || 0; }
    const rounded = { loaded: Math.round(loaded * 100) / 100, spent: Math.round(spent * 100) / 100, remaining: Math.round((loaded - spent) * 100) / 100 };
    for (const id of idSet) result.set(id, rounded);
  }
  return result;
}
