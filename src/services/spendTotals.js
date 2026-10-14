import { db } from '../db.js';

// Net spend convention used everywhere in this app: a purchase is stored as a
// negative amount, a refund as a positive row with type='refund' — so net =
// purchases minus refunds, never a signed sum.
export const NET_SQL = `CASE WHEN type = 'refund' THEN -amount WHEN amount < 0 THEN -amount ELSE 0 END`;
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Unattributed rows have no card to hang a season off, so a season is applied
// as its start/end date window on the charge date.
function seasonWindow(seasonId) {
  if (!seasonId) return { sql: '', params: [] };
  const s = db.prepare('SELECT start_date, end_date FROM seasons WHERE id = ?').get(seasonId);
  let sql = ''; const params = [];
  if (s?.start_date) { sql += ' AND substr(occurred_at, 1, 10) >= ?'; params.push(String(s.start_date).slice(0, 10)); }
  if (s?.end_date) { sql += ' AND substr(occurred_at, 1, 10) <= ?'; params.push(String(s.end_date).slice(0, 10)); }
  return { sql, params };
}

// Net spend (and row count) from charges not tied to any card of ours.
// storeId narrows to one store; unmatchedOnly keeps only rows whose vendor
// never resolved to a store record.
export function unattributedNet(orgId, { seasonId, storeId, unmatchedOnly } = {}) {
  const w = seasonWindow(seasonId);
  let where = 'org_id = ?'; const params = [orgId];
  if (storeId) { where += ' AND store_id = ?'; params.push(storeId); }
  if (unmatchedOnly) where += ' AND store_id IS NULL';
  const r = db.prepare(`SELECT COALESCE(SUM(${NET_SQL}), 0) net, COUNT(*) count FROM unattributed_transactions WHERE ${where}${w.sql}`).get(...params, ...w.params);
  return { net: round2(r.net), count: r.count };
}

// { [storeId]: net } for every store that has unattributed charges.
export function unattributedByStore(orgId, seasonId) {
  const w = seasonWindow(seasonId);
  const rows = db.prepare(`SELECT store_id, COALESCE(SUM(${NET_SQL}), 0) net FROM unattributed_transactions
    WHERE org_id = ? AND store_id IS NOT NULL${w.sql} GROUP BY store_id`).all(orgId, ...w.params);
  return Object.fromEntries(rows.map(r => [r.store_id, round2(r.net)]));
}
