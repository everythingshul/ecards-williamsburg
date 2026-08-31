import { Router } from 'express';
import multer from 'multer';
import { join } from 'path';
import { writeFileSync } from 'fs';
import { db, uuid, DATA_DIR } from '../db.js';
import { auth } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });
const HOMEPAGE_DIR = join(DATA_DIR, 'homepage');

// Every generic settings key the Site Content admin page (frontend/admin/
// site-content.html) reads/writes — split out of the org-wide /settings
// key-value store into its own gated surface (see 'site_content' in
// PERMISSION_RESOURCES) specifically so it can be independently locked or
// made read-only per admin, same reasoning as the Seasons split.
const SITE_CONTENT_KEYS = [
  'header_nav_buttons', 'footer_nav_buttons', 'cta_buttons',
  'homepage_hero_eyebrow', 'homepage_hero_heading',
  'homepage_schedule_heading', 'schedule_items',
  'homepage_about_heading', 'homepage_about_text',
  'faq_items',
  'homepage_image_url', 'homepage_image_alt', 'homepage_image_button_enabled', 'homepage_image_button_text',
];

router.use(auth, requirePermission('site_content'));

router.get('/', (req, res) => {
  const rows = db.prepare(`SELECT key, value FROM settings WHERE org_id = ? AND key IN (${SITE_CONTENT_KEYS.map(() => '?').join(',')})`)
    .all(req.user.org_id, ...SITE_CONTENT_KEYS);
  res.json({ settings: Object.fromEntries(rows.map(r => [r.key, r.value])) });
});

router.put('/', requirePermission('site_content', 'can_edit'), (req, res) => {
  const upsert = db.prepare(`INSERT INTO settings (org_id, key, value) VALUES (?,?,?)
    ON CONFLICT(org_id, key) DO UPDATE SET value = excluded.value`);
  // Allowlisted to this page's own keys — a narrower surface than the
  // generic /settings PUT, which accepts anything.
  for (const [key, value] of Object.entries(req.body || {})) {
    if (!SITE_CONTENT_KEYS.includes(key)) continue;
    upsert.run(req.user.org_id, key, String(value ?? ''));
  }
  res.json({ ok: true });
});

// Uploads the homepage's linkable image — moved from orgs.js (see git
// history), since it's only ever used from this page. Returns the URL to
// save via PUT / above.
router.post('/homepage-image', requirePermission('site_content', 'can_edit'), upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
  if (!req.file.mimetype.startsWith('image/')) return res.status(400).json({ error: 'File must be an image' });
  const safeName = `${uuid()}-${req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  writeFileSync(join(HOMEPAGE_DIR, safeName), req.file.buffer);
  res.json({ url: `/uploads/homepage/${safeName}` });
});

export default router;
