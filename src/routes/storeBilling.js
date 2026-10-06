import { Router } from 'express';
import multer from 'multer';
import { join } from 'path';
import { writeFileSync } from 'fs';
import { db, uuid, DATA_DIR } from '../db.js';
import { requirePermission } from '../middleware/permissions.js';
import { auth } from '../middleware/auth.js';
import { sendMailChecked, renderSystemTemplate } from '../services/mail.js';
import { normalizePhone } from '../utils/phone.js';
import { logAudit } from '../services/audit.js';

const router = Router();
const invoiceUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
// Same directory the old bare-bones flow already used (and db.js already
// creates on boot) — these are the same underlying store_bill_submissions
// rows, just a richer flow around them, not a new kind of file.
const BILLS_DIR = join(DATA_DIR, 'store-bills');

router.use(auth);

function periodLabel(startDate, endDate) {
  const fmt = (d) => { try { return new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }); } catch { return d; } };
  return `${fmt(startDate)} – ${fmt(endDate)}`;
}
function substitute(text, vars) {
  return String(text).replace(/\{\{(\w+)\}\}/g, (m, k) => (vars[k] != null ? vars[k] : m));
}
function randomCode8() {
  return String(Math.floor(Math.random() * 1e8)).padStart(8, '0');
}
function maskEmail(email) {
  const [user, domain] = String(email || '').split('@');
  if (!domain) return email || '';
  return `${user.slice(0, 2)}${'*'.repeat(Math.max(1, user.length - 2))}@${domain}`;
}

// A consumed (code-verified) row for 'invoice_submit' tied to THIS login's
// own JWT iat is enough to let every invoice in that same session through
// without asking again — see middleware/auth.js's req.tokenIat. A fresh
// login gets a fresh iat and has to verify again.
function hasVerifiedThisSession(storeId, tokenIat) {
  if (!tokenIat) return false;
  return !!db.prepare(`SELECT 1 FROM billing_verification_codes WHERE store_id = ? AND purpose = 'invoice_submit' AND session_iat = ? AND consumed_at IS NOT NULL`).get(storeId, tokenIat);
}
// Spends a single confirmed code for one specific action (payment-info save,
// or an invoice_submit's first use in a session) — never reusable afterward,
// and only valid for 30 minutes after it was confirmed (not after it was sent).
function useVerification(storeId, purpose, verificationId) {
  if (!verificationId) return false;
  const row = db.prepare(`SELECT * FROM billing_verification_codes WHERE id = ? AND store_id = ? AND purpose = ?`).get(verificationId, storeId, purpose);
  if (!row || !row.consumed_at || row.used_at) return false;
  const consumedMs = Date.parse(row.consumed_at.replace(' ', 'T') + 'Z');
  if (!consumedMs || consumedMs < Date.now() - 30 * 60 * 1000) return false;
  db.prepare(`UPDATE billing_verification_codes SET used_at = datetime('now') WHERE id = ?`).run(row.id);
  return true;
}
function maskPaymentInfo(row) {
  if (!row) return null;
  return {
    bank_name: row.bank_name, name_on_account: row.name_on_account,
    address: row.address, city: row.city, state: row.state, zip: row.zip, place_id: row.place_id,
    contact_name: row.contact_name, contact_cell: row.contact_cell,
    account_last4: (row.account_number || '').slice(-4), routing_last4: (row.routing_number || '').slice(-4),
    updated_at: row.updated_at,
  };
}

// =====================================================================
// Store-portal side — a store managing its own payment info and invoices.
// Manual role checks (not requirePermission) because 'stores' permission's
// ROLE_DEFAULTS.store has can_edit:0 — the pre-existing bill-submissions
// routes in stores.js use this exact same manual-check pattern for the same
// reason.
// =====================================================================

router.get('/my/status', async (req, res) => {
  if (req.user.role !== 'store') return res.status(403).json({ error: 'Store portal only' });
  const paymentInfo = db.prepare('SELECT * FROM store_payment_info WHERE store_id = ?').get(req.user.store_id);
  const invites = db.prepare(`SELECT bp.id, bp.start_date, bp.end_date, bp.created_at,
      EXISTS(SELECT 1 FROM store_bill_submissions b WHERE b.billing_period_id = bp.id AND b.store_id = ?) AS submitted
    FROM billing_period_invites bpi JOIN billing_periods bp ON bp.id = bpi.billing_period_id
    WHERE bpi.store_id = ? ORDER BY bp.start_date DESC`).all(req.user.store_id, req.user.store_id);
  const settings = Object.fromEntries(db.prepare(`SELECT key, value FROM settings WHERE org_id = ? AND key IN ('store_billing_tax_id','store_billing_legal_name')`).all(req.user.org_id).map(r => [r.key, r.value]));
  res.json({
    hasPaymentInfo: !!paymentInfo,
    paymentInfo: maskPaymentInfo(paymentInfo),
    invoiceVerifiedThisSession: hasVerifiedThisSession(req.user.store_id, req.tokenIat),
    periods: invites.map(p => ({ id: p.id, start_date: p.start_date, end_date: p.end_date, label: periodLabel(p.start_date, p.end_date), submitted: !!p.submitted })),
    taxId: settings.store_billing_tax_id || '',
    legalName: settings.store_billing_legal_name || '',
  });
});

router.post('/verify/start', async (req, res) => {
  if (req.user.role !== 'store') return res.status(403).json({ error: 'Store portal only' });
  const { purpose } = req.body || {};
  if (!['payment_info', 'invoice_submit'].includes(purpose)) return res.status(400).json({ error: 'Invalid purpose' });
  const code = randomCode8();
  const id = uuid();
  db.prepare(`INSERT INTO billing_verification_codes (id, org_id, store_id, purpose, code, email, session_iat, expires_at)
    VALUES (?,?,?,?,?,?,?, datetime('now', '+10 minutes'))`)
    .run(id, req.user.org_id, req.user.store_id, purpose, code, req.user.email, req.tokenIat || null);
  const purposeText = purpose === 'payment_info' ? 'set up or update your payment information' : 'submit your invoice';
  const tmpl = renderSystemTemplate(req.user.org_id, 'billingVerificationCode', { code, purposeText });
  const { emailError } = await sendMailChecked(req.user.org_id, req.user.email, tmpl.subject, tmpl.body, { replyTo: tmpl.replyTo, relatedEntityType: 'store', relatedEntityId: req.user.store_id, sentBy: req.user.id });
  res.json({ ok: true, sentTo: maskEmail(req.user.email), emailError });
});

router.post('/verify/confirm', (req, res) => {
  if (req.user.role !== 'store') return res.status(403).json({ error: 'Store portal only' });
  const { purpose, code } = req.body || {};
  const row = db.prepare(`SELECT * FROM billing_verification_codes WHERE store_id = ? AND purpose = ? AND code = ? AND consumed_at IS NULL AND expires_at > datetime('now') ORDER BY created_at DESC LIMIT 1`)
    .get(req.user.store_id, purpose, String(code || '').trim());
  if (!row) return res.status(400).json({ error: 'That code is incorrect or has expired.' });
  db.prepare(`UPDATE billing_verification_codes SET consumed_at = datetime('now') WHERE id = ?`).run(row.id);
  res.json({ ok: true, verificationId: row.id });
});

router.post('/payment-info', (req, res) => {
  if (req.user.role !== 'store') return res.status(403).json({ error: 'Store portal only' });
  const b = req.body || {};
  const required = ['bank_name', 'name_on_account', 'address', 'city', 'state', 'zip', 'contact_name', 'contact_cell', 'account_number', 'account_number_confirm', 'routing_number'];
  for (const f of required) {
    if (!String(b[f] || '').trim()) return res.status(400).json({ error: `${f.replace(/_/g, ' ')} is required` });
  }
  if (String(b.account_number).trim() !== String(b.account_number_confirm).trim()) return res.status(400).json({ error: 'Account numbers do not match.' });
  if (!/^\d{4,17}$/.test(b.account_number)) return res.status(400).json({ error: 'Enter a valid account number (digits only).' });
  if (!/^\d{9}$/.test(b.routing_number)) return res.status(400).json({ error: 'Routing number must be exactly 9 digits.' });
  // Spent only once every other validation has already passed — a typo'd
  // field (e.g. mismatched account numbers) must be fixable by resubmitting
  // the SAME form without burning the verification code and forcing the
  // whole email-code dance over again for a one-character fix.
  if (!useVerification(req.user.store_id, 'payment_info', b.verificationId)) {
    return res.status(400).json({ error: 'Please verify your email before saving payment information.', code: 'VERIFICATION_REQUIRED' });
  }
  const existing = db.prepare('SELECT id FROM store_payment_info WHERE store_id = ?').get(req.user.store_id);
  db.prepare(`INSERT INTO store_payment_info (id, org_id, store_id, bank_name, name_on_account, address, city, state, zip, place_id, contact_name, contact_cell, account_number, routing_number)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(store_id) DO UPDATE SET bank_name=excluded.bank_name, name_on_account=excluded.name_on_account, address=excluded.address,
      city=excluded.city, state=excluded.state, zip=excluded.zip, place_id=excluded.place_id, contact_name=excluded.contact_name,
      contact_cell=excluded.contact_cell, account_number=excluded.account_number, routing_number=excluded.routing_number, updated_at=datetime('now')`)
    .run(existing?.id || uuid(), req.user.org_id, req.user.store_id, b.bank_name.trim(), b.name_on_account.trim(), b.address.trim(), b.city.trim(), b.state.trim(), b.zip.trim(),
      b.place_id || null, b.contact_name.trim(), normalizePhone(b.contact_cell), b.account_number.trim(), b.routing_number.trim());
  logAudit(req.user.org_id, req.user.id, existing ? 'update_payment_info' : 'create_payment_info', 'store', req.user.store_id, null, { bank_name: b.bank_name }, req.ip);
  res.json({ ok: true });
});

router.get('/my/invoices', (req, res) => {
  if (req.user.role !== 'store') return res.status(403).json({ error: 'Store portal only' });
  const bills = db.prepare(`SELECT b.*, bp.start_date AS period_start, bp.end_date AS period_end FROM store_bill_submissions b
    LEFT JOIN billing_periods bp ON bp.id = b.billing_period_id WHERE b.store_id = ? ORDER BY b.submitted_at DESC`).all(req.user.store_id);
  res.json({ bills: bills.map(b => ({ ...b, period_label: b.period_start ? periodLabel(b.period_start, b.period_end) : (b.period || '') })) });
});

router.post('/my/invoices', invoiceUpload.single('file'), async (req, res) => {
  if (req.user.role !== 'store') return res.status(403).json({ error: 'Store portal only' });
  const store = db.prepare('SELECT * FROM stores WHERE id = ?').get(req.user.store_id);
  const paymentInfo = db.prepare('SELECT * FROM store_payment_info WHERE store_id = ?').get(req.user.store_id);
  if (!paymentInfo) return res.status(400).json({ error: 'Please complete your payment information before submitting an invoice.', code: 'PAYMENT_INFO_REQUIRED' });
  const b = req.body || {};
  if (!hasVerifiedThisSession(req.user.store_id, req.tokenIat) && !useVerification(req.user.store_id, 'invoice_submit', b.verificationId)) {
    return res.status(400).json({ error: 'Please verify your email before submitting.', code: 'VERIFICATION_REQUIRED' });
  }
  const amountNum = +b.amount;
  if (!amountNum || amountNum <= 0) return res.status(400).json({ error: 'A valid amount is required' });
  if (!['1', 'true', true].includes(b.period_confirmed)) return res.status(400).json({ error: 'Please confirm this invoice matches the billing period.' });
  let billingPeriod = null;
  if (b.billing_period_id) {
    billingPeriod = db.prepare(`SELECT bp.* FROM billing_periods bp JOIN billing_period_invites bpi ON bpi.billing_period_id = bp.id WHERE bp.id = ? AND bpi.store_id = ?`).get(b.billing_period_id, req.user.store_id);
    if (!billingPeriod) return res.status(400).json({ error: 'Billing period not found for this store.' });
  }
  const id = uuid();
  let filePath = null, fileName = null;
  if (req.file) {
    fileName = req.file.originalname;
    const safeName = `${id}-${fileName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    writeFileSync(join(BILLS_DIR, safeName), req.file.buffer);
    filePath = safeName;
  } else {
    return res.status(400).json({ error: 'Please attach your invoice (image, PDF, Excel, or CSV).' });
  }
  const period = billingPeriod ? periodLabel(billingPeriod.start_date, billingPeriod.end_date) : '';
  db.prepare(`INSERT INTO store_bill_submissions (id, org_id, store_id, billing_period_id, period, period_confirmed, amount, description, file_path, file_name, status)
    VALUES (?,?,?,?,?,1,?,?,?,?,'pending')`)
    .run(id, req.user.org_id, store.id, billingPeriod?.id || null, period, amountNum, b.description || '', filePath, fileName);
  const submittedAt = new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  const amountFmt = '$' + amountNum.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const toStore = renderSystemTemplate(req.user.org_id, 'storeInvoiceSubmitted', { storeName: store.name, amount: amountFmt, period: period || 'N/A', submittedAt });
  await sendMailChecked(req.user.org_id, req.user.email, toStore.subject, toStore.body, { replyTo: toStore.replyTo, relatedEntityType: 'store', relatedEntityId: store.id, sentBy: req.user.id });

  const notifyTo = db.prepare(`SELECT value FROM settings WHERE org_id = ? AND key = 'store_billing_notify_email'`).get(req.user.org_id)?.value;
  if (notifyTo) {
    const invoiceUrl = `${process.env.APP_URL || ''}/admin/store-billing?invoice=${id}`;
    const toAdmin = renderSystemTemplate(req.user.org_id, 'storeInvoiceReceivedNotice', { storeName: store.name, amount: amountFmt, period: period || 'N/A', invoiceUrl });
    for (const to of notifyTo.split(',').map(s => s.trim()).filter(Boolean)) {
      await sendMailChecked(req.user.org_id, to, toAdmin.subject, toAdmin.body, { relatedEntityType: 'store', relatedEntityId: store.id });
    }
  }
  logAudit(req.user.org_id, req.user.id, 'submit_invoice', 'store', store.id, null, { amount: amountNum, period }, req.ip);
  res.status(201).json({ bill: db.prepare('SELECT * FROM store_bill_submissions WHERE id = ?').get(id) });
});

router.get('/my/invoices/:billId/file', (req, res) => {
  const row = db.prepare('SELECT * FROM store_bill_submissions WHERE id = ?').get(req.params.billId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (req.user.role === 'store' && row.store_id !== req.user.store_id) return res.status(403).json({ error: 'Not your invoice' });
  if (!row.file_path) return res.status(404).json({ error: 'No file attached' });
  res.download(join(BILLS_DIR, row.file_path), row.file_name || 'invoice');
});

// =====================================================================
// Admin side — issuing billing-period emails and reviewing invoices.
// =====================================================================

router.get('/periods', requirePermission('store_billing'), (req, res) => {
  const periods = db.prepare(`SELECT bp.*,
      (SELECT COUNT(*) FROM billing_period_invites WHERE billing_period_id = bp.id) AS invited_count,
      (SELECT COUNT(*) FROM store_bill_submissions WHERE billing_period_id = bp.id) AS submitted_count
    FROM billing_periods bp WHERE bp.org_id = ? ORDER BY bp.created_at DESC`).all(req.user.org_id);
  res.json({ periods: periods.map(p => ({ ...p, label: periodLabel(p.start_date, p.end_date) })) });
});

router.post('/periods', requirePermission('store_billing', 'can_edit'), async (req, res) => {
  const { start_date, end_date, email_subject, email_body, store_ids } = req.body || {};
  if (!start_date || !end_date) return res.status(400).json({ error: 'Start and end date are required' });
  if (!email_subject || !email_body) return res.status(400).json({ error: 'Email subject and body are required' });
  if (!Array.isArray(store_ids) || !store_ids.length) return res.status(400).json({ error: 'Select at least one store' });
  const id = uuid();
  db.prepare(`INSERT INTO billing_periods (id, org_id, start_date, end_date, email_subject, email_body, created_by) VALUES (?,?,?,?,?,?,?)`)
    .run(id, req.user.org_id, start_date, end_date, email_subject, email_body, req.user.id);
  let sent = 0, failed = 0, skipped = 0;
  const label = periodLabel(start_date, end_date);
  for (const storeId of store_ids) {
    const store = db.prepare(`SELECT s.*, u.email AS login_email FROM stores s LEFT JOIN users u ON u.id = s.portal_user_id WHERE s.id = ? AND s.org_id = ? AND s.setup_status = 'active'`).get(storeId, req.user.org_id);
    if (!store || !store.login_email) { skipped++; continue; }
    const portalUrl = `${process.env.APP_URL || ''}/store-portal/billing`;
    const subject = substitute(email_subject, { storeName: store.name, startDate: start_date, endDate: end_date, period: label, portalUrl });
    const body = substitute(email_body, { storeName: store.name, startDate: start_date, endDate: end_date, period: label, portalUrl });
    const { emailError } = await sendMailChecked(req.user.org_id, store.login_email, subject, body, { relatedEntityType: 'store', relatedEntityId: store.id, sentBy: req.user.id });
    db.prepare(`INSERT INTO billing_period_invites (id, billing_period_id, store_id, email_status) VALUES (?,?,?,?)`)
      .run(uuid(), id, store.id, emailError ? 'failed' : 'sent');
    if (emailError) failed++; else sent++;
  }
  logAudit(req.user.org_id, req.user.id, 'create', 'billing_period', id, null, { start_date, end_date, sent, failed, skipped }, req.ip);
  res.status(201).json({ period: db.prepare('SELECT * FROM billing_periods WHERE id = ?').get(id), sent, failed, skipped });
});

router.get('/periods/:id', requirePermission('store_billing'), (req, res) => {
  const period = db.prepare('SELECT * FROM billing_periods WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!period) return res.status(404).json({ error: 'Not found' });
  const invited = db.prepare(`SELECT bpi.*, s.name AS store_name,
      EXISTS(SELECT 1 FROM store_bill_submissions b WHERE b.billing_period_id = bpi.billing_period_id AND b.store_id = bpi.store_id) AS submitted
    FROM billing_period_invites bpi JOIN stores s ON s.id = bpi.store_id WHERE bpi.billing_period_id = ? ORDER BY s.name`).all(period.id);
  res.json({ period: { ...period, label: periodLabel(period.start_date, period.end_date) }, invited });
});

router.get('/invoices', requirePermission('store_billing'), (req, res) => {
  const { status } = req.query;
  let where = 'b.org_id = ?';
  const params = [req.user.org_id];
  if (status) { where += ' AND b.status = ?'; params.push(status); }
  const bills = db.prepare(`SELECT b.*, s.name AS store_name, bp.start_date AS period_start, bp.end_date AS period_end
    FROM store_bill_submissions b JOIN stores s ON s.id = b.store_id LEFT JOIN billing_periods bp ON bp.id = b.billing_period_id
    WHERE ${where} ORDER BY b.submitted_at DESC`).all(...params);
  res.json({ bills: bills.map(b => ({ ...b, period_label: b.period_start ? periodLabel(b.period_start, b.period_end) : (b.period || '') })) });
});

router.get('/invoices/:id', requirePermission('store_billing'), (req, res) => {
  const bill = db.prepare(`SELECT b.*, s.name AS store_name FROM store_bill_submissions b JOIN stores s ON s.id = b.store_id WHERE b.id = ? AND b.org_id = ?`).get(req.params.id, req.user.org_id);
  if (!bill) return res.status(404).json({ error: 'Not found' });
  const paymentInfo = db.prepare('SELECT * FROM store_payment_info WHERE store_id = ?').get(bill.store_id);
  res.json({ bill, paymentInfo: maskPaymentInfo(paymentInfo) });
});

// Full, unmasked account/routing numbers — only when an admin is actually
// about to send a real payment, same tighter super_admin/org_admin-only
// gate applicants.js's "View Live Disccardpromos Data" uses for a similarly
// sensitive reveal, plus an audit row recording who looked.
router.get('/stores/:storeId/payment-info/reveal', requirePermission('store_billing'), (req, res) => {
  if (!['super_admin', 'org_admin'].includes(req.user.role)) return res.status(403).json({ error: 'Not permitted' });
  const row = db.prepare('SELECT pi.* FROM store_payment_info pi JOIN stores s ON s.id = pi.store_id WHERE pi.store_id = ? AND s.org_id = ?').get(req.params.storeId, req.user.org_id);
  if (!row) return res.status(404).json({ error: 'No payment information on file' });
  logAudit(req.user.org_id, req.user.id, 'reveal_payment_info', 'store', req.params.storeId, null, null, req.ip);
  res.json({ paymentInfo: row });
});

router.post('/invoices/:id/reject', requirePermission('store_billing', 'can_edit'), (req, res) => {
  const bill = db.prepare('SELECT * FROM store_bill_submissions WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!bill) return res.status(404).json({ error: 'Not found' });
  if (bill.status === 'completed') return res.status(400).json({ error: 'This invoice has already been paid and cannot be rejected.' });
  const { reason } = req.body || {};
  db.prepare(`UPDATE store_bill_submissions SET status = 'rejected', rejection_reason = ?, reviewed_at = datetime('now') WHERE id = ?`).run(reason || '', bill.id);
  logAudit(req.user.org_id, req.user.id, 'reject_invoice', 'store', bill.store_id, { status: bill.status }, { status: 'rejected', reason }, req.ip);
  res.json({ bill: db.prepare('SELECT * FROM store_bill_submissions WHERE id = ?').get(bill.id) });
});

router.post('/invoices/:id/complete', requirePermission('store_billing', 'can_edit'), async (req, res) => {
  const bill = db.prepare(`SELECT b.*, s.name AS store_name FROM store_bill_submissions b JOIN stores s ON s.id = b.store_id WHERE b.id = ? AND b.org_id = ?`).get(req.params.id, req.user.org_id);
  if (!bill) return res.status(404).json({ error: 'Not found' });
  if (bill.status === 'completed') return res.status(400).json({ error: 'Already marked completed.' });
  const paymentInfo = db.prepare('SELECT * FROM store_payment_info WHERE store_id = ?').get(bill.store_id);
  if (!paymentInfo) return res.status(400).json({ error: 'This store has no payment information on file.' });
  const { payment_amount, payment_date } = req.body || {};
  const amountNum = +payment_amount;
  if (!amountNum || amountNum <= 0) return res.status(400).json({ error: 'A valid payment amount is required' });
  if (!payment_date) return res.status(400).json({ error: 'A payment date is required' });
  const last4 = (paymentInfo.account_number || '').slice(-4);
  db.prepare(`UPDATE store_bill_submissions SET status = 'completed', payment_amount = ?, payment_bank_name = ?, payment_account_last4 = ?, payment_sent_date = ?, reviewed_at = datetime('now') WHERE id = ?`)
    .run(amountNum, paymentInfo.bank_name, last4, payment_date, bill.id);
  const store = db.prepare('SELECT * FROM stores WHERE id = ?').get(bill.store_id);
  const storeUser = store?.portal_user_id ? db.prepare('SELECT email FROM users WHERE id = ?').get(store.portal_user_id) : null;
  if (storeUser?.email) {
    const amountFmt = '$' + amountNum.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const tmpl = renderSystemTemplate(req.user.org_id, 'storeInvoicePaymentSent', { storeName: bill.store_name, amount: amountFmt, bankName: paymentInfo.bank_name, last4, period: bill.period || 'N/A' });
    await sendMailChecked(req.user.org_id, storeUser.email, tmpl.subject, tmpl.body, { replyTo: tmpl.replyTo, relatedEntityType: 'store', relatedEntityId: bill.store_id, sentBy: req.user.id });
  }
  logAudit(req.user.org_id, req.user.id, 'complete_invoice_payment', 'store', bill.store_id, { status: bill.status }, { status: 'completed', payment_amount: amountNum, payment_date }, req.ip);
  res.json({ bill: db.prepare('SELECT * FROM store_bill_submissions WHERE id = ?').get(bill.id) });
});

router.get('/invoices/:id/file', requirePermission('store_billing'), (req, res) => {
  const row = db.prepare('SELECT * FROM store_bill_submissions WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (!row.file_path) return res.status(404).json({ error: 'No file attached' });
  res.download(join(BILLS_DIR, row.file_path), row.file_name || 'invoice');
});

export default router;
