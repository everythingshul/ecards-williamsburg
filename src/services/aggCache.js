// Short-lived cache for the heavy, whole-table aggregates the dashboards and
// totals pages compute (net spend over every card transaction, per store, per
// shul, per applicant). Each of those is a full scan of card_transactions —
// 150-500 ms at production size — and a single page load used to run several
// of them, on the one thread that serves every other request too.
//
// Entries live for TTL_MS and are dropped at once by invalidateAggregates(),
// which the places that change charges, cards, store links or merges call
// (the sync sweep, manual syncs, merges, deletes, store linking). Anything
// that forgets to is still bounded by the TTL, which is far shorter than the
// 60s sync cadence that is the only thing that normally changes these numbers.
const TTL_MS = 20 * 1000;
const store = new Map();

export function memo(key, fn, ttlMs = TTL_MS) {
  const now = Date.now();
  const hit = store.get(key);
  if (hit && now - hit.at < ttlMs) return hit.value;
  const value = fn();
  store.set(key, { value, at: now });
  return value;
}

export function invalidateAggregates() { store.clear(); }
