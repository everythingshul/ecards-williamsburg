import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { db, uuid } from '../db.js';
import { auth, signToken, safeUser } from '../middleware/auth.js';
import { sendMailChecked, renderSystemTemplate } from '../services/mail.js';
import { computePermissionMap } from '../middleware/permissions.js';

const router = Router();

router.post('/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
  // COLLATE NOCASE: users.email is normalized to lowercase on write and
  // backfilled at boot (see db.js), but stay case-insensitive here anyway —
  // a single un-normalized row (e.g. a skipped backfill collision) should
  // degrade to "wrong password", never to an account that can't be found.
  const user = db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE').get(String(email).trim().toLowerCase());
  if (!user || !user.password_hash || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  if (!user.is_active) return res.status(403).json({ error: 'This account has been deactivated' });
  if (user.is_paused) return res.status(423).json({ error: 'Account is paused pending duplicate resolution. Contact the administrator.', code: 'ACCOUNT_PAUSED' });
  db.prepare(`UPDATE users SET last_login_at = datetime('now') WHERE id = ?`).run(user.id);
  db.prepare(`INSERT INTO audit_log (id, org_id, user_id, action, entity_type, entity_id, ip_address) VALUES (?,?,?,?,?,?,?)`)
    .run(uuid(), user.org_id, user.id, 'login', 'user', user.id, req.ip);
  // Handed to the client so nav items it can't view are hidden outright
  // (see app.js's renderShell) instead of shown and only 403ing on click.
  res.json({ token: signToken(user), user: safeUser(user), permissions: computePermissionMap(user) });
});

router.get('/me', auth, (req, res) => {
  res.json({ user: safeUser(req.user), permissions: computePermissionMap(req.user) });
});

// Accept an invite (set initial password) — token comes from the approval email.
router.post('/accept-invite', (req, res) => {
  const { token, password } = req.body || {};
  if (!token || !password || password.length < 8) return res.status(400).json({ error: 'A valid token and an 8+ character password are required' });
  const user = db.prepare('SELECT * FROM users WHERE invite_token = ?').get(token);
  if (!user) return res.status(404).json({ error: 'Invalid or expired invite link' });
  if (user.invite_expires && new Date(user.invite_expires) < new Date()) return res.status(410).json({ error: 'This invite link has expired' });
  db.prepare(`UPDATE users SET password_hash = ?, invite_token = NULL, invite_expires = NULL, is_active = 1 WHERE id = ?`)
    .run(bcrypt.hashSync(password, 10), user.id);
  const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  res.json({ token: signToken(fresh), user: safeUser(fresh), permissions: computePermissionMap(fresh) });
});

router.post('/forgot-password', async (req, res) => {
  const { email } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE').get(String(email || '').trim().toLowerCase());
  // Always respond 200 to avoid leaking which emails exist.
  if (user) {
    const token = uuid();
    const expires = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    db.prepare('UPDATE users SET invite_token = ?, invite_expires = ? WHERE id = ?').run(token, expires, user.id);
    const resetUrl = `${process.env.APP_URL || ''}/reset-password?token=${token}`;
    const tmpl = renderSystemTemplate(user.org_id, 'passwordReset', { resetUrl });
    const { emailError } = await sendMailChecked(user.org_id, user.email, tmpl.subject, tmpl.body, { replyTo: tmpl.replyTo });
    if (emailError) console.error('[mail] password reset email failed:', emailError);
  }
  res.json({ ok: true });
});

// Redeems an "Enter Portal" code (see POST /shuls/:id/impersonate and
// /stores/:id/impersonate) for a real session on the target shul/store
// login — same shape as login/accept-invite, so the caller (see app.js's
// enterPortal()) can Auth.set() straight from the response. Never requires
// or reads the target account's actual password.
//
// Reusable within its short (2-minute) expiry window, not strictly single-
// use — redeeming twice just re-signs the same session, which is harmless.
// This used to hard-reject a second redeem (`row.used_at` was a 404), which
// meant a request that actually succeeded server-side but whose response
// got mangled/truncated in transit (some corporate networks do this
// intermittently) could never be safely retried — the client had no way to
// tell "truly invalid token" apart from "worked, but I didn't get to see
// it," and a same-token retry always lost that race with a confusing 404.
// enterPortal() now retries once on exactly that transport failure, which
// this endpoint needs to tolerate. `used_at` is still recorded, just no
// longer enforced — the 2-minute expiry remains the only real time bound,
// same as before.
router.post('/impersonate/:token', (req, res) => {
  const row = db.prepare('SELECT * FROM impersonation_tokens WHERE token = ?').get(req.params.token);
  if (!row) return res.status(404).json({ error: 'Invalid or expired link' });
  if (new Date(row.expires_at) < new Date()) return res.status(410).json({ error: 'This link has expired' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
  if (!user || !user.is_active) return res.status(404).json({ error: 'This account is no longer active' });
  if (!row.used_at) db.prepare('UPDATE impersonation_tokens SET used_at = datetime(\'now\') WHERE token = ?').run(row.token);
  res.json({ token: signToken(user), user: safeUser(user), permissions: computePermissionMap(user) });
});

// Self-service preference save — deliberately living here (gated only on
// `auth`, same as /me and /change-password above) rather than under
// routes/users.js, whose whole router is locked to super_admin/org_admin
// (see router.use there) for actual user-management actions. A 'staff' user
// picking their own page size isn't managing anyone, so it can't sit behind
// that gate. Merge-only (never replaces the whole blob) so saving one
// page's size never clobbers another page's already-saved preference.
router.put('/preferences', auth, (req, res) => {
  const { page, pageSize } = req.body || {};
  if (!page || typeof page !== 'string') return res.status(400).json({ error: 'page is required' });
  const size = +pageSize;
  if (!(size > 0)) return res.status(400).json({ error: 'pageSize must be a positive number' });
  let prefs = {};
  try { prefs = req.user.page_size_prefs ? JSON.parse(req.user.page_size_prefs) : {}; } catch { prefs = {}; }
  prefs[page] = size;
  db.prepare('UPDATE users SET page_size_prefs = ? WHERE id = ?').run(JSON.stringify(prefs), req.user.id);
  res.json({ ok: true, page_size_prefs: prefs });
});

router.post('/change-password', auth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
  if (req.user.password_hash && !bcrypt.compareSync(currentPassword || '', req.user.password_hash)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }
  db.prepare('UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?')
    .run(bcrypt.hashSync(newPassword, 10), req.user.id);
  res.json({ ok: true, message: 'Password changed. Please log in again.' });
});

export default router;
