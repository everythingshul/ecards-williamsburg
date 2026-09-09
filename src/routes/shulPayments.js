import { Router } from 'express';
import { db, uuid, DEFAULT_ORG_ID } from '../db.js';
import { auth } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import { pendingBalance, approvedBalance, shulBalances } from '../services/shulBalance.js';
import { createAllocation, reverseAllocation, shulDisplayMatch } from '../services/matching.js';
import * as solaPay from '../services/sola.js';
import { notifyNewSignup } from '../services/mail.js';
import { logAudit } from '../services/audit.js';

const router = Router();

const MANUAL_METHODS = ['wire', 'quickpay', 'check', 'cash', 'other'];

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
  res.json({ solaEnabled: enabled, mockMode: solaPay.isSolaMockMode() });
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
  const amount = +req.body?.amount;
  // Stripped/normalized here too (not just client-side) since this is a
  // tampered/direct-API-call concern, not a normal-use one — the shul
  // portal's own form already sends these clean.
  const xCardNum = String(req.body?.xCardNum || '').replace(/\s/g, '');
  const xCVV = String(req.body?.xCVV || '').trim();
  const xZip = String(req.body?.xZip || '').trim();
  const xExp = String(req.body?.xExp || '').replace(/\D/g, '');
  if (!(amount > 0)) return res.status(400).json({ error: 'Amount must be greater than $0' });
  const shul = db.prepare('SELECT stripe_payments_enabled, season_id, name_en FROM shuls WHERE id = ?').get(req.user.shul_id);
  const orgDefault = db.prepare(`SELECT value FROM settings WHERE org_id = ? AND key = 'sola_payments_enabled_default'`).get(req.user.org_id)?.value !== '0';
  const enabled = shul?.stripe_payments_enabled != null ? !!shul.stripe_payments_enabled : orgDefault;
  if (!enabled) return res.status(403).json({ error: 'Online card payment is not enabled for your shul. Use "Request a Different Payment Method" instead.' });
  if (!solaPay.isSolaMockMode()) {
    if (!xCardNum || !xCVV) return res.status(400).json({ error: 'Card details are required' });
    if (xExp.length !== 4) return res.status(400).json({ error: 'Expiration date is required' });
  }
  try {
    const result = await solaPay.chargeSale({
      amount, xCardNum, xCVV, xExp, xZip, xName: shul.name_en || '', xEmail: req.user.email || '',
      invoice: `${shul.name_en || 'shul'}-${Date.now()}`, comments: 'eCards shul payment',
    });
    if (!result.approved) return res.status(400).json({ error: result.error || 'Card declined' });
    const id = uuid();
    db.prepare(`INSERT INTO shul_payments (id, org_id, shul_id, season_id, method, amount, fee_amount, net_amount, status, sola_ref_num, card_last4, entered_by)
      VALUES (?,?,?,?,'sola_card',?,0,?,'pending_approval',?,?,?)`)
      .run(id, req.user.org_id, req.user.shul_id, shul.season_id, amount, amount, result.refNum, result.last4 || null, req.user.id);
    logAudit(req.user.org_id, req.user.id, 'create', 'shul_payment', id, null, db.prepare('SELECT * FROM shul_payments WHERE id = ?').get(id), req.ip);
    res.json({ ok: true, mock: !!result.mock });
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
    return {
      id: r.id, applicant_id: r.applicant_id, applicant_name: `${r.first_name || ''} ${r.last_name || ''}`.trim(),
      base_amount: r.base_amount, display_total: Math.round((r.base_amount + displayMatch) * 100) / 100,
      created_at: r.created_at, reversed: !!r.reversed_at,
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
    res.status(201).json({ ok: true, allocation: { id: row.id, base_amount: row.base_amount } });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ============================= ADMIN =============================

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
  res.json(solaPay.solaConfigStatus());
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
  if (!MANUAL_METHODS.includes(method)) return res.status(400).json({ error: `method must be one of: ${MANUAL_METHODS.join(', ')}` });
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
  if (!MANUAL_METHODS.includes(method)) return res.status(400).json({ error: `method must be one of: ${MANUAL_METHODS.join(', ')}` });
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
// fee_amount is NEVER backed out here — see services/sola.js's file-level
// comment on why fee_amount stays 0 for sola_card rows for now, and more
// generally: even where a real fee IS known (a legacy stripe_card row),
// refunding the principal never gets the processor's cut back either. The
// notes on the refund row spell this out explicitly so it isn't a silent
// surprise the next time someone reconciles the shul's balance.
router.post('/:id/refund', requirePermission('shul_payments', 'can_edit'), async (req, res) => {
  if (req.user.role === 'shul') return res.status(403).json({ error: 'Not permitted' });
  const payment = db.prepare('SELECT * FROM shul_payments WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!payment) return res.status(404).json({ error: 'Not found' });
  if (payment.direction !== 'in' || payment.status !== 'approved') return res.status(400).json({ error: 'Only an approved payment can be refunded' });
  if (payment.method !== 'sola_card' || !payment.sola_ref_num) return res.status(400).json({ error: 'Only a Sola card payment can be refunded here — for any other method, use Pay Shul to record money sent back manually.' });

  const alreadyRefunded = db.prepare(`SELECT COALESCE(SUM(-net_amount),0) t FROM shul_payments WHERE refund_of = ?`).get(payment.id).t;
  const refundable = Math.round((payment.amount - alreadyRefunded) * 100) / 100;
  const amount = +req.body?.amount;
  if (!(amount > 0)) return res.status(400).json({ error: 'Amount must be greater than $0' });
  if (amount > refundable + 1e-9) return res.status(400).json({ error: `Amount ($${amount.toFixed(2)}) exceeds what's left to refund on this payment ($${refundable.toFixed(2)}).` });

  try {
    const result = await solaPay.refundTransaction({ refNum: payment.sola_ref_num, amount });
    if (!result.approved) return res.status(400).json({ error: result.error || 'Refund failed' });
    const feeNote = payment.fee_amount > 0
      ? ` Note for admin: this payment had a $${payment.fee_amount.toFixed(2)} processing fee that is NOT automatically refunded/removed from the shul's balance — only the $${amount.toFixed(2)} principal is reflected here.`
      : '';
    const id = uuid();
    db.prepare(`INSERT INTO shul_payments (id, org_id, shul_id, season_id, method, amount, fee_amount, net_amount, status, direction, sola_ref_num, refund_of, entered_by, approved_by, approved_at, notes)
      VALUES (?,?,?,?,'sola_refund',?,0,?,'approved','out',?,?,?,?,datetime('now'),?)`)
      .run(id, req.user.org_id, payment.shul_id, payment.season_id, amount, -amount, result.refNum, payment.id, req.user.id, req.user.id, `Refund of payment ${payment.id}.${feeNote}`.trim());
    const row = db.prepare('SELECT * FROM shul_payments WHERE id = ?').get(id);
    logAudit(req.user.org_id, req.user.id, 'create', 'shul_payment', id, null, row, req.ip);
    res.status(201).json({ ok: true, payment: row, feeNote: feeNote || null });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/:id/approve', requirePermission('shul_payments', 'can_edit'), (req, res) => {
  if (req.user.role === 'shul') return res.status(403).json({ error: 'Not permitted' });
  const payment = db.prepare('SELECT * FROM shul_payments WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!payment) return res.status(404).json({ error: 'Not found' });
  if (payment.status !== 'pending_approval') return res.status(400).json({ error: `This payment is already ${payment.status}` });
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
router.delete('/:id', requirePermission('shul_payments', 'can_edit'), async (req, res) => {
  if (req.user.role === 'shul') return res.status(403).json({ error: 'Not permitted' });
  const payment = db.prepare('SELECT * FROM shul_payments WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!payment) return res.status(404).json({ error: 'Not found' });

  const deleteRow = () => {
    logAudit(req.user.org_id, req.user.id, 'delete', 'shul_payment', payment.id, payment, null, req.ip);
    db.prepare('DELETE FROM shul_payments WHERE id = ?').run(payment.id);
  };

  if (payment.status !== 'approved') { deleteRow(); return res.json({ ok: true, undone: 0 }); }

  const activeAllocations = db.prepare(`SELECT sa.*, a.first_name, a.last_name FROM shul_allocations sa
    LEFT JOIN applicants a ON a.id = sa.applicant_id
    WHERE sa.shul_id = ? AND sa.reversed_at IS NULL AND sa.reversal_of IS NULL`).all(payment.shul_id);

  if (!activeAllocations.length) { deleteRow(); return res.json({ ok: true, undone: 0 }); }

  if (!req.body?.confirmUndoAll) {
    return res.status(409).json({
      error: `This shul has already given out money to applicants — deleting this payment requires undoing all ${activeAllocations.length} outstanding distribution(s) first.`,
      requiresUndoAll: true,
      activeAllocations: activeAllocations.map(a => ({ id: a.id, applicant_name: `${a.first_name || ''} ${a.last_name || ''}`.trim(), total_amount: a.total_amount })),
    });
  }

  const failures = [];
  for (const alloc of activeAllocations) {
    try { await reverseAllocation({ orgId: req.user.org_id, userId: req.user.id, allocationId: alloc.id, ip: req.ip }); }
    catch (e) { failures.push({ id: alloc.id, applicant_name: `${alloc.first_name || ''} ${alloc.last_name || ''}`.trim(), error: e.message }); }
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
