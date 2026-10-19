import { db } from '../db.js';

// Match of a transaction's raw store name text (as reported by
// disccardpromos — services/cardSync.js's `vendor`) to a known participating
// store, so spend can be aggregated per store live. Falls back to null —
// the transaction still shows up in the ledger by name, just isn't linked
// to a store record yet.
//
// An explicit link (routes/stores.js's provider-links endpoints, set from a
// store's own profile) always wins when one exists — that's the whole point
// of letting an admin link "Amazon.com" the disccardpromos vendor name to
// "Amazon" the store record here even though the names don't match at all.
// Only when NO explicit link exists for this exact vendor name does this
// fall back to the old best-effort name matching, so an org that hasn't
// linked anything yet keeps behaving as before.
//
// PERFORMANCE: a sweep resolves this for every charge it sees (tens of
// thousands), almost always the same few hundred vendor names. The statements
// are prepared once and each answer is remembered for 30 seconds (and dropped
// at once by clearStoreMatchCache(), called whenever a link or store changes),
// instead of three fresh prepare()+query round trips per charge.
let stmts = null;
const memo = new Map();
let memoAt = 0;
const MEMO_MS = 30 * 1000;
export function clearStoreMatchCache() { memo.clear(); memoAt = Date.now(); }
export function resolveStoreId(orgId, storeName) {
  if (!storeName) return null;
  const now = Date.now();
  if (now - memoAt > MEMO_MS) { memo.clear(); memoAt = now; }
  const key = `${orgId}\u0000${storeName}`;
  if (memo.has(key)) return memo.get(key);
  stmts ||= {
    linked: db.prepare('SELECT store_id FROM store_provider_links WHERE org_id = ? AND vendor_name = ?'),
    exact: db.prepare('SELECT id FROM stores WHERE org_id = ? AND LOWER(name) = LOWER(?)'),
    partial: db.prepare('SELECT id FROM stores WHERE org_id = ? AND LOWER(name) LIKE LOWER(?)'),
  };
  const found = stmts.linked.get(orgId, storeName)?.store_id
    || stmts.exact.get(orgId, storeName)?.id
    || stmts.partial.get(orgId, `%${storeName}%`)?.id
    || null;
  memo.set(key, found);
  return found;
}
