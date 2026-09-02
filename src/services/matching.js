import { db, uuid } from '../db.js';
import * as giftcard from './giftcard.js';
import { approvedBalance } from './shulBalance.js';
import { logAudit } from './audit.js';

// Most-specific-wins, consistent with every other override chain in this
// app (min_contribution, required-field overrides, ...): an applicant's own
// override beats the shul's, which beats the season default. A null at any
// tier means "not set here", not zero — it falls through to the next tier.
function resolveRate(applicant, shul, season) {
  return applicant.match_rate_override ?? shul.match_rate_override ?? season.match_rate ?? 0;
}

// The per-applicant cap is the only tier an applicant-level override can
// touch; the per-shul and season-total caps are separate, independent
// ceilings (see db.js's schema comment) and are never applicant-specific.
function resolveApplicantCap(applicant, season) {
  return applicant.match_cap_override ?? season.match_cap_per_applicant ?? null;
}
function resolveShulCap(shul, season) {
  return shul.match_cap_override ?? season.match_cap_per_shul ?? null;
}

// Unconditional SUM, same reasoning as shulBalance.js's approvedBalance —
// a reversal is a second row with a negative match_amount, and filtering
// out the (now-reversed) original while keeping the reversal row would
// double-apply the reversal instead of letting the two net to zero.
function usedMatch(column, id) {
  return db.prepare(`SELECT COALESCE(SUM(match_amount),0) t FROM shul_allocations WHERE ${column} = ?`).get(id).t;
}

// The REAL match a new allocation actually earns — order-dependent against
// however much room is left in each applicable cap right now (whichever
// shul got there first keeps what they already consumed; a later
// contribution just gets clipped to what's left, possibly zero). All three
// tiers apply at once: real match = min(natural match, room left per-
// applicant, room left per-shul, room left for the season), floored at 0.
export function computeRealMatch({ applicant, shul, season, baseAmount }) {
  const rate = resolveRate(applicant, shul, season);
  let room = baseAmount * rate;

  const applicantCap = resolveApplicantCap(applicant, season);
  if (applicantCap != null) room = Math.min(room, Math.max(0, applicantCap - usedMatch('applicant_id', applicant.id)));

  const shulCap = resolveShulCap(shul, season);
  if (shulCap != null) room = Math.min(room, Math.max(0, shulCap - usedMatch('shul_id', shul.id)));

  if (season.match_cap_total != null) room = Math.min(room, Math.max(0, season.match_cap_total - usedMatch('season_id', season.id)));

  return { rate, matchAmount: Math.round(Math.max(0, room) * 100) / 100 };
}

// What THIS shul sees for THEIR OWN contribution to this applicant — a
// deliberately self-centered "if I were the only one giving" figure, not a
// share of the real total. Two shuls each giving $2000 to the same
// applicant, with a $500 total real match already fully consumed between
// them, each still see their own money + whatever their own contribution
// alone would have earned against the per-applicant cap — even though that
// can add up to more than the real match actually given (that's the point:
// a shul's own number never reveals whether another shul is involved at
// all). Only the per-applicant cap applies here, not the shul/season caps
// — those are operational budget limits, not something tied to this one
// applicant a shul should have to reason about in their own view.
export function shulDisplayMatch({ applicant, shul, season, baseAmount }) {
  const rate = resolveRate(applicant, shul, season);
  const natural = baseAmount * rate;
  const applicantCap = resolveApplicantCap(applicant, season);
  const capped = applicantCap != null ? Math.min(natural, applicantCap) : natural;
  return Math.round(Math.max(0, capped) * 100) / 100;
}

// Every allocation the season/shul/applicant chain would let happen, given
// as ONE combined card top-up (base + match together) — disccardpromos only
// ever sees one number, same as a normal card load at approval time.
// Throws with a user-facing message on any validation failure; never
// partially writes (the DB insert only happens once every check passes).
export async function createAllocation({ orgId, userId, shulId, applicantId, baseAmount, createdBy, isAdminOverride, ip }) {
  if (!(baseAmount > 0)) throw new Error('Amount must be greater than $0');
  const shul = db.prepare('SELECT * FROM shuls WHERE id = ? AND org_id = ?').get(shulId, orgId);
  if (!shul) throw new Error('Shul not found');
  const applicant = db.prepare('SELECT * FROM applicants WHERE id = ? AND org_id = ?').get(applicantId, orgId);
  if (!applicant) throw new Error('Applicant not found');
  if (applicant.approval_status !== 'approved') throw new Error('This applicant has not been approved yet — funds can only be allocated to an approved applicant with an active card.');
  if (applicant.provider_exempt) throw new Error('This applicant is exempt from gift card provisioning and cannot receive an allocation.');
  if (!applicant.provider_account_id) throw new Error('This applicant has no disccardpromos account on file yet — funds cannot be loaded.');
  if (!isAdminOverride && applicant.shul_id !== shulId) throw new Error('This applicant does not belong to your shul.');

  const balance = approvedBalance(shulId);
  if (baseAmount > balance + 1e-9) throw new Error(`Amount ($${baseAmount.toFixed(2)}) exceeds this shul's approved balance ($${balance.toFixed(2)}).`);

  const season = db.prepare('SELECT * FROM seasons WHERE id = ?').get(applicant.season_id);
  const { rate, matchAmount } = computeRealMatch({ applicant, shul, season, baseAmount });
  const totalAmount = Math.round((baseAmount + matchAmount) * 100) / 100;

  const discountId = db.prepare(`SELECT value FROM settings WHERE org_id = ? AND key = 'disccardpromos_discount_id'`).get(orgId)?.value;
  let giftcardStatus = 'ok', giftcardError = null;
  if (!discountId) {
    giftcardStatus = 'failed';
    giftcardError = 'No disccardpromos Package/Discount ID configured (Settings > Organization > Gift Card Loading).';
  } else {
    try {
      await giftcard.addFunds(applicant.season_id, { externalId: applicant.external_id, discountId, amount: totalAmount });
    } catch (e) {
      giftcardStatus = 'failed';
      giftcardError = e.message;
    }
  }

  const id = uuid();
  db.prepare(`INSERT INTO shul_allocations (id, org_id, shul_id, applicant_id, season_id, base_amount, match_amount, total_amount, match_rate_used, is_admin_override, created_by, giftcard_status, giftcard_error)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, orgId, shulId, applicantId, applicant.season_id, baseAmount, matchAmount, totalAmount, rate, isAdminOverride ? 1 : 0, createdBy, giftcardStatus, giftcardError);

  const row = db.prepare('SELECT * FROM shul_allocations WHERE id = ?').get(id);
  logAudit(orgId, userId, 'create', 'shul_allocation', id, null, row, ip);
  return row;
}

// Reverses an allocation as an equal-and-opposite entry (never a delete —
// same reasoning as every other money record in this app). Blocked once
// the applicant's card balance no longer covers the amount being pulled
// back — a fungible balance can't prove which specific dollars are still
// sitting there, so "still covered" is the only check that's actually
// possible, per the confirmed design.
export async function reverseAllocation({ orgId, userId, allocationId, ip }) {
  const original = db.prepare('SELECT * FROM shul_allocations WHERE id = ? AND org_id = ?').get(allocationId, orgId);
  if (!original) throw new Error('Allocation not found');
  if (original.reversed_at) throw new Error('This allocation has already been reversed');

  const applicant = db.prepare('SELECT * FROM applicants WHERE id = ?').get(original.applicant_id);
  const discountId = db.prepare(`SELECT value FROM settings WHERE org_id = ? AND key = 'disccardpromos_discount_id'`).get(orgId)?.value;
  // getCustomerByExternalId (not getCardBalance, which needs a real 16-digit
  // card number this app never retains — see cards.card_number_masked's own
  // "last 4 only, ever displayed" comment) is the one already live-tested
  // against the real API elsewhere in this file.
  if (applicant?.external_id && discountId) {
    const customer = await giftcard.getCustomerByExternalId(original.season_id, applicant.external_id, { balances: true }).catch(() => null);
    const pkg = customer?.packages?.find(p => String(p.id) === String(discountId));
    const currentBalance = pkg ? Number(pkg.amount) : null;
    if (currentBalance != null && currentBalance < original.total_amount - 1e-9) {
      throw new Error(`Cannot undo — the applicant's card balance ($${currentBalance.toFixed(2)}) no longer covers the amount given ($${original.total_amount.toFixed(2)}), meaning some of it has already been spent.`);
    }
  }

  if (discountId) {
    await giftcard.addFunds(original.season_id, { externalId: applicant.external_id, discountId, amount: -original.total_amount });
  }

  const id = uuid();
  db.prepare(`INSERT INTO shul_allocations (id, org_id, shul_id, applicant_id, season_id, base_amount, match_amount, total_amount, match_rate_used, is_admin_override, created_by, giftcard_status, reversal_of)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, orgId, original.shul_id, original.applicant_id, original.season_id, -original.base_amount, -original.match_amount, -original.total_amount, original.match_rate_used, original.is_admin_override, userId, discountId ? 'ok' : 'failed', original.id);

  db.prepare('UPDATE shul_allocations SET reversed_at = datetime(\'now\'), reversed_by = ? WHERE id = ?').run(userId, original.id);
  const reversalRow = db.prepare('SELECT * FROM shul_allocations WHERE id = ?').get(id);
  logAudit(orgId, userId, 'undo', 'shul_allocation', original.id, original, reversalRow, ip);
  return reversalRow;
}
