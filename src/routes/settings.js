import { Router } from 'express';
import { db, uuid } from '../db.js';
import { auth, requireRole } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import { isMockMode, getCustomerByExternalId } from '../services/giftcard.js';
import { SYSTEM_EMAIL_TEMPLATES } from '../services/mail.js';
import { runBackup, listBackups, backupPath } from '../services/backup.js';

const router = Router();
// Every route in this file is only ever called from the admin Settings page
// (frontend/admin/settings.html) — no shul/store portal or public page
// calls anything here, so a blanket 'settings' view gate is correct for the
// whole router, not just the individually-gated mutations below. Contract/
// agreement template config (PDF upload, signature placement, contract
// field placement) and site content live in their own gated route files
// now (contractSettings.js, siteContent.js) — see PERMISSION_RESOURCES.
router.use(auth, requirePermission('settings'));

// Generic org-scoped key/value settings (contract template text, gmaps key display, etc.)
router.get('/', (req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings WHERE org_id = ?').all(req.user.org_id);
  res.json({ settings: Object.fromEntries(rows.map(r => [r.key, r.value])) });
});

router.put('/', requirePermission('settings', 'can_edit'), (req, res) => {
  const upsert = db.prepare(`INSERT INTO settings (org_id, key, value) VALUES (?,?,?)
    ON CONFLICT(org_id, key) DO UPDATE SET value = excluded.value`);
  for (const [key, value] of Object.entries(req.body || {})) upsert.run(req.user.org_id, key, String(value ?? ''));
  res.json({ ok: true });
});

// Surfaces whether disccardpromos is actually live or silently running in
// mock mode (both env vars must be set for it to be live — see
// services/giftcard.js's isMockMode()) directly in the admin UI, since mock
// mode returns fake success for every call with no error anywhere, so
// there's otherwise no way to tell from inside the app that it's not real.
router.get('/giftcard-status', (req, res) => {
  const mockMode = isMockMode();
  const missing = mockMode ? [!process.env.DISCCARDPROMOS_API_BASE && 'DISCCARDPROMOS_API_BASE', !process.env.DISCCARDPROMOS_API_KEY && 'DISCCARDPROMOS_API_KEY'].filter(Boolean) : [];
  res.json({ mockMode, missing });
});

// What Package/Discount IDs actually exist on disccardpromos right now —
// the only signal a wrong Package (Discount) ID gives back is add-funds
// failing with "Discount id N not found" at approval time, which is a bad
// way to discover the field's gone stale (a package renumbered, deleted,
// or belongs to a different account there). There's no confirmed separate
// "list packages" endpoint against their real API docs (see
// services/giftcard.js's file header) — packages only ever come back
// embedded on a Customer record — so this borrows whichever applicant
// already has a disccardpromos account and reads its packages array as a
// stand-in for what's available account-wide.
router.get('/giftcard-packages', async (req, res) => {
  if (isMockMode()) return res.json({ mockMode: true, packages: [] });
  const applicant = db.prepare(`SELECT external_id, season_id FROM applicants WHERE org_id = ? AND provider_account_id IS NOT NULL ORDER BY created_at DESC LIMIT 1`).get(req.user.org_id);
  if (!applicant) return res.json({ packages: [], note: 'No disccardpromos customer exists yet to check against — approve at least one applicant first, then look this up again.' });
  try {
    const customer = await getCustomerByExternalId(applicant.season_id, applicant.external_id, { balances: false });
    res.json({ packages: customer?.packages || [] });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Auto-email message editor — every key in SYSTEM_EMAIL_TEMPLATES (contract
// ready, shul approved, applicant approved, store welcome, user invite,
// password reset), each with either the built-in default or this org's
// saved override. Only ever returns/accepts the {{var}} placeholder text —
// the actual substitution happens at send time in renderSystemTemplate().
router.get('/email-templates', requirePermission('settings'), (req, res) => {
  const overrides = Object.fromEntries(db.prepare('SELECT key, subject, body, reply_to FROM system_email_templates WHERE org_id = ?').all(req.user.org_id).map(r => [r.key, r]));
  const defaultReplyTo = db.prepare(`SELECT value FROM settings WHERE org_id = ? AND key = 'email_reply_to'`).get(req.user.org_id)?.value || '';
  const templates = Object.entries(SYSTEM_EMAIL_TEMPLATES).map(([key, def]) => ({
    key, label: def.label, vars: def.vars,
    subject: overrides[key]?.subject ?? def.subject, body: overrides[key]?.body ?? def.body,
    replyTo: overrides[key]?.reply_to || '', defaultReplyTo,
    isCustomized: !!overrides[key], defaultSubject: def.subject, defaultBody: def.body,
  }));
  res.json({ templates });
});

router.put('/email-templates/:key', requirePermission('settings', 'can_edit'), (req, res) => {
  const { key } = req.params;
  if (!SYSTEM_EMAIL_TEMPLATES[key]) return res.status(404).json({ error: 'Unknown template key' });
  const { subject, body, reply_to } = req.body || {};
  if (!subject || !body) return res.status(400).json({ error: 'subject and body are required' });
  // reply_to undefined (caller didn't send the field at all) preserves
  // whatever was already saved; '' explicitly clears it back to "use the
  // org-wide default" rather than being coerced to null and losing the row's
  // existing value on a save that only touched subject/body.
  const existing = db.prepare('SELECT reply_to FROM system_email_templates WHERE org_id = ? AND key = ?').get(req.user.org_id, key);
  const replyTo = reply_to !== undefined ? (reply_to || null) : (existing?.reply_to || null);
  db.prepare(`INSERT INTO system_email_templates (id, org_id, key, subject, body, reply_to) VALUES (?,?,?,?,?,?)
    ON CONFLICT(org_id, key) DO UPDATE SET subject=excluded.subject, body=excluded.body, reply_to=excluded.reply_to, updated_at=datetime('now')`)
    .run(uuid(), req.user.org_id, key, subject, body, replyTo);
  res.json({ ok: true });
});

// Revert to the built-in default (just deletes the override row).
router.delete('/email-templates/:key', requirePermission('settings', 'can_edit'), (req, res) => {
  db.prepare('DELETE FROM system_email_templates WHERE org_id = ? AND key = ?').run(req.user.org_id, req.params.key);
  res.json({ ok: true });
});

// Backups — super_admin only, not the general requireAdmin roster. The raw
// SQLite file is a complete copy of every applicant/shul/store/card record
// plus password hashes; that's a materially bigger blast radius than what
// staff/org_admin normally touch, so it gets its own tighter gate.
router.get('/backups', requireRole('super_admin'), (req, res) => {
  res.json({ backups: listBackups() });
});

router.post('/backups/run', requireRole('super_admin'), async (req, res) => {
  try {
    const path = await runBackup();
    res.json({ ok: true, backups: listBackups(), created: path.split('/').pop() });
  } catch (e) { res.status(500).json({ error: `Backup failed: ${e.message}` }); }
});

router.get('/backups/:filename/download', requireRole('super_admin'), (req, res) => {
  const path = backupPath(req.params.filename);
  if (!path) return res.status(404).json({ error: 'Backup not found' });
  res.download(path, req.params.filename);
});

// Fresh snapshot, right now, streamed straight to the browser — the
// "get me a copy off this server immediately" action, independent of the
// automatic rotation schedule.
router.get('/backups/download-now', requireRole('super_admin'), async (req, res) => {
  try {
    const path = await runBackup();
    res.download(path, path.split('/').pop());
  } catch (e) { res.status(500).json({ error: `Backup failed: ${e.message}` }); }
});

export default router;
