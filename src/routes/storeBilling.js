import { Router } from 'express';
import multer from 'multer';
import { join } from 'path';
import { writeFileSync, unlinkSync, existsSync, readFileSync } from 'fs';
import { db, uuid, DATA_DIR } from '../db.js';
import { requirePermission } from '../middleware/permissions.js';
import { auth } from '../middleware/auth.js';
import { sendMailChecked, renderSystemTemplate, escapeHtml } from '../services/mail.js';
import { normalizePhone, isValidPhone } from '../utils/phone.js';
import { logAudit } from '../services/audit.js';
import { sendXlsx } from '../services/xlsx.js';
import { sanitizeEmailHtml, isBlankHtml } from '../utils/sanitizeEmailHtml.js';

const router = Router();
const invoiceUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
// Same directory the old bare-bones flow already used (and db.js already
// creates on boot) — these are the same underlying store_bill_submissions
// rows, just a richer flow around them, not a new kind of file.
const BILLS_DIR = join(DATA_DIR, 'store-bills');

router.use(auth);

// Bank picker list for the store portal's Payment Information form. The
// built-in list is read out of frontend/js/usbanks.js so there's exactly one
// copy of it; an admin can replace it from Settings > Organization > Store
// Billing > Bank List (stored as a JSON array under 'store_billing_banks';
// empty/malformed = built-in). "Other / Not Listed" is always forced to the
// end since it's what unlocks the free-text bank-name field on the form.
const OTHER_BANK = 'Other / Not Listed';
const DEFAULT_BANKS = (() => {
  try {
    const src = readFileSync(new URL('../../frontend/js/usbanks.js', import.meta.url), 'utf8');
    return new Function('return ' + src.match(/window\.US_BANKS\s*=\s*(\[[\s\S]*?\]);/)[1])();
  } catch (e) { console.error('[store-billing] could not read usbanks.js:', e.message); return []; }
})();
function getBanks(orgId) {
  let list = null;
  try { const v = db.prepare(`SELECT value FROM settings WHERE org_id = ? AND key = 'store_billing_banks'`).get(orgId)?.value; if (v) list = JSON.parse(v); } catch {}
  if (!Array.isArray(list) || !list.length) list = DEFAULT_BANKS;
  const clean = [...new Set(list.map(b => String(b).trim()).filter(b => b && b !== OTHER_BANK))];
  return [...clean, OTHER_BANK];
}
router.get('/banks', (req, res) => res.json({ banks: getBanks(req.user.org_id) }));

function periodLabel(startDate, endDate) {
  const fmt = (d) => { try { return new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }); } catch { return d; } };
  return `${fmt(startDate)} – ${fmt(endDate)}`;
}
function substitute(text, vars) {
  return String(text).replace(/\{\{(\w+)\}\}/g, (m, k) => (vars[k] != null ? vars[k] : m));
}
// ---------------------------------------------------------------------
// "Payment is on the way" emails: rich-text templates (one can be the
// default) with the invoice breakdown — invoice amount, processing fee,
// total sent — available as a {{breakdown}} block and as separate fields.
// ---------------------------------------------------------------------
const usd = (n) => '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const isoDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) && !Number.isNaN(Date.parse(d + 'T00:00:00Z')) && new Date(d + 'T00:00:00Z').toISOString().slice(0, 10) === d;
const longDate = (d) => { try { return new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }); } catch { return d || ''; } };

// The address a store's billing emails go to: its portal login, else the
// manager/owner email on the store record.
function storeContactEmail(storeId) {
  const s = db.prepare(`SELECT s.manager_email, s.owner_email, u.email AS login_email FROM stores s LEFT JOIN users u ON u.id = s.portal_user_id WHERE s.id = ?`).get(storeId);
  return s?.login_email || s?.manager_email || s?.owner_email || null;
}

// Fields an admin can drop into a payment email template (Insert Field menu).
export const PAYMENT_EMAIL_VARS = [
  { key: 'breakdown', label: 'Invoice breakdown (invoice − fee = total)' },
  { key: 'storeName', label: 'Store name' },
  { key: 'amount', label: 'Total sent' },
  { key: 'invoiceAmount', label: 'Invoice amount' },
  { key: 'feePercent', label: 'Processing fee %' },
  { key: 'feeAmount', label: 'Processing fee amount' },
  { key: 'period', label: 'Billing period' },
  { key: 'paymentDate', label: 'Date sent' },
  { key: 'bankName', label: 'Bank name' },
  { key: 'last4', label: 'Account last 4' },
  { key: 'sentTo', label: 'Sent to (bank + last 4)' },
];

const DEFAULT_PAYMENT_SUBJECT = 'Payment sent — {{period}}';
const DEFAULT_PAYMENT_BODY = `<p>Shalom {{storeName}},</p>
<p>Your payment has been sent.</p>
{{breakdown}}
<table style="width:100%;border-collapse:collapse;margin:18px 0">
<tr><td style="padding:6px 0;color:#8a7c63">Sent To</td><td style="padding:6px 0;text-align:right;font-weight:600">{{sentTo}}</td></tr>
<tr><td style="padding:6px 0;color:#8a7c63;border-top:1px solid #ece3d3">Billing Period</td><td style="padding:6px 0;text-align:right;font-weight:600;border-top:1px solid #ece3d3">{{period}}</td></tr>
<tr><td style="padding:6px 0;color:#8a7c63;border-top:1px solid #ece3d3">Date Sent</td><td style="padding:6px 0;text-align:right;font-weight:600;border-top:1px solid #ece3d3">{{paymentDate}}</td></tr>
</table>
<p>It may take up to <strong>4 business days</strong> to show up in your account.</p>`;

// First use seeds one default template — from the org's customized
// "Payment Sent" auto-email if they had one (so their wording carries over),
// else the built-in text above.
function ensurePaymentTemplates(orgId) {
  const n = db.prepare('SELECT COUNT(*) c FROM payment_email_templates WHERE org_id = ?').get(orgId).c;
  if (n) return;
  const o = db.prepare(`SELECT subject, body FROM system_email_templates WHERE org_id = ? AND key = 'storeInvoicePaymentSent'`).get(orgId);
  db.prepare(`INSERT INTO payment_email_templates (id, org_id, name, subject, body_html, is_default) VALUES (?,?,?,?,?,1)`)
    .run(uuid(), orgId, 'Standard payment notice', o?.subject || DEFAULT_PAYMENT_SUBJECT, sanitizeEmailHtml(o?.body || DEFAULT_PAYMENT_BODY));
}
function listPaymentTemplates(orgId) {
  ensurePaymentTemplates(orgId);
  return db.prepare('SELECT * FROM payment_email_templates WHERE org_id = ? ORDER BY is_default DESC, name COLLATE NOCASE').all(orgId);
}

// invoice − fee = total as a small table. The fee row reflects what really
// happened: the org's fee %, "Not deducted" when waived on this invoice, or
// a generic "fee / adjustments" line when the amount actually sent isn't
// exactly invoice − policy fee, so the arithmetic on the page always adds up.
function buildBreakdown(bill, pct, sent) {
  const invoice = money(bill.amount), total = money(sent);
  const policyFee = bill.fee_waived ? 0 : money(invoice * pct / 100);
  const matches = Math.abs(money(invoice - policyFee) - total) < 0.005;
  const rows = [];
  const td = (l, v, o = {}) => `<tr><td style="padding:7px 0;${o.top ? 'border-top:' + o.top + ';' : ''}color:${o.strong ? '#2b2118' : '#8a7c63'};${o.strong ? 'font-weight:700;' : ''}">${l}</td><td style="padding:7px 0;${o.top ? 'border-top:' + o.top + ';' : ''}text-align:right;font-weight:${o.strong ? 700 : 600};${o.size ? 'font-size:' + o.size + ';' : ''}">${v}</td></tr>`;
  let feeText = usd(0);
  if (invoice === total && !pct) { rows.push(td('Total sent', usd(total), { strong: true, size: '18px' })); }
  else {
    rows.push(td('Invoice amount', usd(invoice)));
    if (bill.fee_waived && matches) { feeText = 'Not deducted'; rows.push(td(`Processing fee${pct ? ` (${pct}%)` : ''}`, 'Not deducted', { top: '1px solid #ece3d3' })); }
    else if (matches) { feeText = usd(policyFee); rows.push(td(`Processing fee (${pct}%)`, '&minus;' + usd(policyFee), { top: '1px solid #ece3d3' })); }
    else {
      const diff = money(invoice - total);
      if (Math.abs(diff) < 0.005) { feeText = 'Not deducted'; rows.push(td(`Processing fee${pct ? ` (${pct}%)` : ''}`, 'Not deducted', { top: '1px solid #ece3d3' })); }
      else { feeText = usd(Math.abs(diff)); rows.push(td('Processing fee / adjustments', (diff >= 0 ? '&minus;' : '+') + usd(Math.abs(diff)), { top: '1px solid #ece3d3' })); }
    }
    rows.push(td('Total sent', usd(total), { top: '2px solid #c9a76a', strong: true, size: '18px' }));
  }
  return { html: `<table style="width:100%;border-collapse:collapse;margin:18px 0">${rows.join('')}</table>`, feeText };
}

function buildPaymentVars({ bill, storeName, paymentInfo, amount, date, pct, periodText }) {
  const bd = buildBreakdown(bill, pct, amount);
  const last4 = (paymentInfo?.account_number || '').slice(-4);
  const bankName = paymentInfo?.bank_name || '';
  const plain = {
    storeName, period: periodText || 'N/A', paymentDate: date ? longDate(date) : '', bankName, last4,
    sentTo: bankName ? `${bankName}${last4 ? ` (…${last4})` : ''}` : 'Not specified',
    amount: usd(amount), total: usd(amount), invoiceAmount: usd(bill.amount),
    feePercent: pct ? `${pct}%` : '0%', feeAmount: bd.feeText.replace(/&minus;/g, '-'), breakdown: '', noteBlock: '',
  };
  // Body vars are HTML-escaped (names are typed by stores) and carry the
  // breakdown table; subject vars stay plain text.
  const html = { ...plain, storeName: escapeHtml(storeName), period: escapeHtml(plain.period), bankName: escapeHtml(bankName), last4: escapeHtml(last4),
    sentTo: bankName ? `${escapeHtml(bankName)}${last4 ? ` (&hellip;${escapeHtml(last4)})` : ''}` : 'Not specified', breakdown: bd.html };
  return { vars: html, textVars: plain };
}
// {{vars}} left in what the admin sent (or typed by hand) get filled; a
// {{breakdown}} the editor wrapped in its own <p> is unwrapped first so a
// table doesn't end up nested inside a paragraph.
function fillPaymentTemplate(text, vars) {
  return substitute(String(text).replace(/<p[^>]*>\s*(\{\{breakdown\}\})\s*<\/p>/gi, '$1'), vars);
}

// Effective period dates for an invoice: the per-invoice correction if one
// was made at payment time, else the billing period it was submitted for.
function effectivePeriod(bill) {
  if (bill.bill_period_start && bill.bill_period_end) return { start: bill.bill_period_start, end: bill.bill_period_end };
  if (bill.period_start && bill.period_end) return { start: bill.period_start, end: bill.period_end };
  return { start: null, end: null };
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
  // An admin who entered the portal can submit against ANY billing period,
  // not only ones this store was invited to — they get every period, with
  // `invited` so the form can still tell them which is which.
  const invites = req.impersonatedBy
    ? db.prepare(`SELECT bp.id, bp.start_date, bp.end_date, bp.created_at,
        EXISTS(SELECT 1 FROM store_bill_submissions b WHERE b.billing_period_id = bp.id AND b.store_id = ?) AS submitted,
        EXISTS(SELECT 1 FROM billing_period_invites i WHERE i.billing_period_id = bp.id AND i.store_id = ?) AS invited
      FROM billing_periods bp WHERE bp.org_id = ? ORDER BY bp.start_date DESC`).all(req.user.store_id, req.user.store_id, req.user.org_id)
    : db.prepare(`SELECT bp.id, bp.start_date, bp.end_date, bp.created_at,
        EXISTS(SELECT 1 FROM store_bill_submissions b WHERE b.billing_period_id = bp.id AND b.store_id = ?) AS submitted, 1 AS invited
      FROM billing_period_invites bpi JOIN billing_periods bp ON bp.id = bpi.billing_period_id
      WHERE bpi.store_id = ? ORDER BY bp.start_date DESC`).all(req.user.store_id, req.user.store_id);
  const settings = Object.fromEntries(db.prepare(`SELECT key, value FROM settings WHERE org_id = ? AND key IN ('store_billing_tax_id','store_billing_legal_name')`).all(req.user.org_id).map(r => [r.key, r.value]));
  res.json({
    hasPaymentInfo: !!paymentInfo,
    paymentInfo: maskPaymentInfo(paymentInfo),
    invoiceVerifiedThisSession: !!req.impersonatedBy || hasVerifiedThisSession(req.user.store_id, req.tokenIat),
    impersonating: !!req.impersonatedBy,
    periods: invites.map(p => ({ id: p.id, start_date: p.start_date, end_date: p.end_date, label: periodLabel(p.start_date, p.end_date), submitted: !!p.submitted, invited: !!p.invited })),
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
  // An admin who entered this portal bypasses everything in this section:
  // no email verification, no required fields, no format checks. Anything
  // left blank keeps what is already on file, so an admin can fix one field
  // (say the routing number) without re-typing the rest. The one guard that
  // stays: if both account-number boxes are filled and differ, that is a
  // typo, not something to bypass.
  const adminBypass = !!req.impersonatedBy;
  const existingRow = db.prepare('SELECT * FROM store_payment_info WHERE store_id = ?').get(req.user.store_id);
  if (!adminBypass) {
    const required = ['bank_name', 'name_on_account', 'address', 'city', 'state', 'zip', 'contact_name', 'contact_cell', 'account_number', 'account_number_confirm', 'routing_number'];
    for (const f of required) {
      if (!String(b[f] || '').trim()) return res.status(400).json({ error: `${f.replace(/_/g, ' ')} is required` });
    }
    if (!isValidPhone(b.contact_cell)) return res.status(400).json({ error: 'Enter a valid phone number for Contact Cell (10 digits).' });
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
  } else if (String(b.account_number || '').trim() && String(b.account_number_confirm || '').trim() && String(b.account_number).trim() !== String(b.account_number_confirm).trim()) {
    return res.status(400).json({ error: 'Account numbers do not match.' });
  }
  const pick = (f) => { const v = String(b[f] ?? '').trim(); return v || (adminBypass ? (existingRow?.[f] ?? '') : v); };
  const contactCell = String(b.contact_cell || '').trim();
  const row = {
    bank_name: pick('bank_name'), name_on_account: pick('name_on_account'), address: pick('address'), city: pick('city'), state: pick('state'), zip: pick('zip'),
    contact_name: pick('contact_name'), account_number: pick('account_number'), routing_number: pick('routing_number'),
    // normalised when it parses as a phone; an admin's odd value is kept as typed
    contact_cell: contactCell ? (isValidPhone(contactCell) ? normalizePhone(contactCell) : contactCell) : (existingRow?.contact_cell ?? ''),
    place_id: b.place_id || (adminBypass ? existingRow?.place_id : null) || null,
  };
  const existing = existingRow ? { id: existingRow.id } : null;
  db.prepare(`INSERT INTO store_payment_info (id, org_id, store_id, bank_name, name_on_account, address, city, state, zip, place_id, contact_name, contact_cell, account_number, routing_number)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(store_id) DO UPDATE SET bank_name=excluded.bank_name, name_on_account=excluded.name_on_account, address=excluded.address,
      city=excluded.city, state=excluded.state, zip=excluded.zip, place_id=excluded.place_id, contact_name=excluded.contact_name,
      contact_cell=excluded.contact_cell, account_number=excluded.account_number, routing_number=excluded.routing_number, updated_at=datetime('now')`)
    .run(existing?.id || uuid(), req.user.org_id, req.user.store_id, row.bank_name, row.name_on_account, row.address, row.city, row.state, row.zip,
      row.place_id, row.contact_name, row.contact_cell, row.account_number, row.routing_number);
  logAudit(req.user.org_id, req.user.id, existing ? 'update_payment_info' : 'create_payment_info', 'store', req.user.store_id, null, { bank_name: row.bank_name, ...(adminBypass ? { entered_by_admin: req.impersonatedBy } : {}) }, req.ip);
  res.json({ ok: true });
});

router.get('/my/invoices', (req, res) => {
  if (req.user.role !== 'store') return res.status(403).json({ error: 'Store portal only' });
  const bills = db.prepare(`SELECT b.*, COALESCE(b.bill_period_start, bp.start_date) AS period_start, COALESCE(b.bill_period_end, bp.end_date) AS period_end FROM store_bill_submissions b
    LEFT JOIN billing_periods bp ON bp.id = b.billing_period_id WHERE b.store_id = ? ORDER BY b.submitted_at DESC`).all(req.user.store_id);
  // Internal-only columns never go to the store: the admin's private note, the
  // approval-for-payment bookkeeping, and the fee-override record.
  const INTERNAL = ['admin_notes', 'approved_for_payment', 'approved_amount', 'approved_by', 'approved_at', 'fee_waived', 'fee_waived_by', 'fee_waived_at'];
  res.json({ bills: bills.map(b => {
    const pub = { ...b, period_label: b.period_start ? periodLabel(b.period_start, b.period_end) : (b.period || '') };
    for (const k of INTERNAL) delete pub[k];
    return pub;
  }) });
});

router.post('/my/invoices', invoiceUpload.single('file'), async (req, res) => {
  if (req.user.role !== 'store') return res.status(403).json({ error: 'Store portal only' });
  const store = db.prepare('SELECT * FROM stores WHERE id = ?').get(req.user.store_id);
  // An admin who entered this portal ("Enter Portal") bypasses every gate in
  // the payment section: payment info on file, email verification, the
  // attachment, the period-confirmation checkbox, being invited to the
  // period, and the one-invoice-per-period limit. Only the amount is still
  // required (an invoice with no amount means nothing anywhere else), and
  // the invoice can be filed against any billing period or none at all.
  const adminBypass = !!req.impersonatedBy;
  const paymentInfo = db.prepare('SELECT * FROM store_payment_info WHERE store_id = ?').get(req.user.store_id);
  if (!paymentInfo && !adminBypass) return res.status(400).json({ error: 'Please complete your payment information before submitting an invoice.', code: 'PAYMENT_INFO_REQUIRED' });
  const b = req.body || {};
  if (!adminBypass && !hasVerifiedThisSession(req.user.store_id, req.tokenIat) && !useVerification(req.user.store_id, 'invoice_submit', b.verificationId)) {
    return res.status(400).json({ error: 'Please verify your email before submitting.', code: 'VERIFICATION_REQUIRED' });
  }
  const amountNum = +b.amount;
  if (!amountNum || amountNum <= 0) return res.status(400).json({ error: 'A valid amount is required' });
  if (!adminBypass && !['1', 'true', true].includes(b.period_confirmed)) return res.status(400).json({ error: 'Please confirm this invoice matches the billing period.' });
  // A store can only submit against a billing period it was actually
  // invited to AND hasn't already submitted for — no more ad-hoc
  // submissions with no period at all. Without an open period to submit
  // against, the store portal's own "Submit an Invoice" button is hidden
  // entirely (see store-portal/billing.html), but this is the real gate —
  // never trust the client not to have shown the form anyway.
  let billingPeriod = null;
  if (adminBypass) {
    if (b.billing_period_id) {
      billingPeriod = db.prepare('SELECT * FROM billing_periods WHERE id = ? AND org_id = ?').get(b.billing_period_id, req.user.org_id);
      if (!billingPeriod) return res.status(400).json({ error: 'Billing period not found.' });
    }
  } else {
    if (!b.billing_period_id) return res.status(400).json({ error: 'There is no open billing period for you to submit against right now.', code: 'NO_OPEN_PERIOD' });
    billingPeriod = db.prepare(`SELECT bp.* FROM billing_periods bp JOIN billing_period_invites bpi ON bpi.billing_period_id = bp.id WHERE bp.id = ? AND bpi.store_id = ?`).get(b.billing_period_id, req.user.store_id);
    if (!billingPeriod) return res.status(400).json({ error: 'Billing period not found for this store.' });
    const alreadySubmitted = db.prepare(`SELECT 1 FROM store_bill_submissions WHERE billing_period_id = ? AND store_id = ?`).get(billingPeriod.id, req.user.store_id);
    if (alreadySubmitted) return res.status(400).json({ error: 'An invoice has already been submitted for this billing period.' });
  }
  const id = uuid();
  let filePath = null, fileName = null;
  if (req.file) {
    fileName = req.file.originalname;
    const safeName = `${id}-${fileName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    writeFileSync(join(BILLS_DIR, safeName), req.file.buffer);
    filePath = safeName;
  } else if (!adminBypass) {
    return res.status(400).json({ error: 'Please attach your invoice (image, PDF, Excel, or CSV).' });
  }
  const period = billingPeriod ? periodLabel(billingPeriod.start_date, billingPeriod.end_date) : (adminBypass ? String(b.period_label || '').trim().slice(0, 100) : '');
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
  logAudit(req.user.org_id, req.user.id, 'submit_invoice', 'store', store.id, null, { amount: amountNum, period, ...(adminBypass ? { entered_by_admin: req.impersonatedBy, has_file: !!filePath } : {}) }, req.ip);
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
  // rich text from the composer — cleaned once here, before it's stored and sent
  const cleanBody = sanitizeEmailHtml(email_body);
  if (isBlankHtml(cleanBody)) return res.status(400).json({ error: 'Email subject and body are required' });
  db.prepare(`INSERT INTO billing_periods (id, org_id, start_date, end_date, email_subject, email_body, created_by) VALUES (?,?,?,?,?,?,?)`)
    .run(id, req.user.org_id, start_date, end_date, email_subject, cleanBody, req.user.id);
  let sent = 0, failed = 0, skipped = 0;
  const label = periodLabel(start_date, end_date);
  for (const storeId of store_ids) {
    const store = db.prepare(`SELECT s.*, u.email AS login_email FROM stores s LEFT JOIN users u ON u.id = s.portal_user_id WHERE s.id = ? AND s.org_id = ? AND s.setup_status = 'active'`).get(storeId, req.user.org_id);
    if (!store || !store.login_email) { skipped++; continue; }
    const portalUrl = `${process.env.APP_URL || ''}/store-portal/billing`;
    const subject = substitute(email_subject, { storeName: store.name, startDate: start_date, endDate: end_date, period: label, portalUrl });
    const body = substitute(cleanBody, { storeName: escapeHtml(store.name), startDate: start_date, endDate: end_date, period: label, portalUrl });
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

// Processing fee: a configurable percent (Settings > Store Billing) deducted
// from what a store is paid, e.g. 1 => a $100 invoice pays out $99. Each
// invoice can be individually exempted ("fee overridden"), recorded with who
// and when. Applied at read time, so changing the percent re-prices every
// invoice not yet paid.
const money = v => Math.round((Number(v) || 0) * 100) / 100;
function feePercent(orgId) {
  const v = parseFloat(db.prepare(`SELECT value FROM settings WHERE org_id = ? AND key = 'store_billing_fee_percent'`).get(orgId)?.value);
  return Number.isFinite(v) && v > 0 ? Math.min(v, 100) : 0;
}
function withPayable(bill, pct) {
  const fee = bill.fee_waived ? 0 : money(bill.amount * pct / 100);
  return { ...bill, fee_percent: pct, fee_amount: fee, payable_amount: money(bill.amount - fee) };
}
const approverNameSql = `TRIM(COALESCE(u.first_name,'')||' '||COALESCE(u.last_name,'')) AS approved_by_name`;

router.get('/invoices', requirePermission('store_billing'), (req, res) => {
  const { status, store_id } = req.query;
  let where = 'b.org_id = ?';
  const params = [req.user.org_id];
  if (status) { where += ' AND b.status = ?'; params.push(status); }
  if (store_id) { where += ' AND b.store_id = ?'; params.push(store_id); }
  const pct = feePercent(req.user.org_id);
  const bills = db.prepare(`SELECT b.*, s.name AS store_name, COALESCE(b.bill_period_start, bp.start_date) AS period_start, COALESCE(b.bill_period_end, bp.end_date) AS period_end, ${approverNameSql}
    FROM store_bill_submissions b JOIN stores s ON s.id = b.store_id LEFT JOIN billing_periods bp ON bp.id = b.billing_period_id
    LEFT JOIN users u ON u.id = b.approved_by
    WHERE ${where} ORDER BY b.submitted_at DESC`).all(...params);
  res.json({ bills: bills.map(b => withPayable({ ...b, period_label: b.period_start ? periodLabel(b.period_start, b.period_end) : (b.period || '') }, pct)) });
});

// Registered BEFORE /invoices/:id so "summary" isn't taken as an invoice id.
// Totals tiles on the Store Billing page: what's been paid, what's still
// owed (an approved invoice counts at its approved amount, otherwise its net
// payable), what's approved and waiting for payment, and how many invoices
// still need review.
router.get('/invoices/summary', requirePermission('store_billing'), (req, res) => {
  const pct = feePercent(req.user.org_id);
  const bills = db.prepare(`SELECT * FROM store_bill_submissions WHERE org_id = ?`).all(req.user.org_id);
  const s = { paid_amount: 0, paid_count: 0, outstanding_amount: 0, outstanding_count: 0, approved_amount: 0, approved_count: 0, rejected_count: 0, fee_percent: pct, fees_deducted: 0 };
  for (const raw of bills) {
    const b = withPayable(raw, pct);
    if (b.status === 'completed') { s.paid_amount += b.payment_amount ?? b.amount; s.paid_count++; }
    else if (b.status === 'pending') {
      const approved = !!b.approved_for_payment;
      const owed = approved && b.approved_amount != null ? b.approved_amount : b.payable_amount;
      s.outstanding_amount += owed; s.outstanding_count++;
      s.fees_deducted += b.fee_amount;
      if (approved) { s.approved_amount += owed; s.approved_count++; }
    } else if (b.status === 'rejected') s.rejected_count++;
  }
  for (const k of ['paid_amount', 'outstanding_amount', 'approved_amount', 'fees_deducted']) s[k] = money(s[k]);
  res.json(s);
});

router.get('/invoices/:id', requirePermission('store_billing'), (req, res) => {
  const bill = db.prepare(`SELECT b.*, s.name AS store_name, COALESCE(b.bill_period_start, bp.start_date) AS period_start, COALESCE(b.bill_period_end, bp.end_date) AS period_end, ${approverNameSql},
      TRIM(COALESCE(w.first_name,'')||' '||COALESCE(w.last_name,'')) AS fee_waived_by_name
    FROM store_bill_submissions b JOIN stores s ON s.id = b.store_id LEFT JOIN billing_periods bp ON bp.id = b.billing_period_id
    LEFT JOIN users u ON u.id = b.approved_by LEFT JOIN users w ON w.id = b.fee_waived_by
    WHERE b.id = ? AND b.org_id = ?`).get(req.params.id, req.user.org_id);
  if (!bill) return res.status(404).json({ error: 'Not found' });
  const paymentInfo = db.prepare('SELECT * FROM store_payment_info WHERE store_id = ?').get(bill.store_id);
  res.json({ bill: withPayable(bill, feePercent(req.user.org_id)), paymentInfo: maskPaymentInfo(paymentInfo) });
});

function billWithApprover(id, orgId) {
  const row = db.prepare(`SELECT b.*, ${approverNameSql} FROM store_bill_submissions b LEFT JOIN users u ON u.id = b.approved_by WHERE b.id = ?`).get(id);
  return withPayable(row, feePercent(orgId));
}

// "Approved for payment" — the second pair of eyes before money moves. Only a
// pending invoice can be (un)approved; the approved amount defaults to the
// net payable figure and can be edited down/up before payment.
router.post('/invoices/:id/approve-for-payment', requirePermission('store_billing', 'can_edit'), (req, res) => {
  const bill = db.prepare('SELECT * FROM store_bill_submissions WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!bill) return res.status(404).json({ error: 'Not found' });
  if (bill.status !== 'pending') return res.status(400).json({ error: 'Only a pending invoice can be approved for payment.' });
  const body = req.body || {};
  const approved = body.approved === undefined ? !!bill.approved_for_payment : !!body.approved;
  const amount = body.amount === undefined || body.amount === null || body.amount === ''
    ? (bill.approved_amount ?? withPayable(bill, feePercent(req.user.org_id)).payable_amount)
    : money(body.amount);
  if (!(amount >= 0)) return res.status(400).json({ error: 'A valid amount is required' });
  db.prepare(`UPDATE store_bill_submissions SET approved_for_payment = ?, approved_amount = ?, approved_by = ?, approved_at = datetime('now') WHERE id = ?`)
    .run(approved ? 1 : 0, amount, req.user.id, bill.id);
  logAudit(req.user.org_id, req.user.id, approved ? 'approve_invoice_for_payment' : 'unapprove_invoice_for_payment', 'store', bill.store_id,
    { approved_for_payment: !!bill.approved_for_payment, approved_amount: bill.approved_amount }, { approved_for_payment: approved, approved_amount: amount }, req.ip);
  res.json({ bill: billWithApprover(bill.id, req.user.org_id) });
});

// Per-invoice processing-fee override. If the invoice was approved for
// exactly the old payable figure, the approved amount follows the new one so
// the approval doesn't silently go stale.
router.post('/invoices/:id/fee-waiver', requirePermission('store_billing', 'can_edit'), (req, res) => {
  const bill = db.prepare('SELECT * FROM store_bill_submissions WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!bill) return res.status(404).json({ error: 'Not found' });
  if (bill.status !== 'pending') return res.status(400).json({ error: 'The fee can only be changed on a pending invoice.' });
  const waived = !!(req.body || {}).waived;
  const pct = feePercent(req.user.org_id);
  const oldPayable = withPayable(bill, pct).payable_amount;
  const newPayable = withPayable({ ...bill, fee_waived: waived ? 1 : 0 }, pct).payable_amount;
  const followApproval = bill.approved_for_payment && bill.approved_amount != null && Math.abs(bill.approved_amount - oldPayable) < 0.005;
  db.prepare(`UPDATE store_bill_submissions SET fee_waived = ?, fee_waived_by = ?, fee_waived_at = datetime('now')${followApproval ? ', approved_amount = ?' : ''} WHERE id = ?`)
    .run(...[waived ? 1 : 0, req.user.id, ...(followApproval ? [newPayable] : []), bill.id]);
  logAudit(req.user.org_id, req.user.id, waived ? 'waive_invoice_fee' : 'reinstate_invoice_fee', 'store', bill.store_id,
    { fee_waived: !!bill.fee_waived, payable_amount: oldPayable }, { fee_waived: waived, payable_amount: newPayable }, req.ip);
  res.json({ bill: billWithApprover(bill.id, req.user.org_id) });
});

// Every store (anything not inactive) with its payment info IN FULL — bank,
// name on account, full account + routing numbers — plus the store's own
// contacts. Stores with nothing on file are included with blank bank columns
// and sorted last, so the sheet doubles as a "who still hasn't set up
// payment" list. Same gate as the per-store reveal below, and audited.
router.get('/stores/payment-info/export', requirePermission('store_billing'), (req, res) => {
  if (!['super_admin', 'org_admin'].includes(req.user.role)) return res.status(403).json({ error: 'Not permitted' });
  const rows = db.prepare(`SELECT s.name, s.setup_status, s.address, s.city, s.state, s.zip, s.phone,
      s.owner_name, s.owner_phone, s.owner_email, s.manager_name, s.manager_phone, s.manager_email, u.email AS login_email,
      pi.bank_name, pi.name_on_account, pi.address AS bank_address, pi.city AS bank_city, pi.state AS bank_state, pi.zip AS bank_zip,
      pi.contact_name, pi.contact_cell, pi.account_number, pi.routing_number, pi.updated_at AS payment_info_updated_at
    FROM stores s LEFT JOIN store_payment_info pi ON pi.store_id = s.id LEFT JOIN users u ON u.id = s.portal_user_id
    WHERE s.org_id = ? AND s.setup_status != 'inactive' ORDER BY (pi.id IS NULL), s.name`).all(req.user.org_id);
  logAudit(req.user.org_id, req.user.id, 'export_payment_info', 'store', null, null, { stores: rows.length, with_payment_info: rows.filter(r => r.account_number).length }, req.ip);
  const out = rows.map(r => ({
    'Store': r.name, 'Setup Status': r.setup_status, 'Address': r.address, 'City': r.city, 'State': r.state, 'Zip': r.zip, 'Store Phone': r.phone,
    'Owner': r.owner_name, 'Owner Phone': r.owner_phone, 'Owner Email': r.owner_email, 'Manager': r.manager_name, 'Manager Phone': r.manager_phone, 'Manager Email': r.manager_email, 'Portal Login': r.login_email,
    'Bank': r.bank_name, 'Name on Account': r.name_on_account, 'Bank Address': [r.bank_address, r.bank_city, r.bank_state, r.bank_zip].filter(Boolean).join(', '),
    'Billing Contact': r.contact_name, 'Billing Contact Cell': r.contact_cell, 'Account Number': r.account_number, 'Routing Number': r.routing_number, 'Payment Info Updated': r.payment_info_updated_at,
  }));
  sendXlsx(res, `store-bank-details-${new Date().toISOString().slice(0, 10)}.xlsx`, out);
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

// Internal note, settable independent of status/payment — unlike
// payment_note (which only ever goes out with the one "payment sent"
// email and would be misleading to edit after that email already sent),
// admin_notes is purely for the admin's own record-keeping and makes
// sense to add or update any time, including well after an invoice is
// already marked completed or rejected.
router.post('/invoices/:id/notes', requirePermission('store_billing', 'can_edit'), (req, res) => {
  const bill = db.prepare('SELECT * FROM store_bill_submissions WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!bill) return res.status(404).json({ error: 'Not found' });
  const { admin_notes } = req.body || {};
  db.prepare(`UPDATE store_bill_submissions SET admin_notes = ? WHERE id = ?`).run(admin_notes || null, bill.id);
  logAudit(req.user.org_id, req.user.id, 'update_invoice_note', 'store', bill.store_id, { admin_notes: bill.admin_notes }, { admin_notes }, req.ip);
  res.json({ bill: db.prepare('SELECT * FROM store_bill_submissions WHERE id = ?').get(bill.id) });
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

// Everything the Mark Payment Sent popup and the send itself need to know
// about an invoice: effective billing period, fee policy, bank on file.
function paymentContext(orgId, billId) {
  const bill = db.prepare(`SELECT b.*, s.name AS store_name, COALESCE(b.bill_period_start, bp.start_date) AS period_start, COALESCE(b.bill_period_end, bp.end_date) AS period_end
    FROM store_bill_submissions b JOIN stores s ON s.id = b.store_id LEFT JOIN billing_periods bp ON bp.id = b.billing_period_id
    WHERE b.id = ? AND b.org_id = ?`).get(billId, orgId);
  if (!bill) return null;
  const paymentInfo = db.prepare('SELECT * FROM store_payment_info WHERE store_id = ?').get(bill.store_id);
  return { bill, paymentInfo, pct: feePercent(orgId) };
}
// A period correction sent with the payment: both dates, valid, end not
// before start. Returns { start, end } or { error }; null when neither sent.
function parsePeriodOverride(start, end) {
  if (!start && !end) return null;
  if (!isoDate(start) || !isoDate(end)) return { error: 'Enter both billing period dates.' };
  if (end < start) return { error: 'The billing period end date cannot be before its start date.' };
  return { start, end };
}
function previewPayload(ctx, body, orgId) {
  const { bill, paymentInfo, pct } = ctx;
  const amount = Number(body.payment_amount);
  const ov = parsePeriodOverride(body.period_start, body.period_end);
  const eff = ov && !ov.error ? ov : effectivePeriod(bill);
  const periodText = eff.start ? periodLabel(eff.start, eff.end) : (bill.period || 'N/A');
  const sentAmount = Number.isFinite(amount) && amount > 0 ? amount : withPayable(bill, pct).payable_amount;
  const { vars, textVars } = buildPaymentVars({ bill: withPayable(bill, pct), storeName: bill.store_name, paymentInfo, amount: sentAmount, date: isoDate(body.payment_date) ? body.payment_date : new Date().toISOString().slice(0, 10), pct, periodText });
  const templates = listPaymentTemplates(orgId);
  const tpl = (body.template_id && templates.find(t => t.id === body.template_id)) || templates.find(t => t.is_default) || templates[0];
  return {
    template_id: tpl.id, subject: fillPaymentTemplate(tpl.subject, textVars), body: fillPaymentTemplate(sanitizeEmailHtml(tpl.body_html), vars),
    breakdown: vars.breakdown, period: periodText, vars, textVars,
  };
}

// The popup calls this whenever the template, amount, date or period
// changes, so the admin edits the REAL email (breakdown table filled in),
// not a pile of {{placeholders}}.
router.post('/invoices/:id/payment-email-preview', requirePermission('store_billing'), (req, res) => {
  const ctx = paymentContext(req.user.org_id, req.params.id);
  if (!ctx) return res.status(404).json({ error: 'Not found' });
  const { vars, textVars, ...out } = previewPayload(ctx, req.body || {}, req.user.org_id);
  res.json({ ...out, store_email: storeContactEmail(ctx.bill.store_id), has_payment_info: !!ctx.paymentInfo });
});

router.post('/invoices/:id/complete', requirePermission('store_billing', 'can_edit'), async (req, res) => {
  const ctx = paymentContext(req.user.org_id, req.params.id);
  if (!ctx) return res.status(404).json({ error: 'Not found' });
  const { bill, paymentInfo, pct } = ctx;
  if (bill.status === 'completed') return res.status(400).json({ error: 'Already marked completed.' });
  // No bank on file is no longer a blocker: an admin can record a payment
  // that went out another way (check, Zelle, ...). The bank columns stay
  // blank and the email says "Not specified" for that row.
  const { payment_amount, payment_date, payment_note, admin_notes, period_start, period_end, email_subject, email_body, send_email } = req.body || {};
  const amountNum = +payment_amount;
  if (!amountNum || amountNum <= 0) return res.status(400).json({ error: 'A valid payment amount is required' });
  if (!payment_date) return res.status(400).json({ error: 'A payment date is required' });
  const ov = parsePeriodOverride(period_start, period_end);
  if (ov?.error) return res.status(400).json({ error: ov.error });
  const last4 = (paymentInfo?.account_number || '').slice(-4);
  const oldPeriod = effectivePeriod(bill);
  const changedPeriod = ov && (ov.start !== oldPeriod.start || ov.end !== oldPeriod.end);
  const periodText = ov ? periodLabel(ov.start, ov.end) : (bill.period || 'N/A');
  db.prepare(`UPDATE store_bill_submissions SET status = 'completed', payment_amount = ?, payment_bank_name = ?, payment_account_last4 = ?, payment_sent_date = ?,
      payment_note = ?, admin_notes = ?, reviewed_at = datetime('now') WHERE id = ?`)
    .run(amountNum, paymentInfo?.bank_name || null, last4, payment_date, payment_note || null, admin_notes || null, bill.id);
  if (changedPeriod) db.prepare('UPDATE store_bill_submissions SET bill_period_start = ?, bill_period_end = ?, period = ? WHERE id = ?').run(ov.start, ov.end, periodText, bill.id);

  const storeTo = storeContactEmail(bill.store_id);
  const email = { sent: false, to: storeTo, error: null, skipped: null };
  if (send_email === false || send_email === 'false' || send_email === 0) email.skipped = 'turned off';
  else if (!storeTo) email.skipped = 'no email on file';
  else {
    const { vars, textVars } = buildPaymentVars({ bill: withPayable(bill, pct), storeName: bill.store_name, paymentInfo, amount: amountNum, date: payment_date, pct, periodText });
    let subject, body;
    const tpl = listPaymentTemplates(req.user.org_id).find(t => t.is_default);
    if (email_body && !isBlankHtml(email_body)) {
      // The admin's final, rich-text version from the popup (any {{fields}}
      // still in it are filled; the HTML is cleaned first).
      subject = fillPaymentTemplate(email_subject || tpl?.subject || DEFAULT_PAYMENT_SUBJECT, textVars);
      body = fillPaymentTemplate(sanitizeEmailHtml(email_body), vars);
    } else {
      // Nothing composed (an API caller, say): use the DEFAULT template, plus
      // the optional plain note as a closing paragraph.
      const noteBlock = payment_note ? `<p style="color:#8a7c63;font-size:13.5px">${escapeHtml(payment_note).replace(/\n/g, '<br>')}</p>` : '';
      subject = fillPaymentTemplate(tpl.subject, textVars);
      body = fillPaymentTemplate(sanitizeEmailHtml(tpl.body_html), vars) + noteBlock;
    }
    const r = await sendMailChecked(req.user.org_id, storeTo, subject, body, { relatedEntityType: 'store', relatedEntityId: bill.store_id, sentBy: req.user.id });
    email.error = r?.emailError || null; email.sent = !r?.emailError;
  }
  logAudit(req.user.org_id, req.user.id, 'complete_invoice_payment', 'store', bill.store_id, { status: bill.status, ...(changedPeriod ? { period: oldPeriod } : {}) },
    { status: 'completed', payment_amount: amountNum, payment_date, ...(changedPeriod ? { period: { start: ov.start, end: ov.end } } : {}), email_sent: email.sent, invoice_id: bill.id }, req.ip);
  res.json({ bill: db.prepare('SELECT * FROM store_bill_submissions WHERE id = ?').get(bill.id), email });
});

// Takes a recorded payment back: the invoice returns to Pending (so it can
// be paid again correctly) and the payment fields are cleared. The invoice,
// its approval and its attachment are untouched; any email already sent to
// the store can't be unsent. Same tight roster as deleting an invoice —
// this removes a financial record.
router.delete('/invoices/:id/payment', requirePermission('store_billing', 'can_edit'), (req, res) => {
  if (!['super_admin', 'org_admin'].includes(req.user.role)) return res.status(403).json({ error: 'Not permitted' });
  const bill = db.prepare('SELECT * FROM store_bill_submissions WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!bill) return res.status(404).json({ error: 'Not found' });
  if (bill.status !== 'completed') return res.status(400).json({ error: 'This invoice has no recorded payment.' });
  db.prepare(`UPDATE store_bill_submissions SET status = 'pending', payment_amount = NULL, payment_bank_name = NULL, payment_account_last4 = NULL,
      payment_sent_date = NULL, payment_note = NULL, reviewed_at = NULL WHERE id = ?`).run(bill.id);
  logAudit(req.user.org_id, req.user.id, 'delete_invoice_payment', 'store', bill.store_id,
    { invoice_id: bill.id, payment_amount: bill.payment_amount, payment_sent_date: bill.payment_sent_date, bank: bill.payment_bank_name, last4: bill.payment_account_last4 }, { status: 'pending' }, req.ip);
  const row = db.prepare('SELECT * FROM store_bill_submissions WHERE id = ?').get(bill.id);
  res.json({ bill: withPayable(row, feePercent(req.user.org_id)) });
});

// ---------------------------------------------------------------------
// Payment email templates (rich text). One is the default; the Mark
// Payment Sent popup starts from it.
// ---------------------------------------------------------------------
router.get('/payment-email-templates', requirePermission('store_billing'), (req, res) => {
  res.json({ templates: listPaymentTemplates(req.user.org_id), vars: PAYMENT_EMAIL_VARS });
});
function templateFields(b, partial = false) {
  const out = {};
  if (!partial || b.name !== undefined) { out.name = String(b.name || '').trim(); if (!out.name) return { error: 'A template name is required.' }; }
  if (!partial || b.subject !== undefined) { out.subject = String(b.subject || '').trim(); if (!out.subject) return { error: 'An email subject is required.' }; }
  if (!partial || b.body_html !== undefined) { out.body_html = sanitizeEmailHtml(b.body_html); if (isBlankHtml(out.body_html)) return { error: 'The email body cannot be empty.' }; }
  return out;
}
const setOnlyDefault = (orgId, id) => db.transaction(() => {
  db.prepare('UPDATE payment_email_templates SET is_default = 0 WHERE org_id = ? AND id != ?').run(orgId, id);
  db.prepare('UPDATE payment_email_templates SET is_default = 1 WHERE id = ? AND org_id = ?').run(id, orgId);
})();
router.post('/payment-email-templates', requirePermission('store_billing', 'can_edit'), (req, res) => {
  ensurePaymentTemplates(req.user.org_id);
  const f = templateFields(req.body || {});
  if (f.error) return res.status(400).json({ error: f.error });
  const id = uuid();
  db.prepare('INSERT INTO payment_email_templates (id, org_id, name, subject, body_html, is_default, created_by) VALUES (?,?,?,?,?,0,?)').run(id, req.user.org_id, f.name, f.subject, f.body_html, req.user.id);
  if (req.body?.is_default) setOnlyDefault(req.user.org_id, id);
  logAudit(req.user.org_id, req.user.id, 'create', 'payment_email_template', id, null, { name: f.name, is_default: !!req.body?.is_default }, req.ip);
  res.status(201).json({ template: db.prepare('SELECT * FROM payment_email_templates WHERE id = ?').get(id) });
});
router.put('/payment-email-templates/:id', requirePermission('store_billing', 'can_edit'), (req, res) => {
  const t = db.prepare('SELECT * FROM payment_email_templates WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  const f = templateFields(b, true);
  if (f.error) return res.status(400).json({ error: f.error });
  if (b.is_default === false && t.is_default) return res.status(400).json({ error: 'Choose another template as the default instead — there must always be one.' });
  const next = { name: f.name ?? t.name, subject: f.subject ?? t.subject, body_html: f.body_html ?? t.body_html };
  db.prepare(`UPDATE payment_email_templates SET name = ?, subject = ?, body_html = ?, updated_at = datetime('now') WHERE id = ?`).run(next.name, next.subject, next.body_html, t.id);
  if (b.is_default) setOnlyDefault(req.user.org_id, t.id);
  logAudit(req.user.org_id, req.user.id, 'update', 'payment_email_template', t.id, { name: t.name }, { name: next.name, is_default: !!b.is_default }, req.ip);
  res.json({ template: db.prepare('SELECT * FROM payment_email_templates WHERE id = ?').get(t.id) });
});
router.post('/payment-email-templates/:id/default', requirePermission('store_billing', 'can_edit'), (req, res) => {
  const t = db.prepare('SELECT * FROM payment_email_templates WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  setOnlyDefault(req.user.org_id, t.id);
  logAudit(req.user.org_id, req.user.id, 'set_default', 'payment_email_template', t.id, null, { name: t.name }, req.ip);
  res.json({ templates: listPaymentTemplates(req.user.org_id) });
});
router.delete('/payment-email-templates/:id', requirePermission('store_billing', 'can_edit'), (req, res) => {
  const t = db.prepare('SELECT * FROM payment_email_templates WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  if (t.is_default) return res.status(400).json({ error: 'This is the default template. Set another template as the default first, then delete this one.' });
  db.prepare('DELETE FROM payment_email_templates WHERE id = ?').run(t.id);
  logAudit(req.user.org_id, req.user.id, 'delete', 'payment_email_template', t.id, { name: t.name }, null, req.ip);
  res.json({ ok: true });
});

router.get('/invoices/:id/file', requirePermission('store_billing'), (req, res) => {
  const row = db.prepare('SELECT * FROM store_bill_submissions WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (!row.file_path) return res.status(404).json({ error: 'No file attached' });
  res.download(join(BILLS_DIR, row.file_path), row.file_name || 'invoice');
});

// Same tighter roster as deleting any other record outright elsewhere in
// this app (applicant/store "Delete Permanently") — removing a financial
// record, not just changing its status, is a step above ordinary editing.
router.delete('/invoices/:id', requirePermission('store_billing', 'can_edit'), (req, res) => {
  if (!['super_admin', 'org_admin'].includes(req.user.role)) return res.status(403).json({ error: 'Not permitted' });
  const bill = db.prepare('SELECT * FROM store_bill_submissions WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!bill) return res.status(404).json({ error: 'Not found' });
  if (bill.file_path) {
    const filePath = join(BILLS_DIR, bill.file_path);
    if (existsSync(filePath)) { try { unlinkSync(filePath); } catch (e) { console.error('[storeBilling] failed to delete invoice attachment file:', e.message); } }
  }
  db.prepare('DELETE FROM store_bill_submissions WHERE id = ?').run(bill.id);
  logAudit(req.user.org_id, req.user.id, 'delete_invoice', 'store', bill.store_id, { amount: bill.amount, status: bill.status, period: bill.period }, null, req.ip);
  res.json({ ok: true });
});

export default router;
