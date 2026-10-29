import { db } from '../db.js';
import { memo } from './aggCache.js';

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
// never resolved to a store record; noApplicant keeps only charges by
// disccardpromos customers not linked to any applicant.
export function unattributedNet(orgId, { seasonId, storeId, unmatchedOnly, noApplicant } = {}) {
  const w = seasonWindow(seasonId);
  let where = 'org_id = ?'; const params = [orgId];
  if (storeId) { where += ' AND store_id = ?'; params.push(storeId); }
  if (unmatchedOnly) where += ' AND store_id IS NULL';
  if (noApplicant) where += ' AND applicant_id IS NULL';
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

// Net spend of every real card transaction in scope — ANY applicant, whatever
// their approval status is now. A season is applied through the card the
// charge was made on, like every other store-spend query.
export function attributedNet(orgId, seasonId) {
  // whole-table scan: cached briefly (see aggCache.js)
  return memo(`attributedNet:${orgId}:${seasonId || ''}`, () => {
    const r = db.prepare(`SELECT COALESCE(SUM(CASE WHEN t.type = 'refund' THEN -t.amount WHEN t.amount < 0 THEN -t.amount ELSE 0 END), 0) net
      FROM card_transactions t JOIN cards c ON c.id = t.card_id WHERE c.org_id = ?${seasonId ? ' AND c.season_id = ?' : ''}`).get(orgId, ...(seasonId ? [seasonId] : []));
    return round2(r.net);
  });
}

// The last complete snapshot (see cardSync.js recordSpendSnapshot), or null. Two figures from the same
// complete pull: `spent` (sum of amount − balance per customer) and `listed_net` (net of every charge
// disccardpromos lists), so the admin can pick whichever matches disccardpromos' own headline.
export function getSpendSnapshot(orgId) {
  return db.prepare(`SELECT spent, listed_net, customers, unreadable, taken_at, (strftime('%s','now') - strftime('%s', taken_at)) AS age_seconds
    FROM provider_spend_total WHERE org_id = ?`).get(orgId) || null;
}

// Replace the snapshot whole (one statement — readers see the old or the new figure, never a mix).
export function saveSpendSnapshot(orgId, { spent, listedNet, customers, unreadable }) {
  db.prepare(`INSERT INTO provider_spend_total (org_id, spent, listed_net, customers, unreadable, taken_at) VALUES (?,?,?,?,?, datetime('now'))
    ON CONFLICT(org_id) DO UPDATE SET spent = excluded.spent, listed_net = excluded.listed_net, customers = excluded.customers, unreadable = excluded.unreadable, taken_at = excluded.taken_at`)
    .run(orgId, round2(spent), round2(listedNet), customers, unreadable);
}

// Why the last sweep did NOT produce a snapshot (null = it did; 'not attempted yet' until the first sweep after a
// restart). In memory only; shown on the Dashboard so nobody has to read server logs.
let snapshotStatus = 'not attempted yet (the first sync runs about a minute after the server starts)';
export const setSnapshotStatus = (reason) => { snapshotStatus = reason || null; };
export const getSnapshotStatus = () => snapshotStatus;

// A snapshot older than this is not trusted (the sync has been failing for hours): fall back to the ledger.
const SNAPSHOT_MAX_AGE_SECONDS = 6 * 3600;

// Settings > Organization > "Total Spent source": 'provider' (balances, default), 'listed' (net of the
// charges disccardpromos lists) or 'ledger' (what was synced into this app).
export const SPENT_SOURCES = ['provider', 'listed', 'ledger'];
function spentSource(orgId) {
  return memo(`spentSource:${orgId}`, () => {
    const v = db.prepare(`SELECT value FROM settings WHERE org_id = ? AND key = 'total_spent_source'`).get(orgId)?.value;
    return SPENT_SOURCES.includes(v) ? v : 'provider';
  }, 10000);
}

// THE definition of "Total Spent" = what customers actually spent at stores
// (purchases minus refunds). Three candidate figures are always computed so a screen can show them side
// by side (`candidates`); `total` is the one the admin chose (Settings > Total Spent source):
//   * provider — disccardpromos' balances: per customer loaded `amount` minus current package balance.
//   * listed   — the net of every charge disccardpromos lists in the same pull.
//   * ledger   — every card transaction synced here (any applicant, whatever their status now, no merge
//                adjustments) + charges by customers not linked to any applicant.
// provider/listed come from the last COMPLETE bulk pull (the snapshot) and exist only org-wide (no season
// filter) and while fresh; otherwise the ledger is used. `attributed`/`unattributed`/`ledger` are always the
// ledger parts. The Dashboard tile, its Live Store Spend panel and the Donor's Dash all read this.
export function totalSpend(orgId, seasonId) {
  const attributed = attributedNet(orgId, seasonId);
  const unattributed = unattributedNet(orgId, { seasonId }).net;
  const ledger = round2(attributed + unattributed);
  const candidates = { provider: null, listed: null, ledger };
  let asOf = null;
  if (!seasonId) {
    try {
      const snap = getSpendSnapshot(orgId);
      if (snap && snap.age_seconds <= SNAPSHOT_MAX_AGE_SECONDS) {
        candidates.provider = round2(snap.spent);
        candidates.listed = snap.listed_net == null ? null : round2(snap.listed_net);
        asOf = snap.taken_at;
      }
    } catch (e) {
      // never let the snapshot take a page down: fall back to the ledger
      console.error('[spendTotals] snapshot unreadable, using the transaction ledger:', e.message);
    }
  }
  let source = spentSource(orgId);
  if (candidates[source] == null) source = 'ledger';
  const total = candidates[source];
  return { attributed, unattributed, ledger, total, source, asOf, candidates, snapshotProblem: candidates.provider == null ? snapshotStatus : null, difference: round2(ledger - total) };
}
