import { db } from '../db.js';

// Best-effort match of a transaction's raw store name text (as reported by
// disccardpromos) to a known participating store, so spend can be aggregated
// per store live. Falls back to null — the transaction still shows up in the
// ledger by name, just isn't linked to a store record yet. Add a store with
// a matching name and re-sync to pick it up retroactively.
export function resolveStoreId(orgId, storeName) {
  if (!storeName) return null;
  const exact = db.prepare('SELECT id FROM stores WHERE org_id = ? AND LOWER(name) = LOWER(?)').get(orgId, storeName);
  if (exact) return exact.id;
  const partial = db.prepare('SELECT id FROM stores WHERE org_id = ? AND LOWER(name) LIKE LOWER(?)').get(orgId, `%${storeName}%`);
  return partial?.id || null;
}
