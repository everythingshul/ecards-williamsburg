import { Router } from 'express';
import { auth } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import { getRecentActions, undoAuditEntry } from '../services/audit.js';

const router = Router();
// This is a full activity feed across every entity in the org (every
// applicant/shul/store/card change, who made it, from what IP), plus the
// ability to reverse changes — a materially different power than most
// resources, so it's denied by default for everyone but super_admin (see
// RESOURCE_DEFAULT_OVERRIDES in permissions.js) unless an admin explicitly
// grants it to a specific user via Users & Permissions.
router.use(auth, requirePermission('audit'));

router.get('/recent', (req, res) => {
  const hours = Math.min(168, Math.max(1, +req.query.hours || 48));
  res.json({ actions: getRecentActions(req.user.org_id, hours) });
});

router.post('/:id/undo', requirePermission('audit', 'can_edit'), (req, res) => {
  try {
    const newEntryId = undoAuditEntry(req.params.id, req.user, req.ip);
    res.json({ ok: true, undoEntryId: newEntryId });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

export default router;
