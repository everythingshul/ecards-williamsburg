import { Router } from 'express';
import { db, uuid, DEFAULT_ORG_ID } from '../db.js';
import { auth } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import { pendingBalance, approvedBalance, shulBalances } from '../services/shulBalance.js';
import { createAllocation, reverseAllocation, shulDisplayMatch } from '../services/matching.js';
import * as stripePay from '../services/stripe.js';
import { notifyNewSignup } from '../services/mail.js';
import { logAudit } from '../services/audit.js';

const router = Router();

const MANUAL_METHODS = ['wire', 'quickpay', 'check', 'cash', 'other'];

// ============================= PUBLIC (Stripe only) =============================
// No auth — Stripe calls this directly. Registered before the auth gate
// below, same pattern as every other public route in this app.
// index.js's express.json({ verify }) stashes the exact raw bytes on
// req.rawBody, which the signature check needs (a re-serialized JSON body
// won't byte-for-byte match what Stripe signed).
router.post('/stripe/webhook', async (req, res) => {
  let event;
  try {
    event = stripePay.constructWebhookEvent(req.rawBody, req.headers['stripe-signature']);
  } catch (e) {
    console.error('[stripe] webhook signature verification failed:', e.message);
    return res.status(400).json({ error: 'Invalid signature' });
  }
  if (event.type !== 'payment_intent.succeeded') return res.json({ received: true });

  const intent = event.data.object;
  const { shulId, seasonId, orgId, userId } = intent.metadata || {};
  if (!shulId || !seasonId || !orgId) return res.json({ received: true });
  // Idempotent — Stripe retries webhook delivery, and this same event could
  // arrive more than once.
  const already = db.prepare('SELECT id FROM shul_payments WHERE stripe_payment_intent_id = ?').get(intent.id);
  if (already) return res.json({ received: true });

  const season = db.prepare('SELECT shul_pays_processing_fee FROM seasons WHERE id = ?').get(seasonId);
  const amount = intent.amount_received / 100;
  const fee = season?.shul_pays_processing_fee ? await stripePay.getPaymentIntentFee(intent.id).catch(() => 0) : 0;
  const netAmount = Math.round((amount - fee) * 100) / 100;

  const id = uuid();
  db.prepare(`INSERT INTO shul_payments (id, org_id, shul_id, season_id, method, amount, fee_amount, net_amount, status, stripe_payment_intent_id, entered_by)
    VALUES (?,?,?,?,'stripe_card',?,?,?,'pending_approval',?,?)`)
    .run(id, orgId, shulId, seasonId, amount, fee, netAmount, intent.id, userId || null);
  logAudit(orgId, userId || null, 'create', 'shul_payment', id, null, db.prepare('SELECT * FROM shul_payments WHERE id = ?').get(id), null);
  res.json({ received: true });
});

router.use(auth, requirePermission('shul_payments'));

// ============================= SHUL PORTAL (own shul only) =============================

router.get('/mine/balance', (req, res) => {
  if (req.user.role !== 'shul') return res.status(403).json({ error: 'Not permitted' });
  res.json(shulBalances(req.user.shul_id));
});

router.get('/mine', (req, res) => {
  if (req.user.role !== 'shul') return res.status(403).json({ error: 'Not permitted' });
  const rows = db.prepare(`SELECT id, method, amount, fee_amount, net_amount, status, manual_date, manual_ref, rejected_reason, created_at, approved_at
    FROM shul_payments WHERE shul_id = ? ORDER BY created_at DESC`).all(req.user.shul_id);
  res.json({ payments: rows });
});

// Public config a shul's payment page needs before it can render Stripe
// Elements at all: whether Stripe is enabled for them (org default,
// shul-level override) and the publishable key. No secret ever reaches here.
router.get('/mine/config', (req, res) => {
  if (req.user.role !== 'shul') return res.status(403).json({ error: 'Not permitted' });
  const shul = db.prepare('SELECT stripe_payments_enabled FROM shuls WHERE id = ?').get(req.user.shul_id);
  const orgDefault = db.prepare(`SELECT value FROM settings WHERE org_id = ? AND key = 'stripe_payments_enabled_default'`).get(req.user.org_id)?.value !== '0';
  const enabled = shul?.stripe_payments_enabled != null ? !!shul.stripe_payments_enabled : orgDefault;
  res.json({ stripeEnabled: enabled, publishableKey: stripePay.stripePublishableKey(), mockMode: stripePay.isStripeMockMode() });
});

router.post('/mine/stripe-intent', async (req, res) => {
  if (req.user.role !== 'shul') return res.status(403).json({ error: 'Not permitted' });
  const amount = +req.body?.amount;
  if (!(amount > 0)) return res.status(400).json({ error: 'Amount must be greater than $0' });
  const shul = db.prepare('SELECT stripe_payments_enabled, season_id FROM shuls WHERE id = ?').get(req.user.shul_id);
  const orgDefault = db.prepare(`SELECT value FROM settings WHERE org_id = ? AND key = 'stripe_payments_enabled_default'`).get(req.user.org_id)?.value !== '0';
  const enabled = shul?.stripe_payments_enabled != null ? !!shul.stripe_payments_enabled : orgDefault;
  if (!enabled) return res.status(403).json({ error: 'Online card payment is not enabled for your shul. Use "Request a Different Payment Method" instead.' });
  try {
    const intent = await stripePay.createPaymentIntent({
      amountCents: Math.round(amount * 100), shulId: req.user.shul_id, seasonId: shul.season_id, orgId: req.user.org_id, userId: req.user.id,
    });
    res.json({ clientSecret: intent.client_secret, mock: !!intent.mock });
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
  await notifyNewSignup(req.user.org_id, 'notify_payment_method_request_email', 'paymentMethodRequest', {
    shulName: shul?.name_en || 'A shul',
    requestedMethod: requested_method,
    message: message ? `<p>Message: ${esc(message)}</p>` : '',
  });
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
  res.json(stripePay.stripeConfigStatus());
});

// Manual entry is inherently admin-vetted (an admin is the one typing it
// in, having already confirmed the money was actually received) — it goes
// straight to 'approved', unlike a shul's own Stripe payment which always
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

router.get('/method-requests', (req, res) => {
  if (req.user.role === 'shul') return res.status(403).json({ error: 'Not permitted' });
  const rows = db.prepare(`SELECT r.*, s.name_en as shul_name FROM shul_payment_method_requests r
    LEFT JOIN shuls s ON s.id = r.shul_id WHERE r.org_id = ? ORDER BY r.created_at DESC`).all(req.user.org_id);
  res.json({ requests: rows });
});

export default router;
