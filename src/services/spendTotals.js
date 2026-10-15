import { db } from '../db.js';
import { getActiveSeasonId } from '../utils/formSchedule.js';

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
  const r = db.prepare(`SELECT COALESCE(SUM(CASE WHEN t.type = 'refund' THEN -t.amount WHEN t.amount < 0 THEN -t.amount ELSE 0 END), 0) net
    FROM card_transactions t JOIN cards c ON c.id = t.card_id WHERE c.org_id = ?${seasonId ? ' AND c.season_id = ?' : ''}`).get(orgId, ...(seasonId ? [seasonId] : []));
  return round2(r.net);
}

// THE definition of "Total Spent": everything customers actually spent at
// stores (purchases minus refunds) = every card transaction + charges by
// disccardpromos customers not linked to any applicant. It must not be
// narrowed to approved applicants or adjusted for merges — an applicant who
// spent and was later rejected still spent that money, and disccardpromos'
// own total includes it. The Dashboard tile, its Live Store Spend panel and
// the Donor's Dash all read this, so they cannot disagree.
export function totalSpend(orgId, seasonId) {
  const attributed = attributedNet(orgId, seasonId);
  const unattributed = unattributedNet(orgId, { seasonId }).net;
  const ledger = round2(attributed + unattributed);
  // The headline figure IS disccardpromos' own number whenever a sync has
  // stored one (every customer's committed amount minus its live balance —
  // see cardSync.js's recordProviderSpend). The ledger above is what the
  // transaction feed gave us; anything the feed left out (a charge type it
  // doesn't list, an older customer, a pagination gap) shows up as
  // `difference`, so the two can never silently disagree again. The provider
  // figure carries no season, so it answers "all seasons" and the ACTIVE
  // season (where all current spend happens — the Dashboard's default view);
  // a past season still uses the ledger.
  const provider = !seasonId || seasonId === getActiveSeasonId(orgId) ? providerReportedSpend(orgId) : null;
  if (provider) return { attributed, unattributed, ledger, total: provider.total, source: 'disccardpromos', syncedAt: provider.syncedAt, customers: provider.customers, difference: round2(provider.total - ledger) };
  return { attributed, unattributed, ledger, total: ledger, source: 'ledger', syncedAt: null, customers: 0, difference: 0 };
}

// Sum of what disccardpromos reports as spent across every customer in the
// account, from the last successful sync; null until one has run.
export function providerReportedSpend(orgId) {
  const r = db.prepare(`SELECT COALESCE(SUM(spent), 0) total, COALESCE(SUM(loaded), 0) loaded, COUNT(*) customers, MAX(synced_at) synced_at FROM provider_spend_snapshot WHERE org_id = ?`).get(orgId);
  if (!r || !r.customers) return null;
  return { total: round2(r.total), loaded: round2(r.loaded), customers: r.customers, syncedAt: r.synced_at };
}
