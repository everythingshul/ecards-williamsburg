import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { db, uuid } from '../db.js';
import { auth, signToken } from '../middleware/auth.js';
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
  const { password_hash, ...safe } = user;
  // Handed to the client so nav items it can't view are hidden outright
  // (see app.js's renderShell) instead of shown and only 403ing on click.
  res.json({ token: signToken(user), user: safe, permissions: computePermissionMap(user) });
});

router.get('/me', auth, (req, res) => {
  const { password_hash, ...safe } = req.user;
  res.json({ user: safe, permissions: computePermissionMap(req.user) });
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
  const { password_hash, ...safe } = fresh;
  res.json({ token: signToken(fresh), user: safe, permissions: computePermissionMap(fresh) });
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
