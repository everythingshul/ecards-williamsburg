import { Router } from 'express';
import { db, uuid } from '../db.js';
import { auth } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import { sendMailChecked } from '../services/mail.js';
import { sendXlsx } from '../services/xlsx.js';
import { findAccountByEmail, resolveEmailsForIds } from '../utils/contactLookup.js';

const router = Router();
router.use(auth, requirePermission('emails')); // internal team feature — staff/org_admin/super_admin only

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ============================= Sent email log =============================
router.get('/', (req, res) => {
  const { search, status, page = 1, pageSize = 50 } = req.query;
  let where = 'WHERE e.org_id = ?';
  const params = [req.user.org_id];
  if (status) { where += ' AND e.status = ?'; params.push(status); }
  if (search) { where += ' AND (e.to_email LIKE ? OR e.subject LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
  const total = db.prepare(`SELECT COUNT(*) c FROM emails_sent e ${where}`).get(...params).c;
  const offset = (Math.max(1, +page) - 1) * +pageSize;
  // sent_by_name is who to display as having sent this — the acting admin
  // for anything triggered from the admin side (quick-send, approvals,
  // invites, contract/document sends, ...), null/blank for genuinely
  // automatic system emails (password resets, task reminders) where no
  // admin was involved.
  const rows = db.prepare(`SELECT e.id, e.to_email, e.subject, e.status, e.error_message, e.related_entity_type, e.related_entity_id, e.sent_by, e.created_at,
      TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')) AS sent_by_name
    FROM emails_sent e LEFT JOIN users u ON u.id = e.sent_by
    ${where}
    ORDER BY e.created_at DESC LIMIT ? OFFSET ?`).all(...params, +pageSize, offset);
  const emails = rows.map(r => ({ ...r, account: findAccountByEmail(req.user.org_id, r.to_email) }));
  res.json({ emails, total });
});

router.get('/export', requirePermission('emails', 'can_export'), (req, res) => {
  const rows = db.prepare(`SELECT e.to_email, e.subject, e.status, e.error_message, e.related_entity_type, e.related_entity_id, e.created_at,
      TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')) AS sent_by_name
    FROM emails_sent e LEFT JOIN users u ON u.id = e.sent_by WHERE e.org_id = ? ORDER BY e.created_at DESC`).all(req.user.org_id);
  const withAccount = rows.map(r => {
    const account = findAccountByEmail(req.user.org_id, r.to_email);
    return { ...r, account_type: account?.type || '', account_name: account?.label || '' };
  });
  sendXlsx(res, `sent-emails-${Date.now()}.xlsx`, withAccount, ['to_email', 'account_type', 'account_name', 'subject', 'status', 'error_message', 'related_entity_type', 'related_entity_id', 'sent_by_name', 'created_at']);
});

router.get('/:id', (req, res) => {
  const email = db.prepare(`SELECT e.*, TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')) AS sent_by_name
    FROM emails_sent e LEFT JOIN users u ON u.id = e.sent_by WHERE e.id = ? AND e.org_id = ?`).get(req.params.id, req.user.org_id);
  if (!email) return res.status(404).json({ error: 'Not found' });
  res.json({ email: { ...email, account: findAccountByEmail(req.user.org_id, email.to_email) } });
});

// ============================= Templates =============================
router.get('/templates/all', (req, res) => {
  const templates = db.prepare('SELECT * FROM email_templates WHERE org_id = ? ORDER BY name').all(req.user.org_id);
  res.json({ templates });
});

router.post('/templates', requirePermission('emails', 'can_edit'), (req, res) => {
  const { name, category, subject, body_html } = req.body || {};
  if (!name || !subject || !body_html) return res.status(400).json({ error: 'name, subject, and body_html are required' });
  const id = uuid();
  db.prepare(`INSERT INTO email_templates (id, org_id, name, category, subject, body_html, created_by) VALUES (?,?,?,?,?,?,?)`)
    .run(id, req.user.org_id, name, category || '', subject, body_html, req.user.id);
  res.status(201).json({ template: db.prepare('SELECT * FROM email_templates WHERE id = ?').get(id) });
});

router.put('/templates/:id', requirePermission('emails', 'can_edit'), (req, res) => {
  const tmpl = db.prepare('SELECT * FROM email_templates WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!tmpl) return res.status(404).json({ error: 'Not found' });
  const { name, category, subject, body_html } = req.body || {};
  db.prepare(`UPDATE email_templates SET name=COALESCE(?,name), category=COALESCE(?,category), subject=COALESCE(?,subject), body_html=COALESCE(?,body_html), updated_at=datetime('now') WHERE id=?`)
    .run(name, category, subject, body_html, tmpl.id);
  res.json({ template: db.prepare('SELECT * FROM email_templates WHERE id = ?').get(tmpl.id) });
});

router.delete('/templates/:id', requirePermission('emails', 'can_edit'), (req, res) => {
  const tmpl = db.prepare('SELECT * FROM email_templates WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!tmpl) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM email_templates WHERE id = ?').run(tmpl.id);
  res.json({ ok: true });
});

// ============================= Compose & send =============================
// Every contact type this org tracks that could plausibly have an email —
// powers the Compose modal's recipient search (type a name or partial
// email, pick from the results) instead of needing every address memorized
// or copy-pasted in from elsewhere. Only rows with a real email on file are
// worth returning; capped since this is a type-ahead, not a directory
// browse.
router.get('/recipients/search', (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ recipients: [] });
  const like = `%${q}%`;
  const recipients = [];
  const shuls = db.prepare(`SELECT id, name_en, gabai_email FROM shuls
      WHERE org_id = ? AND gabai_email != '' AND (name_en LIKE ? OR gabai_email LIKE ?)
      ORDER BY name_en LIMIT 8`).all(req.user.org_id, like, like);
  for (const s of shuls) recipients.push({ type: 'shul', id: s.id, label: s.name_en, email: s.gabai_email });
  const stores = db.prepare(`SELECT id, name, owner_email, manager_email FROM stores
      WHERE org_id = ? AND (owner_email != '' OR manager_email != '') AND (name LIKE ? OR owner_email LIKE ? OR manager_email LIKE ?)
      ORDER BY name LIMIT 8`).all(req.user.org_id, like, like, like);
  for (const s of stores) {
    if (s.owner_email) recipients.push({ type: 'store', id: s.id, label: `${s.name} (Owner)`, email: s.owner_email });
    if (s.manager_email && s.manager_email !== s.owner_email) recipients.push({ type: 'store', id: s.id, label: `${s.name} (Manager)`, email: s.manager_email });
  }
  const applicants = db.prepare(`SELECT id, first_name, last_name, email FROM applicants
      WHERE org_id = ? AND email != '' AND ((first_name || ' ' || last_name) LIKE ? OR email LIKE ?)
      ORDER BY last_name LIMIT 8`).all(req.user.org_id, like, like);
  for (const a of applicants) recipients.push({ type: 'applicant', id: a.id, label: `${a.first_name} ${a.last_name}`, email: a.email });
  const users = db.prepare(`SELECT id, first_name, last_name, email FROM users
      WHERE org_id = ? AND email != '' AND ((first_name || ' ' || last_name) LIKE ? OR email LIKE ?)
      ORDER BY last_name LIMIT 8`).all(req.user.org_id, like, like);
  for (const u of users) recipients.push({ type: 'user', id: u.id, label: `${u.first_name} ${u.last_name}`, email: u.email });
  res.json({ recipients: recipients.slice(0, 20) });
});

// The "Email Builder" send action — an arbitrary one-off (or templated)
// email to any recipient(s), distinct from the system's automatic emails.
// {{variable}} placeholders in the template are substituted from `variables`.
// `to` accepts a comma-separated list — each address gets its own
// individual send (and its own emails_sent log row), same as composing and
// sending the same email to each person one at a time, rather than one
// email exposing every recipient's address to each other in the To field.
//
// Alternatively, `entity_type` ('shul'/'store'/'applicant') + `ids` (array)
// sends to exactly those records' own email addresses, resolved server-side
// — this is what the mass "Email"/"SMS" action on the Shuls/Applicants/
// Stores list pages uses, so it only ever reaches the checked rows. Not
// combinable with `to` in the same request.
router.post('/send', requirePermission('emails', 'can_edit'), async (req, res) => {
  const { to, entity_type, ids, subject, body_html, variables } = req.body || {};
  if (!subject || !body_html) return res.status(400).json({ error: 'subject and body_html are required' });
  let recipients;
  if (entity_type) {
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids is required with entity_type' });
    recipients = [...new Set(resolveEmailsForIds(req.user.org_id, entity_type, ids))];
    if (!recipients.length) return res.status(400).json({ error: 'None of the selected records have an email address on file' });
  } else {
    if (!to) return res.status(400).json({ error: 'to, or entity_type + ids, is required' });
    recipients = [...new Set(String(to).split(',').map(s => s.trim()).filter(Boolean))];
    if (!recipients.length) return res.status(400).json({ error: 'At least one recipient is required' });
    const invalid = recipients.filter(r => !EMAIL_RE.test(r));
    if (invalid.length) return res.status(400).json({ error: `Not a valid email address: ${invalid.join(', ')}` });
  }
  const substitute = (text) => String(text).replace(/\{\{(\w+)\}\}/g, (m, key) => (variables && variables[key] != null ? variables[key] : m));
  const finalSubject = substitute(subject);
  const finalBody = substitute(body_html);
  const results = [];
  for (const recipient of recipients) {
    const { emailError } = await sendMailChecked(req.user.org_id, recipient, finalSubject, finalBody, { sentBy: req.user.id });
    results.push({ to: recipient, emailError });
  }
  const failed = results.filter(r => r.emailError);
  res.json({ ok: !failed.length, sent: results.length - failed.length, failed: failed.length, results });
});

export default router;
