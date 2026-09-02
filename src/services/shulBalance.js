import { db } from '../db.js';

// A shul's balance is never a stored running total (see db.js's schema
// comment on shul_payments/shul_allocations) — always summed live from the
// two ledgers, so there's no cached number that can drift out of sync with
// what actually happened.

export function pendingBalance(shulId) {
  return db.prepare(`SELECT COALESCE(SUM(net_amount),0) t FROM shul_payments WHERE shul_id = ? AND status = 'pending_approval'`).get(shulId).t;
}

// Approved balance = every approved payment's net amount, minus whatever
// this shul has already given out of it. match_amount is deliberately never
// subtracted here — it isn't the shul's own money, so giving it away
// doesn't draw down their balance.
//
// Deliberately NOT filtered by "reversed_at IS NULL" — a reversal is a
// second row (negative base_amount, see services/matching.js's
// reverseAllocation), and once an original is marked reversed_at it would
// otherwise be excluded from this SUM while its offsetting reversal row
// stayed in, double-applying the reversal instead of netting the two rows
// to zero. Summing every row unconditionally is what actually makes an
// equal-and-opposite ledger entry cancel out correctly.
export function approvedBalance(shulId) {
  const paid = db.prepare(`SELECT COALESCE(SUM(net_amount),0) t FROM shul_payments WHERE shul_id = ? AND status = 'approved'`).get(shulId).t;
  const given = db.prepare(`SELECT COALESCE(SUM(base_amount),0) t FROM shul_allocations WHERE shul_id = ?`).get(shulId).t;
  return Math.round((paid - given) * 100) / 100;
}

export function shulBalances(shulId) {
  return { pending: pendingBalance(shulId), approved: approvedBalance(shulId) };
}
