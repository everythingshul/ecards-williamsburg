import { Router } from 'express';
import { db, uuid, DEFAULT_ORG_ID } from '../db.js';
import { auth } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import { pendingBalance, approvedBalance, shulBalances } from '../services/shulBalance.js';
import { createAllocation, reverseAllocation, shulDisplayMatch, computeRetrievable } from '../services/matching.js';
import * as solaPay from '../services/sola.js';
import { notifyNewSignup } from '../services/mail.js';
import { logAudit } from '../services/audit.js';
import { sendXlsx } from '../services/xlsx.js';

const router = Router();

// Was a hardcoded array — now admin-editable (Settings > Shul Payments >
// Payment Method Options) via the generic settings key/value store, stored
// as a JSON array of {value, label, active}. `value` is the immutable
// internal key already written onto historical shul_payments.method /
// shul_payment_method_requests.requested_method rows — an admin can rename
// the label or deactivate an option (hides it from new entries without
// breaking how old rows display), but never changes `value` itself once
// created, and a brand-new option gets a freshly slugified value. Falls
// back to the original 5 built-ins, all active, if nothing's been saved —
// same "missing setting = old default behavior" pattern every other
// settings-backed toggle in this app already uses.
const DEFAULT_MANUAL_PAYMENT_METHODS = [
  { value: 'wire', label: 'Wire Transfer', active: true },
  { value: 'quickpay', label: 'Quick Pay', active: true },
  { value: 'check', label: 'Check', active: true },
  { value: 'cash', label: 'Cash', active: true },
  { value: 'other', label: 'Other', active: true },
];
function getManualPaymentMethods(orgId) {
  const row = db.prepare(`SELECT value FROM settings WHERE org_id = ? AND key = 'manual_payment_methods'`).get(orgId);
  if (!row?.value) return DEFAULT_MANUAL_PAYMENT_METHODS;
  try {
    const parsed = JSON.parse(row.value);
    return Array.isArray(parsed) && parsed.length ? parsed : DEFAULT_MANUAL_PAYMENT_METHODS;
  } catch { return DEFAULT_MANUAL_PAYMENT_METHODS; }
}
function isActiveManualMethod(orgId, method) {
  return getManualPaymentMethods(orgId).some(m => m.value === method && m.active !== false);
}

// Card processing fee formula (Settings > Shul Payments > Card Processing
// Fee) — a percent + flat $ combo, Stripe-style (e.g. 2.9% + $0.30) —
// applied automatically to every REAL card charge (the shul's own
// self-serve payment below, and an admin-initiated one — see POST
// /admin-charge) at the moment it's charged. Sola's API doesn't hand back a
// real per-transaction fee the way Stripe's balance_transaction did (see
// services/sola.js), so this is the app's own best-effort estimate from a
// configured rate, not something read off the processor — PUT /:id/fee
// still lets an admin correct it later once they know the real number (e.g.
// from a Sola statement). Both settings default to 0 (no fee tracked) until
// an admin sets them, so existing behavior is unchanged until someone opts in.
//
// ADDITIVE, not subtracted: the amount the shul types in (or an admin types
// in on their behalf) is what gets CREDITED toward their balance — the fee
// is computed off that figure and added ON TOP as what actually gets
// charged to the card, never carved out of what the shul asked to pay. A
// shul typing "$100" to pay off a $100 balance used to have their card
// charged $100 but only $96.80 credited (the fee silently eaten out of
// their own payment, leaving them still short) — now their card is charged
// $103.20 and the full $100 is credited. Both charge routes below show the
// computed total to the payer BEFORE they submit (GET /mine/config and
// GET /config both return `cardFee` so the frontend can preview it live),
// so there's never a surprise total on the receipt either.
function getCardFeeConfig(orgId) {
  const pct = db.prepare(`SELECT value FROM settings WHERE org_id = ? AND key = 'card_fee_percent'`).get(orgId)?.value;
  const flat = db.prepare(`SELECT value FROM settings WHERE org_id = ? AND key = 'card_fee_flat'`).get(orgId)?.value;
  return { percent: pct != null && pct !== '' ? +pct : 0, flat: flat != null && flat !== '' ? +flat : 0 };
}
function computeCardFee(orgId, amount) {
  const { percent, flat } = getCardFeeConfig(orgId);
  if (!percent && !flat) return 0;
  const fee = Math.round((amount * (percent / 100) + flat) * 100) / 100;
  return Math.max(0, Math.min(fee, amount));
}

// No webhook here (unlike the old Stripe setup) — Sola's charge is
// synchronous: the charge result comes back in the same HTTP response as
// POST /mine/sola-charge below, so there's no async event to wait on and
// nothing for Sola to call back into this app about.

router.use(auth, requirePermission('shul_payments'));

// ============================= SHUL PORTAL (own shul only) =============================

router.get('/mine/balance', (req, res) => {
  if (req.user.role !== 'shul') return res.status(403).json({ error: 'Not permitted' });
  res.json(shulBalances(req.user.shul_id));
});

router.get('/mine', (req, res) => {
  if (req.user.role !== 'shul') return res.status(403).json({ error: 'Not permitted' });
  const rows = db.prepare(`SELECT id, method, amount, fee_amount, net_amount, status, direction, manual_date, manual_ref, rejected_reason, card_last4, created_at, approved_at
    FROM shul_payments WHERE shul_id = ? ORDER BY created_at DESC`).all(req.user.shul_id);
  res.json({ payments: rows });
});

// Public config a shul's payment page needs before it can render the card
// form at all: whether online card payment is enabled for them (org
// default, shul-level override). shuls.stripe_payments_enabled is the same
// tri-state on/off/use-default column from the earlier Stripe setup, reused
// as-is — it was always "is online card payment enabled for this shul",
// never actually processor-specific despite the name (renaming the column
// isn't worth the migration risk on a live table for what's purely an
// internal identifier).
router.get('/mine/config', (req, res) => {
  if (req.user.role !== 'shul') return res.status(403).json({ error: 'Not permitted' });
  const shul = db.prepare('SELECT stripe_payments_enabled FROM shuls WHERE id = ?').get(req.user.shul_id);
  const orgDefault = db.prepare(`SELECT value FROM settings WHERE org_id = ? AND key = 'sola_payments_enabled_default'`).get(req.user.org_id)?.value !== '0';
  const enabled = shul?.stripe_payments_enabled != null ? !!shul.stripe_payments_enabled : orgDefault;
  // Also handed to the shul portal's "Request a Different Payment Method"
  // modal — active AND visible-to-shul only (Settings > Shul Payments >
  // Payment Method Options' own "Visible to shul" checkbox, independent of
  // Active — a method can stay usable for admin manual entry while being
  // hidden from the shul-facing list entirely, e.g. an in-person/cash
  // arrangement the office handles directly and never wants a shul to pick
  // for themselves). isActiveManualMethod (used when a shul submits a
  // request) intentionally does NOT also check visibility, so hiding a
  // method here is a UI convenience, not a hard block.
  const manualPaymentMethods = getManualPaymentMethods(req.user.org_id).filter(m => m.active !== false && m.visibleToShul !== false);
  res.json({ solaEnabled: enabled, mockMode: solaPay.isSolaMockMode(), manualPaymentMethods, cardFee: getCardFeeConfig(req.user.org_id) });
});

// xCardNum/xCVV/xExp here are the REAL card number/CVV/expiration, typed
// directly into the shul portal's own plain form fields (no iframe) and
// POSTed here as ordinary JSON — see services/sola.js's file-level PCI
// comment for what that means for this app's compliance scope and why it's
// deliberate. Never log req.body on this route. The charge itself is
// synchronous: chargeSale() either comes back approved (and this inserts
// the shul_payments row right here, same 'pending_approval'-until-admin-
// approves status the old webhook-created Stripe rows used) or declined
// (nothing is written, the shul sees why immediately).
router.post('/mine/sola-charge', async (req, res) => {
  if (req.user.role !== 'shul') return res.status(403).json({ error: 'Not permitted' });
  // What the shul intends to have CREDITED toward their balance — the fee
  // (see getCardFeeConfig's comment above) is computed off this figure and
  // added on top for what actually gets charged to the card, not carved out
  // of it.
  const creditAmount = +req.body?.amount;
  // Stripped/normalized here too (not just client-side) since this is a
  // tampered/direct-API-call concern, not a normal-use one — the shul
  // portal's own form already sends these clean.
  const xCardNum = String(req.body?.xCardNum || '').replace(/\s/g, '');
  const xCVV = String(req.body?.xCVV || '').trim();
  const xZip = String(req.body?.xZip || '').trim();
  const xExp = String(req.body?.xExp || '').replace(/\D/g, '');
  if (!(creditAmount > 0)) return res.status(400).json({ error: 'Amount must be greater than $0' });
  const shul = db.prepare('SELECT stripe_payments_enabled, season_id, name_en FROM shuls WHERE id = ?').get(req.user.shul_id);
  const orgDefault = db.prepare(`SELECT value FROM settings WHERE org_id = ? AND key = 'sola_payments_enabled_default'`).get(req.user.org_id)?.value !== '0';
  const enabled = shul?.stripe_payments_enabled != null ? !!shul.stripe_payments_enabled : orgDefault;
  if (!enabled) return res.status(403).json({ error: 'Online card payment is not enabled for your shul. Use "Request a Different Payment Method" instead.' });
  if (!solaPay.isSolaMockMode()) {
    if (!xCardNum || !xCVV) return res.status(400).json({ error: 'Card details are required' });
    if (xExp.length !== 4) return res.status(400).json({ error: 'Expiration date is required' });
  }
  const fee = computeCardFee(req.user.org_id, creditAmount);
  const chargeAmount = Math.round((creditAmount + fee) * 100) / 100;
  try {
    const result = await solaPay.chargeSale({
      amount: chargeAmount, xCardNum, xCVV, xExp, xZip, xName: shul.name_en || '', xEmail: req.user.email || '',
      invoice: `${shul.name_en || 'shul'}-${Date.now()}`, comments: 'eCards shul payment',
    });
    if (!result.approved) return res.status(400).json({ error: result.error || 'Card declined' });
    const id = uuid();
    db.prepare(`INSERT INTO shul_payments (id, org_id, shul_id, season_id, method, amount, fee_amount, net_amount, status, sola_ref_num, card_last4, entered_by)
      VALUES (?,?,?,?,'sola_card',?,?,?,'pending_approval',?,?,?)`)
      .run(id, req.user.org_id, req.user.shul_id, shul.season_id, chargeAmount, fee, creditAmount, result.refNum, result.last4 || null, req.user.id);
    logAudit(req.user.org_id, req.user.id, 'create', 'shul_payment', id, null, db.prepare('SELECT * FROM shul_payments WHERE id = ?').get(id), req.ip);
    res.json({ ok: true, mock: !!result.mock, chargeAmount, fee, creditAmount });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/mine/request-method', async (req, res) => {
  if (req.user.role !== 'shul') return res.status(403).json({ error: 'Not permitted' });
  const { requested_method, message } = req.body || {};
  if (!requested_method) return res.status(400).json({ error: 'requested_method is required' });
  const id = uuid();
  db.prepare('INSERT INTO shul_payment_method_requests (id, org_id, shul_id, requested_method, message) VALUES (?,?,?,?,?)')
    .run(id, req.user.org_id, req.user.shul_id, requested_method, message || '');
  const shul = db.prepare('SELECT name_en FROM shuls WHERE id = ?').get(req.user.shul_id);
  // Same pattern as every other internal admin notice (new shul/store
  // signup, doc signed) — a dedicated, admin-configured "office" address
  // (Settings > Notify on Payment Method Requests), not every admin/staff
  // user's own login email. No-op (silently) if that setting is blank,
  // same as the others.
  // replyTo: the submitting shul's own login email, so hitting "Reply" on
  // this internal alert goes straight back to whoever actually asked, not
  // nowhere (or the org's own generic reply-to).
  await notifyNewSignup(req.user.org_id, 'notify_payment_method_request_email', 'paymentMethodRequest', {
    shulName: shul?.name_en || 'A shul',
    requestedMethod: requested_method,
    message: message ? `<p>Message: ${esc(message)}</p>` : '',
  }, { replyTo: req.user.email });
  res.status(201).json({ ok: true });
});
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// Shul's own downloadable report: one row per applicant this shul has given
// money to, with ONLY this shul's own base money (never the match, never
// any other shul's contribution — same privacy rule as /mine/allocations
// below). Reversals are separate negative rows on the same applicant_id, so
// a plain SUM(base_amount) already nets an Undo out. Registered before
// /mine/allocations so Express doesn't swallow it as that route's suffix.
router.get('/mine/allocations/export', (req, res) => {
  if (req.user.role !== 'shul') return res.status(403).json({ error: 'Not permitted' });
  const seasonId = req.query.season_id || null;
  const rows = db.prepare(`SELECT a.external_id, a.first_name, a.last_name, s.name AS season_name,
      COALESCE(SUM(sa.base_amount), 0) AS given, COUNT(CASE WHEN sa.reversal_of IS NULL THEN 1 END) AS gives,
      MIN(sa.created_at) AS first_given_at, MAX(sa.created_at) AS last_given_at
    FROM shul_allocations sa
    LEFT JOIN applicants a ON a.id = sa.applicant_id
    LEFT JOIN seasons s ON s.id = sa.season_id
    WHERE sa.shul_id = ?${seasonId ? ' AND sa.season_id = ?' : ''}
    GROUP BY sa.applicant_id ORDER BY a.last_name, a.first_name`).all(req.user.shul_id, ...(seasonId ? [seasonId] : []));
  const out = rows.map(r => ({
    'Applicant ID': r.external_id || '', 'First Name': r.first_name || '', 'Last Name': r.last_name || '',
    'Season': r.season_name || '', 'Amount Given by Our Shul': Math.round(r.given * 100) / 100,
    'Number of Gives': r.gives, 'First Given': r.first_given_at, 'Last Given': r.last_given_at,
  }));
  const total = Math.round(out.reduce((s, r) => s + r['Amount Given by Our Shul'], 0) * 100) / 100;
  out.push({ 'Applicant ID': '', 'First Name': 'TOTAL', 'Last Name': '', 'Season': '', 'Amount Given by Our Shul': total, 'Number of Gives': '', 'First Given': '', 'Last Given': '' });
  sendXlsx(res, `our-applicants-${Date.now()}.xlsx`, out);
});

router.get('/mine/allocations', (req, res) => {
  if (req.user.role !== 'shul') return res.status(403).json({ error: 'Not permitted' });
  const rows = db.prepare(`SELECT sa.*, a.first_name, a.last_name FROM shul_allocations sa
    LEFT JOIN applicants a ON a.id = sa.applicant_id WHERE sa.shul_id = ? ORDER BY sa.created_at DESC`).all(req.user.shul_id);
  // The privacy view: a shul only ever sees its OWN money + what its own
  // contribution alone would earn against the per-applicant cap, capped so
  // it never exceeds what's actually still available (never any hint
  // another shul is involved, or by how much). See services/matching.js's
  // shulDisplayMatch for the full reasoning.
  const out = rows.filter(r => r.base_amount > 0).map(r => {
    const applicant = db.prepare('SELECT * FROM applicants WHERE id = ?').get(r.applicant_id);
    const shul = db.prepare('SELECT * FROM shuls WHERE id = ?').get(r.shul_id);
    const season = db.prepare('SELECT * FROM seasons WHERE id = ?').get(r.season_id);
    const displayMatch = applicant && shul && season ? shulDisplayMatch({ applicant, shul, season, baseAmount: r.base_amount, ownMatchAmount: r.match_amount }) : 0;
    // A reversed give's own reversal_note (see services/matching.js's
    // buildReversalNote) — the shul's own money, so they see the same plain
    // explanation an admin does (how much came back, how much couldn't be
    // retrieved and why), just attached to the original row rather than as
    // a separate reversal entry (this endpoint never shows shul-facing
    // reversal rows directly — see the privacy comment above).
    const reversal = r.reversed_at ? db.prepare('SELECT reversal_note FROM shul_allocations WHERE reversal_of = ?').get(r.id) : null;
    return {
      id: r.id, applicant_id: r.applicant_id, applicant_name: `${r.first_name || ''} ${r.last_name || ''}`.trim(),
      base_amount: r.base_amount, display_total: Math.round((r.base_amount + displayMatch) * 100) / 100,
      created_at: r.created_at, reversed: !!r.reversed_at, reversal_note: reversal?.reversal_note || null,
    };
  });
  res.json({ allocations: out });
});

router.post('/mine/allocate', async (req, res) => {
  if (req.user.role !== 'shul') return res.status(403).json({ error: 'Not permitted' });
  try {
    const row = await createAllocation({
      orgId: req.user.org_id, userId: req.user.id, shulId: req.user.shul_id, applicantId: req.body?.applicant_id,
      baseAmount: +req.body?.amount, createdBy: req.user.id, isAdminOverride: false, ip: req.ip,
    });
    // giftcard_status/giftcard_error included — a failed disccardpromos push
    // (bad Package/Discount ID, no provider account yet, a network error)
    // used to come back here as plain "ok: true" with nothing distinguishing
    // it from a real success: the shul's own balance/ledger always updates
    // (that's this app's own money-tracking, and correctly never blocked on
    // the external write — see createAllocation's own comment), but the
    // money silently never reached the real card. Surfaced so the frontend
    // can warn instead of reporting a clean "Activated" either way.
    res.status(201).json({ ok: true, allocation: { id: row.id, base_amount: row.base_amount, giftcard_status: row.giftcard_status, giftcard_error: row.giftcard_error } });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ============================= ADMIN =============================

// One row per shul with just their lifetime Total Paid (net of refunds/
// payouts/fees, same figure as shulBalance.js's totalPaid — never
// including match, since that's never money the shul paid) — for the
// Shul Transactions "Shul Totals" tab. Deliberately NOT per-transaction
// and NOT paginated: this is a small, full list (one row per shul, not per
// payment) meant to be searched/sorted entirely client-side, same pattern
// as GET /shuls/all-list.
router.get('/shul-totals', (req, res) => {
  if (req.user.role === 'shul') return res.status(403).json({ error: 'Not permitted' });
  const rows = db.prepare(`
    SELECT s.id, s.name_en, s.name_he,
      COALESCE(SUM(CASE WHEN p.status = 'approved' THEN p.net_amount ELSE 0 END), 0) total_paid
    FROM shuls s
    LEFT JOIN shul_payments p ON p.shul_id = s.id
    WHERE s.org_id = ? AND s.is_locked = 0
    GROUP BY s.id
    ORDER BY total_paid DESC
  `).all(req.user.org_id);
  res.json({ shuls: rows.map(r => ({ id: r.id, nameEn: r.name_en, nameHe: r.name_he, totalPaid: r.total_paid })) });
});

router.get('/', (req, res) => {
  if (req.user.role === 'shul') return res.status(403).json({ error: 'Not permitted' });
  const { shul_id, status, season_id } = req.query;
  let where = 'WHERE p.org_id = ?';
  const params = [req.user.org_id];
  if (shul_id) { where += ' AND p.shul_id = ?'; params.push(shul_id); }
  if (status) { where += ' AND p.status = ?'; params.push(status); }
  if (season_id) { where += ' AND p.season_id = ?'; params.push(season_id); }
  const rows = db.prepare(`SELECT p.*, s.name_en as shul_name, u.first_name as entered_by_first, u.last_name as entered_by_last
    FROM shul_payments p LEFT JOIN shuls s ON s.id = p.shul_id LEFT JOIN users u ON u.id = p.entered_by
    ${where} ORDER BY p.created_at DESC`).all(...params);
  res.json({ payments: rows });
});

router.get('/balance/:shulId', (req, res) => {
  if (req.user.role === 'shul') return res.status(403).json({ error: 'Not permitted' });
  res.json(shulBalances(req.params.shulId));
});

router.get('/config', (req, res) => {
  if (req.user.role === 'shul') return res.status(403).json({ error: 'Not permitted' });
  res.json({ ...solaPay.solaConfigStatus(), cardFee: getCardFeeConfig(req.user.org_id) });
});

// Manual entry is inherently admin-vetted (an admin is the one typing it
// in, having already confirmed the money was actually received) — it goes
// straight to 'approved', unlike a shul's own Sola card payment which always
// needs a separate admin approval step. entered_by doubles as both the
// audit trail and the "signed with the name of the account adding it"
// requirement — always the logged-in admin, never a free-text name field.
router.post('/manual', requirePermission('shul_payments', 'can_edit'), (req, res) => {
  if (req.user.role === 'shul') return res.status(403).json({ error: 'Not permitted' });
  const { shul_id, season_id, method, amount, manual_date, manual_time, manual_ref, notes } = req.body || {};
  if (!isActiveManualMethod(req.user.org_id, method)) return res.status(400).json({ error: 'That payment method is not currently offered — check Settings > Shul Payments.' });
  if (!(+amount > 0)) return res.status(400).json({ error: 'Amount must be greater than $0' });
  if (!manual_date || !manual_time || !manual_ref) return res.status(400).json({ error: 'Date, time, and Ref#/Check# are all required for a manual payment entry' });
  const shul = db.prepare('SELECT id FROM shuls WHERE id = ? AND org_id = ?').get(shul_id, req.user.org_id);
  if (!shul) return res.status(404).json({ error: 'Shul not found' });
  const season = db.prepare('SELECT id FROM seasons WHERE id = ? AND org_id = ?').get(season_id, req.user.org_id);
  if (!season) return res.status(404).json({ error: 'Season not found' });
  const id = uuid();
  db.prepare(`INSERT INTO shul_payments (id, org_id, shul_id, season_id, method, amount, fee_amount, net_amount, status, manual_date, manual_time, manual_ref, entered_by, approved_by, approved_at, notes)
    VALUES (?,?,?,?,?,?,0,?,'approved',?,?,?,?,?,datetime('now'),?)`)
    .run(id, req.user.org_id, shul_id, season_id, method, +amount, +amount, manual_date, manual_time, manual_ref, req.user.id, req.user.id, notes || '');
  const row = db.prepare('SELECT * FROM shul_payments WHERE id = ?').get(id);
  logAudit(req.user.org_id, req.user.id, 'create', 'shul_payment', id, null, row, req.ip);
  res.status(201).json({ ok: true, payment: row });
});

// The org paying money BACK to a shul (a refund/reimbursement, entered by
// staff after it happened outside this app — no CC processing here, same
// "just a record" nature as the manual 'in' entry above; for an actual
// processor-side refund of a real Sola card payment, see POST /:id/refund
// below instead). Stored as a
// negative net_amount/amount on the SAME shul_payments ledger (direction
// 'out') so services/shulBalance.js's existing SUM(net_amount) subtracts it
// with no query changes — reduces the shul's balance exactly like an
// allocation given to an applicant would, just paid to the shul itself
// instead. Goes straight to 'approved' like a manual 'in' entry (an admin
// typing this in has already confirmed the money actually went out).
router.post('/payout', requirePermission('shul_payments', 'can_edit'), (req, res) => {
  if (req.user.role === 'shul') return res.status(403).json({ error: 'Not permitted' });
  const { shul_id, season_id, method, amount, manual_date, manual_time, manual_ref, notes } = req.body || {};
  if (!isActiveManualMethod(req.user.org_id, method)) return res.status(400).json({ error: 'That payment method is not currently offered — check Settings > Shul Payments.' });
  if (!(+amount > 0)) return res.status(400).json({ error: 'Amount must be greater than $0' });
  if (!manual_date || !manual_time || !manual_ref) return res.status(400).json({ error: 'Date, time, and Ref#/Check# are all required for a payout entry' });
  const shul = db.prepare('SELECT id FROM shuls WHERE id = ? AND org_id = ?').get(shul_id, req.user.org_id);
  if (!shul) return res.status(404).json({ error: 'Shul not found' });
  const season = db.prepare('SELECT id FROM seasons WHERE id = ? AND org_id = ?').get(season_id, req.user.org_id);
  if (!season) return res.status(404).json({ error: 'Season not found' });
  const balance = approvedBalance(shul_id);
  if (+amount > balance + 1e-9) return res.status(400).json({ error: `Amount ($${(+amount).toFixed(2)}) exceeds this shul's approved balance ($${balance.toFixed(2)}).` });
  const id = uuid();
  db.prepare(`INSERT INTO shul_payments (id, org_id, shul_id, season_id, method, amount, fee_amount, net_amount, status, direction, manual_date, manual_time, manual_ref, entered_by, approved_by, approved_at, notes)
    VALUES (?,?,?,?,?,?,0,?,'approved','out',?,?,?,?,?,datetime('now'),?)`)
    .run(id, req.user.org_id, shul_id, season_id, method, +amount, -(+amount), manual_date, manual_time, manual_ref, req.user.id, req.user.id, notes || '');
  const row = db.prepare('SELECT * FROM shul_payments WHERE id = ?').get(id);
  logAudit(req.user.org_id, req.user.id, 'create', 'shul_payment', id, null, row, req.ip);
  res.status(201).json({ ok: true, payment: row });
});

// Same real Sola charge as the shul portal's own POST /mine/sola-charge
// above (see that route's comment for the PCI-scope note — never log
// req.body here either), but for an admin taking a card charge on a shul's
// behalf (e.g. over the phone, or entering a payment a shul called in) from
// Shul Transactions' "Charge Credit Card" form. Goes straight to 'approved'
// like every other admin-entered payment (POST /manual above), never
// 'pending_approval' — an admin personally initiating and confirming a real
// charge already IS the approval step, unlike a shul's own self-serve
// submission which still needs a human to check it. Deliberately does NOT
// check the shul's stripe_payments_enabled online-self-service toggle —
// that toggle only gates the shul's OWN portal form; an admin can always
// take a card charge on someone's behalf regardless of whether that shul is
// allowed to self-serve one.
router.post('/admin-charge', requirePermission('shul_payments', 'can_edit'), async (req, res) => {
  if (req.user.role === 'shul') return res.status(403).json({ error: 'Not permitted' });
  const { shul_id, season_id } = req.body || {};
  // Same additive-fee convention as POST /mine/sola-charge above: this is
  // what gets CREDITED to the shul's balance, fee added on top for what
  // actually hits the card.
  const creditAmount = +req.body?.amount;
  const xCardNum = String(req.body?.xCardNum || '').replace(/\s/g, '');
  const xCVV = String(req.body?.xCVV || '').trim();
  const xZip = String(req.body?.xZip || '').trim();
  const xExp = String(req.body?.xExp || '').replace(/\D/g, '');
  if (!(creditAmount > 0)) return res.status(400).json({ error: 'Amount must be greater than $0' });
  const shul = db.prepare('SELECT id, name_en FROM shuls WHERE id = ? AND org_id = ?').get(shul_id, req.user.org_id);
  if (!shul) return res.status(404).json({ error: 'Shul not found' });
  const season = db.prepare('SELECT id FROM seasons WHERE id = ? AND org_id = ?').get(season_id, req.user.org_id);
  if (!season) return res.status(404).json({ error: 'Season not found' });
  if (!solaPay.isSolaMockMode()) {
    if (!xCardNum || !xCVV) return res.status(400).json({ error: 'Card details are required' });
    if (xExp.length !== 4) return res.status(400).json({ error: 'Expiration date is required' });
  }
  const fee = computeCardFee(req.user.org_id, creditAmount);
  const chargeAmount = Math.round((creditAmount + fee) * 100) / 100;
  try {
    const result = await solaPay.chargeSale({
      amount: chargeAmount, xCardNum, xCVV, xExp, xZip, xName: shul.name_en || '', xEmail: req.user.email || '',
      invoice: `${shul.name_en || 'shul'}-${Date.now()}`, comments: 'eCards admin-entered card charge',
    });
    if (!result.approved) return res.status(400).json({ error: result.error || 'Card declined' });
    const id = uuid();
    db.prepare(`INSERT INTO shul_payments (id, org_id, shul_id, season_id, method, amount, fee_amount, net_amount, status, sola_ref_num, card_last4, entered_by, approved_by, approved_at)
      VALUES (?,?,?,?,'sola_card',?,?,?,'approved',?,?,?,?,datetime('now'))`)
      .run(id, req.user.org_id, shul_id, season_id, chargeAmount, fee, creditAmount, result.refNum, result.last4 || null, req.user.id, req.user.id);
    const row = db.prepare('SELECT * FROM shul_payments WHERE id = ?').get(id);
    logAudit(req.user.org_id, req.user.id, 'create', 'shul_payment', id, null, row, req.ip);
    res.status(201).json({ ok: true, mock: !!result.mock, payment: row });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Manually sets/corrects a payment's processing fee — added because Sola's
// charge API (unlike Stripe's balance_transaction) doesn't hand back a
// real per-transaction fee (see services/sola.js), so a sola_card row's
// fee_amount otherwise just sits at 0 forever. This lets an admin type in
// the actual fee once they know it (e.g. from a Sola statement), recomputing
// net_amount the same way every other fee-bearing row already does
// (amount - fee_amount). Never touched automatically by anything else —
// this is the one place fee_amount changes after a row is first created.
router.put('/:id/fee', requirePermission('shul_payments', 'can_edit'), (req, res) => {
  if (req.user.role === 'shul') return res.status(403).json({ error: 'Not permitted' });
  const payment = db.prepare('SELECT * FROM shul_payments WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!payment) return res.status(404).json({ error: 'Not found' });
  if (payment.direction !== 'in') return res.status(400).json({ error: 'Fees can only be set on a payment the shul made, not a refund/payout' });
  const feeAmount = +req.body?.fee_amount;
  if (!(feeAmount >= 0)) return res.status(400).json({ error: 'Fee must be $0 or more' });
  if (feeAmount > payment.amount + 1e-9) return res.status(400).json({ error: `Fee ($${feeAmount.toFixed(2)}) can't exceed the payment amount ($${payment.amount.toFixed(2)}).` });
  const netAmount = Math.round((payment.amount - feeAmount) * 100) / 100;
  db.prepare('UPDATE shul_payments SET fee_amount = ?, net_amount = ? WHERE id = ?').run(feeAmount, netAmount, payment.id);
  const updated = db.prepare('SELECT * FROM shul_payments WHERE id = ?').get(payment.id);
  logAudit(req.user.org_id, req.user.id, 'update', 'shul_payment', payment.id, payment, updated, req.ip);
  res.json({ ok: true, payment: updated });
});

// Refunds (full or partial) a Sola card payment through the actual
// processor — cc:Refund, linked to the original sale via sola_ref_num (see
// services/sola.js). Recorded the same way POST /payout above records money
// paid back to a shul: a new shul_payments row (direction='out', negative
// net_amount) rather than mutating the original row, so the balance SUM
// picks it up automatically and the original charge's own history stays
// intact. refund_of links the two rows so "how much of this charge has
// already been refunded" is a plain SUM query, and the refund can never
// exceed what hasn't already gone back.
//
// Works regardless of the ORIGINAL charge's approval-workflow status —
// deliberately NOT restricted to status='approved'. A real Sola charge
// happens the instant the shul submits it (see POST /mine/sola-charge
// above), before any admin review — a still-pending or already-rejected
// charge is still a REAL charge that took a shul's real money, and
// rejecting it never refunds it on its own (see POST /:id/reject below,
// unchanged). Blocking Refund on anything but 'approved' would leave a
// rejected card charge with no way to actually give the money back except
// the removed Delete button, which never touched the processor either —
// exactly the gap this route exists to close.
//
// services/shulBalance.js's approvedBalance sums ALL status='approved'
// shul_payments rows (any direction) — so the refund row this inserts must
// only carry status='approved' when the ORIGINAL charge itself was
// 'approved' (i.e. actually counted toward the shul's balance already);
// otherwise inserting an 'approved' negative row would subtract money from
// the balance that was never added to it in the first place. For a
// never-approved original, the refund row goes in as 'rejected' instead —
// same bucket the original itself is in, so it never touches any balance
// SUM, while still showing in the payments list and still counting toward
// "how much of this charge has already been refunded" below (that query
// has no status filter).
//
// amount (this route's request body / the card-side ask) vs. the balance
// impact are tracked SEPARATELY, not assumed equal, because of the additive
// fee model above: the original charge's `amount` column is the GROSS
// figure that hit the card (principal + fee) while `net_amount` is only the
// principal that was ever credited to the shul's balance. A refund/void
// that returns the entire remaining gross to the card must still only
// reverse the remaining PRINCIPAL on the balance side — reversing the full
// gross would falsely leave the shul looking like they owe the fee amount,
// even though nothing is actually still owed once the whole charge is
// voided/refunded. alreadyRefundedGross (capping what can still be sent to
// Sola) and alreadyRefundedNet (capping what's left to reverse on the
// balance) are tracked from the SAME prior refund rows, just summing a
// different column each — see the two SUMs below.
//
// The processing fee itself is a real cost the org already paid Sola on
// the original sale — a plain refund (as opposed to a same-day void, which
// cancels the sale before Sola ever collects anything) does not get that
// fee back from Sola, regardless of how much principal comes back to the
// shul's card. That's a sunk cost for the org, never something reflected on
// the shul's own balance either way — feeNote below exists purely to
// surface that fact to whichever admin is watching, not to change any math.
router.post('/:id/refund', requirePermission('shul_payments', 'can_edit'), async (req, res) => {
  if (req.user.role === 'shul') return res.status(403).json({ error: 'Not permitted' });
  const payment = db.prepare('SELECT * FROM shul_payments WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!payment) return res.status(404).json({ error: 'Not found' });
  if (payment.direction !== 'in') return res.status(400).json({ error: 'Only a payment the shul made can be refunded, not a payout/refund itself' });
  if (payment.method !== 'sola_card' || !payment.sola_ref_num) return res.status(400).json({ error: 'Only a Sola card payment can be refunded here — for any other method, use Pay Shul to record money sent back manually.' });

  const refundRows = db.prepare(`SELECT amount, net_amount FROM shul_payments WHERE refund_of = ?`).all(payment.id);
  const alreadyRefundedGross = Math.round(refundRows.reduce((s, r) => s + r.amount, 0) * 100) / 100;
  const alreadyRefundedNet = Math.round(refundRows.reduce((s, r) => s + (-r.net_amount), 0) * 100) / 100;
  const refundable = Math.round((payment.amount - alreadyRefundedGross) * 100) / 100;
  const amount = +req.body?.amount;
  if (!(amount > 0)) return res.status(400).json({ error: 'Amount must be greater than $0' });
  if (amount > refundable + 1e-9) return res.status(400).json({ error: `Amount ($${amount.toFixed(2)}) exceeds what's left to refund on this payment ($${refundable.toFixed(2)}).` });
  const isFullAmount = Math.abs(amount - refundable) < 1e-9;
  // Full/void request: close out whatever principal is still outstanding
  // exactly (avoids any rounding drift from the ratio below). Genuine
  // partial request: split proportionally to the original charge's own
  // principal/gross ratio — the only defensible split when only some of a
  // blended principal+fee charge is coming back.
  const principalPortion = isFullAmount
    ? Math.round((payment.net_amount - alreadyRefundedNet) * 100) / 100
    : Math.round((amount * (payment.net_amount / payment.amount)) * 100) / 100;

  try {
    // Void first (cancels the original sale outright, same-day, before it
    // settles) and only fall back to a real refund when the void is
    // rejected — see services/sola.js's voidOrRefund for why a void is only
    // even attempted when this request covers the ENTIRE remaining
    // refundable amount (voiding always cancels the whole original sale, so
    // a genuinely partial ask can't go through void without over-returning
    // money).
    const result = await solaPay.voidOrRefund({ refNum: payment.sola_ref_num, amount, isFullAmount });
    if (!result.approved) return res.status(400).json({ error: result.error || 'Refund failed' });
    const feeNote = payment.fee_amount > 0 && result.method === 'refund'
      ? ` Note for admin: this payment had a $${payment.fee_amount.toFixed(2)} processing fee that Sola does not return on a refund (only on a same-day void) — the org doesn't get that portion back even though the shul's balance is being fully reversed for their principal.`
      : '';
    const methodNote = result.method === 'void'
      ? ' (voided — the original charge never settled, so nothing actually hit the card.)'
      : (result.voidAttemptError ? ` (refunded — void wasn't possible: ${result.voidAttemptError})` : '');
    // 'refunded' (not 'rejected') — a refund/void is never a rejection, it's
    // money that genuinely went back to the shul's card, and showing
    // "Rejected" on it read as if the payment had been declined/denied
    // rather than paid back. Same bucket-exclusion effect as 'rejected' for
    // every balance query below (pendingBalance/approvedBalance only ever
    // match 'pending_approval'/'approved' specifically), just the correct
    // label.
    const refundStatus = payment.status === 'approved' ? 'approved' : 'refunded';
    // FIXED — a payment refunded/voided while still 'pending_approval' used
    // to stay in that status forever: services/shulBalance.js's
    // pendingBalance() sums net_amount for every 'pending_approval' row
    // unconditionally, and the refund row above lands in 'refunded' (a
    // different bucket, since the original was never 'approved' — see this
    // route's file-level comment), so nothing ever offset it. The shul kept
    // seeing that money as "pending" indefinitely even though it had
    // already been sent back to their card. A full refund/void closes the
    // original out completely — nothing is left to ever approve — so it
    // moves to 'refunded' too, matching the refund row's own bucket and
    // dropping both out of Pending Balance together. A genuine PARTIAL
    // refund of a still-pending payment leaves the original's status alone
    // (some of it is still real, outstanding money to be approved or
    // rejected on its own merits).
    if (payment.status === 'pending_approval' && isFullAmount) {
      db.prepare(`UPDATE shul_payments SET status = 'refunded', approved_by = ?, approved_at = datetime('now'), rejected_reason = ? WHERE id = ?`)
        .run(req.user.id, `${result.method === 'void' ? 'Voided' : 'Refunded'} before approval.`, payment.id);
    }
    const id = uuid();
    db.prepare(`INSERT INTO shul_payments (id, org_id, shul_id, season_id, method, amount, fee_amount, net_amount, status, direction, sola_ref_num, refund_of, entered_by, approved_by, approved_at, notes)
      VALUES (?,?,?,?,'sola_refund',?,0,?,?,'out',?,?,?,?,datetime('now'),?)`)
      .run(id, req.user.org_id, payment.shul_id, payment.season_id, amount, -principalPortion, refundStatus, result.refNum, payment.id, req.user.id, req.user.id, `${result.method === 'void' ? 'Voided' : 'Refund of'} payment ${payment.id}.${methodNote}${feeNote}`.trim());
    const row = db.prepare('SELECT * FROM shul_payments WHERE id = ?').get(id);
    logAudit(req.user.org_id, req.user.id, 'create', 'shul_payment', id, null, row, req.ip);
    res.status(201).json({ ok: true, payment: row, feeNote: feeNote || null, method: result.method });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/:id/approve', requirePermission('shul_payments', 'can_edit'), (req, res) => {
  if (req.user.role === 'shul') return res.status(403).json({ error: 'Not permitted' });
  const payment = db.prepare('SELECT * FROM shul_payments WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!payment) return res.status(404).json({ error: 'Not found' });
  if (payment.status !== 'pending_approval') return res.status(400).json({ error: `This payment is already ${payment.status}` });
  // A pending sola_card charge can be refunded before ever being approved
  // (see POST /:id/refund above) — approving it afterward would count real
  // money that's already been given back toward the shul's balance.
  const alreadyRefunded = db.prepare(`SELECT COALESCE(SUM(-net_amount),0) t FROM shul_payments WHERE refund_of = ?`).get(payment.id).t;
  if (alreadyRefunded > 0.005) return res.status(400).json({ error: 'This payment has already been refunded and can\'t be approved.' });
  db.prepare(`UPDATE shul_payments SET status = 'approved', approved_by = ?, approved_at = datetime('now') WHERE id = ?`).run(req.user.id, payment.id);
  const updated = db.prepare('SELECT * FROM shul_payments WHERE id = ?').get(payment.id);
  logAudit(req.user.org_id, req.user.id, 'approve', 'shul_payment', payment.id, payment, updated, req.ip);
  res.json({ ok: true, payment: updated });
});

router.post('/:id/reject', requirePermission('shul_payments', 'can_edit'), (req, res) => {
  if (req.user.role === 'shul') return res.status(403).json({ error: 'Not permitted' });
  const payment = db.prepare('SELECT * FROM shul_payments WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!payment) return res.status(404).json({ error: 'Not found' });
  if (payment.status !== 'pending_approval') return res.status(400).json({ error: `This payment is already ${payment.status}` });
  db.prepare(`UPDATE shul_payments SET status = 'rejected', approved_by = ?, approved_at = datetime('now'), rejected_reason = ? WHERE id = ?`)
    .run(req.user.id, req.body?.reason || '', payment.id);
  const updated = db.prepare('SELECT * FROM shul_payments WHERE id = ?').get(payment.id);
  logAudit(req.user.org_id, req.user.id, 'reject', 'shul_payment', payment.id, payment, updated, req.ip);
  res.json({ ok: true, payment: updated });
});

router.get('/allocations', (req, res) => {
  if (req.user.role === 'shul') return res.status(403).json({ error: 'Not permitted' });
  const { shul_id, applicant_id, season_id } = req.query;
  let where = 'WHERE sa.org_id = ?';
  const params = [req.user.org_id];
  if (shul_id) { where += ' AND sa.shul_id = ?'; params.push(shul_id); }
  if (applicant_id) { where += ' AND sa.applicant_id = ?'; params.push(applicant_id); }
  if (season_id) { where += ' AND sa.season_id = ?'; params.push(season_id); }
  // Admin gets the real, full breakdown — actual match, actual rate, actual
  // giftcard result — never the shul-facing hypothetical view.
  const rows = db.prepare(`SELECT sa.*, s.name_en as shul_name, a.first_name, a.last_name, u.first_name as created_by_first, u.last_name as created_by_last
    FROM shul_allocations sa LEFT JOIN shuls s ON s.id = sa.shul_id LEFT JOIN applicants a ON a.id = sa.applicant_id LEFT JOIN users u ON u.id = sa.created_by
    ${where} ORDER BY sa.created_at DESC`).all(...params);
  res.json({ allocations: rows });
});

router.post('/allocate', requirePermission('shul_payments', 'can_edit'), async (req, res) => {
  if (req.user.role === 'shul') return res.status(403).json({ error: 'Not permitted' });
  try {
    const row = await createAllocation({
      orgId: req.user.org_id, userId: req.user.id, shulId: req.body?.shul_id, applicantId: req.body?.applicant_id,
      baseAmount: +req.body?.amount, createdBy: req.user.id, isAdminOverride: !!req.body?.is_admin_override, ip: req.ip,
    });
    res.status(201).json({ ok: true, allocation: row });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/allocations/:id/reverse', requirePermission('shul_payments', 'can_edit'), async (req, res) => {
  if (req.user.role === 'shul') return res.status(403).json({ error: 'Not permitted' });
  try {
    const row = await reverseAllocation({ orgId: req.user.org_id, userId: req.user.id, allocationId: req.params.id, ip: req.ip });
    res.json({ ok: true, reversal: row });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Deletes a shul_payments row outright (not an equal-and-opposite reversal
// like allocations get — this is correcting a data-entry mistake, not
// undoing a real event). A pending/rejected entry never funded anything
// (see services/shulBalance.js's approvedBalance — only status='approved'
// rows count), so those delete freely. An approved entry's money sits in
// the shul's pooled balance alongside every other approved payment with no
// way to prove which dollars a given applicant's allocation actually came
// from, so the safe rule is shul-wide: if this shul has ANY outstanding
// (not-yet-reversed) distribution at all, block the delete and offer to
// undo all of them first (POST again with confirmUndoAll: true) — once none
// remain (never happened, or already undone), deletion proceeds.
// Moves a payment — any method, card ones included — to a different shul.
// Gated by its own explicit-grant permission (shul_payment_transfer, see
// middleware/permissions.js), not the general shul_payments edit: it
// silently changes which shul's balance real money counts toward. Any
// refund rows linked to this payment (refund_of) move with it so the pair
// never straddles two shuls. Refused when the SOURCE shul has already given
// out more than it would have left without this payment — that would push
// its approved balance negative; the admin must Undo gives first.
router.put('/:id/transfer', requirePermission('shul_payment_transfer', 'can_edit'), (req, res) => {
  if (req.user.role === 'shul') return res.status(403).json({ error: 'Not permitted' });
  const payment = db.prepare('SELECT * FROM shul_payments WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!payment) return res.status(404).json({ error: 'Not found' });
  if (payment.refund_of) return res.status(400).json({ error: 'Move the original payment instead — its refund rows move with it.' });
  const { shul_id } = req.body || {};
  if (!shul_id || shul_id === payment.shul_id) return res.status(400).json({ error: 'Pick a different shul to move this to.' });
  const target = db.prepare('SELECT id, name_en FROM shuls WHERE id = ? AND org_id = ?').get(shul_id, req.user.org_id);
  if (!target) return res.status(404).json({ error: 'Shul not found' });
  if (payment.status === 'approved' && payment.direction === 'in') {
    const linkedNet = db.prepare(`SELECT COALESCE(SUM(net_amount),0) n FROM shul_payments WHERE refund_of = ? AND status = 'approved'`).get(payment.id).n;
    const remainingAfter = Math.round((approvedBalance(payment.shul_id) - payment.net_amount - linkedNet) * 100) / 100;
    if (remainingAfter < -1e-9) {
      return res.status(400).json({ error: `Can't move this: without it, the current shul would be $${Math.abs(remainingAfter).toFixed(2)} short of what it has already given out to applicants. Undo some of that shul's gives first.` });
    }
  }
  const from = db.prepare('SELECT name_en FROM shuls WHERE id = ?').get(payment.shul_id);
  const move = db.transaction(() => {
    db.prepare('UPDATE shul_payments SET shul_id = ? WHERE id = ? OR refund_of = ?').run(target.id, payment.id, payment.id);
  });
  move();
  const updated = db.prepare('SELECT * FROM shul_payments WHERE id = ?').get(payment.id);
  logAudit(req.user.org_id, req.user.id, 'transfer', 'shul_payment', payment.id, payment, { ...updated, moved_from: from?.name_en || payment.shul_id, moved_to: target.name_en }, req.ip);
  res.json({ ok: true, payment: updated, from: from?.name_en || null, to: target.name_en });
});

// Admin edit of a manually-entered payment (wire/check/cash/quickpay/other,
// in either direction). A real card transaction (sola_card/sola_refund/
// legacy stripe_card) is never editable — it moved real money through a
// processor, so the only honest changes to it are a full or partial Refund
// (POST /:id/refund) or the processing-fee override (PUT /:id/fee).
// net_amount is recomputed from the new amount minus the existing fee so
// services/shulBalance.js's SUM stays right without touching the fee.
router.put('/:id', requirePermission('shul_payments', 'can_edit'), (req, res) => {
  if (req.user.role === 'shul') return res.status(403).json({ error: 'Not permitted' });
  const payment = db.prepare('SELECT * FROM shul_payments WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!payment) return res.status(404).json({ error: 'Not found' });
  if (['sola_card', 'sola_refund', 'stripe_card'].includes(payment.method)) {
    return res.status(400).json({ error: 'A card transaction can\'t be edited — it charged/refunded a real card. Use Refund (full or partial) to reverse it instead.' });
  }
  const { method, amount, manual_date, manual_time, manual_ref, notes } = req.body || {};
  const newMethod = method ?? payment.method;
  if (newMethod !== payment.method && !isActiveManualMethod(req.user.org_id, newMethod)) return res.status(400).json({ error: 'That payment method is not currently offered — check Settings > Shul Payments.' });
  const gross = amount == null ? payment.amount : Math.abs(+amount);
  if (!(gross > 0)) return res.status(400).json({ error: 'Amount must be greater than $0' });
  if (payment.fee_amount > gross + 1e-9) return res.status(400).json({ error: `The existing fee ($${payment.fee_amount.toFixed(2)}) can't exceed the new amount ($${gross.toFixed(2)}) — lower the fee first.` });
  const net = Math.round((gross - payment.fee_amount) * 100) / 100;
  // direction 'out' rows (Pay Shul) are stored negative — keep that sign.
  const signedAmount = payment.direction === 'out' ? -gross : gross;
  const signedNet = payment.direction === 'out' ? -net : net;
  const date = manual_date ?? payment.manual_date, time = manual_time ?? payment.manual_time, ref = manual_ref ?? payment.manual_ref;
  if (!date || !time || !ref) return res.status(400).json({ error: 'Date, time, and Ref#/Check# are all required' });
  db.prepare(`UPDATE shul_payments SET method = ?, amount = ?, net_amount = ?, manual_date = ?, manual_time = ?, manual_ref = ?, notes = ? WHERE id = ?`)
    .run(newMethod, signedAmount, signedNet, date, time, ref, notes ?? payment.notes ?? '', payment.id);
  const updated = db.prepare('SELECT * FROM shul_payments WHERE id = ?').get(payment.id);
  logAudit(req.user.org_id, req.user.id, 'update', 'shul_payment', payment.id, payment, updated, req.ip);
  res.json({ ok: true, payment: updated });
});

router.delete('/:id', requirePermission('shul_payments', 'can_edit'), async (req, res) => {
  if (req.user.role === 'shul') return res.status(403).json({ error: 'Not permitted' });
  const payment = db.prepare('SELECT * FROM shul_payments WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!payment) return res.status(404).json({ error: 'Not found' });
  // A card transaction moved real money through a real processor — deleting
  // the row would just hide that it happened, not undo it. sola_card/
  // sola_refund go through POST /:id/refund (full or partial, actually
  // reverses the charge through Sola); a legacy stripe_card row has no live
  // refund path left in this app (see services/stripe.js) so any refund
  // that happened directly through Stripe's own dashboard gets recorded via
  // Pay Shul instead, same as any other non-card method.
  if (payment.method === 'sola_card' || payment.method === 'sola_refund') {
    return res.status(400).json({ error: 'A card transaction can\'t be deleted — it charged/refunded a real card. Use Refund instead to reverse it (full or partial).' });
  }
  if (payment.method === 'stripe_card') {
    return res.status(400).json({ error: 'A legacy Stripe card payment can\'t be deleted — it charged a real card. Use Pay Shul to record any refund that happened directly through Stripe.' });
  }

  const deleteRow = () => {
    logAudit(req.user.org_id, req.user.id, 'delete', 'shul_payment', payment.id, payment, null, req.ip);
    db.prepare('DELETE FROM shul_payments WHERE id = ?').run(payment.id);
  };

  if (payment.status !== 'approved') { deleteRow(); return res.json({ ok: true, undone: 0 }); }

  // Only pull money back off cards if this shul's OTHER approved payments
  // can no longer cover what's already been given out. Removing one
  // payment used to unconditionally undo EVERY outstanding allocation this
  // shul ever made, even when the shul had plenty of other money on file —
  // e.g. a shul with two $1,000 wire payments and $1,000 already given to
  // one applicant would have that applicant's card wiped out just for
  // deleting a duplicate/mistaken SECOND payment, despite the first
  // payment alone still covering the full amount given. Recomputed exactly
  // like services/shulBalance.js's approvedBalance, just excluding this
  // one payment from the "paid in" side.
  const paidExcludingThis = db.prepare(`SELECT COALESCE(SUM(net_amount),0) t FROM shul_payments WHERE shul_id = ? AND status = 'approved' AND id != ?`).get(payment.shul_id, payment.id).t;
  const given = db.prepare(`SELECT COALESCE(SUM(base_amount),0) t FROM shul_allocations WHERE shul_id = ?`).get(payment.shul_id).t;
  const balanceAfterRemoval = Math.round((paidExcludingThis - given) * 100) / 100;
  if (balanceAfterRemoval >= -0.005) { deleteRow(); return res.json({ ok: true, undone: 0 }); }

  const activeAllocations = db.prepare(`SELECT sa.*, a.first_name, a.last_name FROM shul_allocations sa
    LEFT JOIN applicants a ON a.id = sa.applicant_id
    WHERE sa.shul_id = ? AND sa.reversed_at IS NULL AND sa.reversal_of IS NULL`).all(payment.shul_id);

  if (!activeAllocations.length) { deleteRow(); return res.json({ ok: true, undone: 0 }); }

  // resolutions: { [allocationId]: { shulAmount, orgWriteoffAmount, note } }
  // — an admin's explicit per-allocation split, from the "review before
  // undoing" modal below. Omitted (old confirmUndoAll:true, or no
  // resolution supplied for a given allocation) falls back to the original
  // behavior for that allocation: pull everything retrievable, all of it
  // credited to the shul, nothing written off — see reverseAllocation's own
  // default-preserving comment.
  const { resolutions } = req.body || {};
  if (!resolutions && !req.body?.confirmUndoAll) {
    // Preview (the 409): live-reads "how much is left in the account" for
    // EVERY active allocation up front — never a cached/guessed number, per
    // the same "always ask disccardpromos live" rule the rest of this
    // app's money code already follows — so the admin sees the real
    // numbers before choosing anything, not just the original give amount.
    const previews = [];
    for (const a of activeAllocations) {
      const applicant_name = `${a.first_name || ''} ${a.last_name || ''}`.trim();
      try {
        const { retrievable } = await computeRetrievable(req.user.org_id, a.id);
        previews.push({ id: a.id, applicant_id: a.applicant_id, applicant_name, total_amount: a.total_amount, base_amount: a.base_amount, match_amount: a.match_amount, retrievable });
      } catch (e) {
        previews.push({ id: a.id, applicant_id: a.applicant_id, applicant_name, total_amount: a.total_amount, base_amount: a.base_amount, match_amount: a.match_amount, retrievable: null, error: e.message });
      }
    }
    return res.status(409).json({
      error: `Deleting this payment leaves this shul short by $${(-balanceAfterRemoval).toFixed(2)} — their other approved payments no longer cover everything already given out, so ${activeAllocations.length} outstanding distribution(s) must be reviewed first.`,
      requiresUndoAll: true,
      shortfall: -balanceAfterRemoval,
      activeAllocations: previews,
    });
  }

  const failures = [];
  for (const alloc of activeAllocations) {
    const applicant_name = `${alloc.first_name || ''} ${alloc.last_name || ''}`.trim();
    const resolution = resolutions?.[alloc.id];
    try {
      await reverseAllocation({
        orgId: req.user.org_id, userId: req.user.id, allocationId: alloc.id, ip: req.ip,
        shulAmount: resolution?.shulAmount, orgWriteoffAmount: resolution?.orgWriteoffAmount, adminReversalNote: resolution?.note,
      });
    }
    catch (e) { failures.push({ id: alloc.id, applicant_name, error: e.message }); }
  }
  if (failures.length) {
    return res.status(500).json({ error: 'Some distributions could not be undone, so the payment was not deleted. Any that did succeed stay undone — retry to finish the rest.', failures });
  }
  deleteRow();
  res.json({ ok: true, undone: activeAllocations.length });
});

router.get('/method-requests', (req, res) => {
  if (req.user.role === 'shul') return res.status(403).json({ error: 'Not permitted' });
  const rows = db.prepare(`SELECT r.*, s.name_en as shul_name FROM shul_payment_method_requests r
    LEFT JOIN shuls s ON s.id = r.shul_id WHERE r.org_id = ? ORDER BY r.created_at DESC`).all(req.user.org_id);
  res.json({ requests: rows });
});

export default router;
