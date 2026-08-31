import jwt from 'jsonwebtoken';
import { db } from '../db.js';

// render.yaml generates JWT_SECRET automatically, so production should
// always have a real one — but if a deploy ever comes up without it, silently
// falling back to a fixed, publicly-known string (visible in this repo's
// history) would let anyone forge a valid session token for any user,
// including super_admin. Fail loud instead of quietly issuing forgeable
// tokens on a platform holding financial/PII data. Local dev without a
// .env still works — only production is required to set it explicitly.
if (!process.env.JWT_SECRET && process.env.NODE_ENV === 'production') {
  throw new Error('JWT_SECRET must be set in production — refusing to start with a guessable default.');
}
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

export function signToken(user) {
  return jwt.sign({ userId: user.id, tokenVersion: user.token_version || 0 }, JWT_SECRET, { expiresIn: '30d' });
}

export function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  let decoded;
  try { decoded = jwt.verify(token, JWT_SECRET); } catch { return res.status(401).json({ error: 'Invalid or expired token' }); }
  const userId = decoded.userId || decoded.id;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user || !user.is_active) return res.status(401).json({ error: 'Account not found or disabled' });
  if ((user.token_version || 0) !== (decoded.tokenVersion || 0)) return res.status(401).json({ error: 'Session expired, please log in again' });
  if (user.is_paused) return res.status(423).json({ error: 'Account is paused pending duplicate resolution. Contact the administrator.', code: 'ACCOUNT_PAUSED' });
  req.user = user;
  next();
}

// Restrict a route to specific roles.
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
    next();
  };
}

export function requireAdmin(req, res, next) {
  if (!req.user || !['super_admin', 'org_admin', 'staff'].includes(req.user.role)) return res.status(403).json({ error: 'Admin access required' });
  next();
}
