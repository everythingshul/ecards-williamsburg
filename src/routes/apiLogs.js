import { Router } from 'express';
import { auth, requireRole } from '../middleware/auth.js';
import { db } from '../db.js';
import { sendXlsx } from '../services/xlsx.js';

const router = Router();
// Request-level trace (see middleware/requestLog.js), strictly more
// sensitive than services/audit.js's entity-mutation trail since it's every
// request including ones that never touch a "real" resource — hardcoded
// super_admin only, same as routes/audit.js, deliberately NOT a grantable
// permission (middleware/permissions.js).
router.use(auth, requireRole('super_admin'));

function buildWhere(req) {
  const { method, status, user_id, path, hours } = req.query;
  let where = 'WHERE org_id = ?';
  const params = [req.user.org_id];
  if (method) { where += ' AND method = ?'; params.push(method); }
  if (status) { where += ' AND status_code = ?'; params.push(+status); }
  if (user_id) { where += ' AND user_id = ?'; params.push(user_id); }
  if (path) { where += ' AND path LIKE ?'; params.push(`%${path}%`); }
  if (hours) { where += ` AND created_at >= datetime('now', ?)`; params.push(`-${Math.min(168, Math.max(1, +hours))} hours`); }
  return { where, params };
}

router.get('/', (req, res) => {
  const { where, params } = buildWhere(req);
  const rows = db.prepare(`SELECT * FROM api_request_logs ${where} ORDER BY created_at DESC LIMIT 500`).all(...params);
  res.json({ logs: rows });
});

// Full detail, no 500-row cap — same "Export CSV/XLSX, no pagination"
// pattern as every other /export endpoint in this app.
router.get('/export', (req, res) => {
  const { where, params } = buildWhere(req);
  const rows = db.prepare(`SELECT * FROM api_request_logs ${where} ORDER BY created_at DESC`).all(...params);
  sendXlsx(res, `api-logs-${Date.now()}.xlsx`, rows, ['method', 'path', 'status_code', 'duration_ms', 'user_email', 'user_role', 'ip_address', 'created_at']);
});

export default router;
