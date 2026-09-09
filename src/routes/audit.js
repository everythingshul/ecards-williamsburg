import { Router } from 'express';
import { auth, requireRole } from '../middleware/auth.js';
import { getRecentActions, undoAuditEntry } from '../services/audit.js';

const router = Router();
// This is a full activity feed across every entity in the org (every
// applicant/shul/store/card change, who made it, from what IP), plus the
// ability to reverse changes — a materially different power than most
// resources. Hardcoded to super_admin only, not a grantable permission —
// deliberately NOT in PERMISSION_RESOURCES (middleware/permissions.js), so
// there's no Users & Permissions toggle that could ever hand this to an
// org_admin/staff member, by mistake or otherwise.
router.use(auth, requireRole('super_admin'));

router.get('/recent', (req, res) => {
  const hours = Math.min(168, Math.max(1, +req.query.hours || 48));
  res.json({ actions: getRecentActions(req.user.org_id, hours) });
});

router.post('/:id/undo', (req, res) => {
  try {
    const newEntryId = undoAuditEntry(req.params.id, req.user, req.ip);
    res.json({ ok: true, undoEntryId: newEntryId });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

export default router;
