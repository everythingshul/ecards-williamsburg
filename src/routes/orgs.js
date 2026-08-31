import { Router } from 'express';
import { db, DEFAULT_ORG_ID } from '../db.js';
import { auth } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import { normalizePhone, isValidPhone } from '../utils/phone.js';

const router = Router();

// Public: org branding for the public pages (apply form, store signup, etc).
// Single-org platform, so this always resolves to the one organization.
router.get('/resolve', (req, res) => {
  const org = db.prepare('SELECT id, name, logo_url, primary_color, accent_color, support_email, support_phone, address FROM organizations WHERE id = ?').get(DEFAULT_ORG_ID);
  const rows = db.prepare(`SELECT key, value FROM settings WHERE org_id = ? AND key IN
    ('homepage_popup_enabled','homepage_popup_message','header_nav_buttons','footer_nav_buttons','cta_buttons',
     'homepage_about_text','faq_items','homepage_hero_eyebrow','homepage_hero_heading','homepage_schedule_heading','homepage_about_heading','schedule_items',
     'homepage_image_url','homepage_image_alt','homepage_image_button_enabled','homepage_image_button_text',
     'shul_contract_at_signup','store_contract_at_signup')`).all(DEFAULT_ORG_ID);
  const s = Object.fromEntries(rows.map(r => [r.key, r.value]));
  const parseList = (v) => { try { const p = JSON.parse(v || '[]'); return Array.isArray(p) ? p : []; } catch { return []; } };
  res.json({
    org,
    popup: { enabled: s.homepage_popup_enabled === '1', message: s.homepage_popup_message || '' },
    content: {
      headerButtons: parseList(s.header_nav_buttons),
      footerButtons: parseList(s.footer_nav_buttons),
      ctaButtons: parseList(s.cta_buttons),
      aboutText: s.homepage_about_text || '',
      faqItems: parseList(s.faq_items),
      heroEyebrow: s.homepage_hero_eyebrow || '',
      heroHeading: s.homepage_hero_heading || '',
      scheduleHeading: s.homepage_schedule_heading || '',
      aboutHeading: s.homepage_about_heading || '',
      scheduleItems: parseList(s.schedule_items),
      image: s.homepage_image_url ? {
        url: s.homepage_image_url, alt: s.homepage_image_alt || '',
        buttonEnabled: s.homepage_image_button_enabled === '1',
        buttonText: s.homepage_image_button_text || 'View',
      } : null,
      shulContractAtSignup: s.shul_contract_at_signup !== '0',
      storeContractAtSignup: s.store_contract_at_signup !== '0',
    },
  });
});

router.use(auth, requirePermission('settings'));

// The single organization's branding/settings — editable from Admin > Settings.
router.get('/me', (req, res) => {
  res.json({ organization: db.prepare('SELECT * FROM organizations WHERE id = ?').get(req.user.org_id) });
});

router.put('/me', requirePermission('settings', 'can_edit'), (req, res) => {
  const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(req.user.org_id);
  if (!org) return res.status(404).json({ error: 'Not found' });
  const f = req.body || {};
  if (f.support_phone !== undefined) f.support_phone = normalizePhone(f.support_phone);
  if (!isValidPhone(f.support_phone)) return res.status(400).json({ error: 'Support Phone must be a valid phone number (10 digits, or 11 digits starting with 1)' });
  db.prepare(`UPDATE organizations SET name=COALESCE(?,name), logo_url=COALESCE(?,logo_url),
    primary_color=COALESCE(?,primary_color), accent_color=COALESCE(?,accent_color),
    support_email=COALESCE(?,support_email), support_phone=COALESCE(?,support_phone), address=COALESCE(?,address) WHERE id=?`)
    .run(f.name, f.logo_url, f.primary_color, f.accent_color, f.support_email, f.support_phone, f.address, org.id);
  res.json({ organization: db.prepare('SELECT * FROM organizations WHERE id = ?').get(org.id) });
});

export default router;
