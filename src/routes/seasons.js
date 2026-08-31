import { Router } from 'express';
import { db, uuid } from '../db.js';
import { auth } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';

const router = Router();
// Internal team only — no shul/store portal page ever calls this (portal
// season context, e.g. capacity banners, comes from the shul/applicant's own
// season_id, not a direct call here), and the full list exposes every
// season's applicant counts/capacity org-wide.
router.use(auth, requirePermission('seasons'));

// Adds live capacity numbers to a season row: how many applicants are
// currently approved against it, and how many slots remain (null = no cap
// set, meaning unlimited). Used by the countdown display and to decide
// whether new applications should be locked out (see applicants.js).
export function withCapacity(season) {
  if (!season) return season;
  const accepted_count = db.prepare(`SELECT COUNT(*) c FROM applicants WHERE season_id = ? AND approval_status = 'approved'`).get(season.id).c;
  const remaining = season.max_accepted_applicants != null ? Math.max(0, season.max_accepted_applicants - accepted_count) : null;
  // The disccardpromos key is a live financial credential — never echoed
  // back in plaintext once saved, same treatment as a password field. The
  // edit form only sees whether one is set, not its value; PUT only
  // changes it when a caller explicitly sends a new non-empty value.
  const { disccardpromos_api_key, ...rest } = season;
  return { ...rest, has_disccardpromos_api_key: !!disccardpromos_api_key, accepted_count, remaining, is_full: season.max_accepted_applicants != null && accepted_count >= season.max_accepted_applicants };
}

router.get('/', (req, res) => {
  const seasons = db.prepare('SELECT * FROM seasons WHERE org_id = ? ORDER BY created_at DESC').all(req.user.org_id);
  res.json({ seasons: seasons.map(withCapacity) });
});

// The single current season — every new shul/applicant/card defaults into
// this one, and admin list pages default their season filter to it. Exactly
// one season can be active at a time (enforced below), so this is just
// "whichever one has is_active = 1", falling back to the most recently
// created season if none is explicitly marked active yet.
router.get('/active', (req, res) => {
  const active = db.prepare('SELECT * FROM seasons WHERE org_id = ? AND is_active = 1 ORDER BY created_at DESC LIMIT 1').get(req.user.org_id)
    || db.prepare('SELECT * FROM seasons WHERE org_id = ? ORDER BY created_at DESC LIMIT 1').get(req.user.org_id);
  res.json({ season: withCapacity(active) });
});

router.post('/', requirePermission('seasons', 'can_edit'), (req, res) => {
  const { name, start_date, end_date, default_card_amount, max_accepted_applicants } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Name is required' });
  const id = uuid();
  // A brand new season becomes the active one — treat "start a new season"
  // as the normal way people mean to move the whole system forward.
  db.prepare('UPDATE seasons SET is_active = 0 WHERE org_id = ?').run(req.user.org_id);
  db.prepare(`INSERT INTO seasons (id, org_id, name, start_date, end_date, default_card_amount, max_accepted_applicants, is_active)
    VALUES (?,?,?,?,?,?,?,1)`).run(id, req.user.org_id, name, start_date || null, end_date || null, default_card_amount || 0, max_accepted_applicants || null);
  res.status(201).json({ season: withCapacity(db.prepare('SELECT * FROM seasons WHERE id = ?').get(id)) });
});

router.get('/:id/notes', (req, res) => {
  const season = db.prepare('SELECT id FROM seasons WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!season) return res.status(404).json({ error: 'Not found' });
  const notes = db.prepare(`SELECT n.*, u.first_name, u.last_name FROM season_notes n LEFT JOIN users u ON u.id = n.user_id WHERE n.season_id = ? ORDER BY n.created_at DESC`).all(season.id);
  res.json({ notes });
});

router.post('/:id/notes', requirePermission('seasons', 'can_edit'), (req, res) => {
  const season = db.prepare('SELECT id FROM seasons WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!season) return res.status(404).json({ error: 'Not found' });
  const { note } = req.body || {};
  if (!note) return res.status(400).json({ error: 'note is required' });
  const id = uuid();
  db.prepare('INSERT INTO season_notes (id, season_id, user_id, note) VALUES (?,?,?,?)').run(id, season.id, req.user.id, note);
  res.status(201).json({ note: db.prepare('SELECT * FROM season_notes WHERE id = ?').get(id) });
});

router.put('/:id', requirePermission('seasons', 'can_edit'), (req, res) => {
  const season = db.prepare('SELECT * FROM seasons WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!season) return res.status(404).json({ error: 'Not found' });
  const f = req.body || {};
  // Only one season may be active at a time — activating this one
  // deactivates every other season in the org first.
  if (f.is_active) db.prepare('UPDATE seasons SET is_active = 0 WHERE org_id = ?').run(req.user.org_id);
  // Explicit null clears the cap (unlimited); undefined leaves it as-is.
  const maxCap = f.max_accepted_applicants === undefined ? undefined : (f.max_accepted_applicants === null || f.max_accepted_applicants === '' ? null : +f.max_accepted_applicants);
  // Same "explicit empty string clears it back to inheriting the org-wide
  // default" convention as system_email_templates' reply_to — undefined
  // (field not sent) leaves whatever was already saved untouched.
  const apiBase = f.disccardpromos_api_base === undefined ? undefined : (f.disccardpromos_api_base || null);
  const apiKey = f.disccardpromos_api_key === undefined ? undefined : (f.disccardpromos_api_key || null);
  db.prepare(`UPDATE seasons SET name=COALESCE(?,name), start_date=COALESCE(?,start_date), end_date=COALESCE(?,end_date),
    default_card_amount=COALESCE(?,default_card_amount), max_accepted_applicants=CASE WHEN ? THEN ? ELSE max_accepted_applicants END, is_active=COALESCE(?,is_active),
    require_shul_contribution=COALESCE(?,require_shul_contribution),
    disccardpromos_api_base=CASE WHEN ? THEN ? ELSE disccardpromos_api_base END, disccardpromos_api_key=CASE WHEN ? THEN ? ELSE disccardpromos_api_key END WHERE id=?`)
    .run(f.name, f.start_date, f.end_date, f.default_card_amount, maxCap !== undefined ? 1 : 0, maxCap, f.is_active === undefined ? undefined : (f.is_active ? 1 : 0),
      f.require_shul_contribution === undefined ? undefined : (f.require_shul_contribution ? 1 : 0),
      apiBase !== undefined ? 1 : 0, apiBase, apiKey !== undefined ? 1 : 0, apiKey, season.id);
  res.json({ season: withCapacity(db.prepare('SELECT * FROM seasons WHERE id = ?').get(season.id)) });
});

export default router;
