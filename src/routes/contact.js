import { Router } from 'express';
import { db, uuid, DEFAULT_ORG_ID } from '../db.js';
import { auth } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import { sendMailChecked } from '../services/mail.js';

const router = Router();

// Public: homepage "Contact Us" form. Stores the submission (so nothing is
// lost if the notification email fails to send — mirrors the rest of this
// app's "never silently fail" pattern) and best-effort emails the org's
// support address.
router.post('/', async (req, res) => {
  const { name, email, message } = req.body || {};
  if (!name || !email || !message) return res.status(400).json({ error: 'Name, email, and message are required' });
  const id = uuid();
  db.prepare('INSERT INTO contact_submissions (id, org_id, name, email, message) VALUES (?,?,?,?,?)').run(id, DEFAULT_ORG_ID, name, email, message);
  const org = db.prepare('SELECT support_email FROM organizations WHERE id = ?').get(DEFAULT_ORG_ID);
  if (org?.support_email) {
    const body = `<p><strong>${name}</strong> (${email}) sent a message through the Contact Us form:</p><p style="white-space:pre-wrap">${message}</p>`;
    const { emailError } = await sendMailChecked(DEFAULT_ORG_ID, org.support_email, `Contact form: ${name}`, body);
    if (emailError) console.error('[contact] notification email failed:', emailError);
  }
  res.status(201).json({ ok: true });
});

// Shown as a card on frontend/admin/site-content.html, so gated the same
// as the rest of that page rather than a separate resource of its own.
router.use(auth, requirePermission('site_content'));

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM contact_submissions WHERE org_id = ? ORDER BY created_at DESC').all(req.user.org_id);
  res.json({ submissions: rows });
});

export default router;
