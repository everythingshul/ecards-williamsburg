import { Router } from 'express';
import { db } from '../db.js';
import { auth } from '../middleware/auth.js';

const router = Router();
router.use(auth);

// Per-user preferences (e.g. which list columns to show, and in what
// order) — scoped to the signed-in user's own account, any internal or
// portal role can read/write their own. No admin gate: this is never
// someone else's data, just "how I like my own screen laid out."
router.get('/:key', (req, res) => {
  const row = db.prepare('SELECT value FROM user_preferences WHERE user_id = ? AND key = ?').get(req.user.id, req.params.key);
  res.json({ value: row ? JSON.parse(row.value) : null });
});

router.put('/:key', (req, res) => {
  const { value } = req.body || {};
  if (value === undefined) return res.status(400).json({ error: 'value is required' });
  db.prepare(`INSERT INTO user_preferences (user_id, key, value) VALUES (?,?,?)
    ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`)
    .run(req.user.id, req.params.key, JSON.stringify(value));
  res.json({ ok: true });
});

export default router;
