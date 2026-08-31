import { Router } from 'express';
import { db, uuid } from '../db.js';
import { auth } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import { sendXlsx } from '../services/xlsx.js';

const router = Router();
router.use(auth, requirePermission('tasks')); // internal team feature — staff/org_admin/super_admin only

router.get('/', (req, res) => {
  const { assigned_to, status, overdue, entity_type, entity_id, page = 1, pageSize = 50 } = req.query;
  let where = 'WHERE t.org_id = ?';
  const params = [req.user.org_id];
  if (assigned_to) { where += ' AND t.assigned_to = ?'; params.push(assigned_to === 'me' ? req.user.id : assigned_to); }
  if (status) { where += ' AND t.status = ?'; params.push(status); }
  if (entity_type) { where += ' AND t.entity_type = ?'; params.push(entity_type); }
  if (entity_id) { where += ' AND t.entity_id = ?'; params.push(entity_id); }
  if (overdue === 'true') { where += ` AND t.status != 'done' AND t.due_date IS NOT NULL AND t.due_date < date('now')`; }

  const total = db.prepare(`SELECT COUNT(*) c FROM tasks t ${where}`).get(...params).c;
  const offset = (Math.max(1, +page) - 1) * +pageSize;
  const rows = db.prepare(`SELECT t.*, au.first_name as assignee_first_name, au.last_name as assignee_last_name,
      cu.first_name as creator_first_name, cu.last_name as creator_last_name
    FROM tasks t
    LEFT JOIN users au ON au.id = t.assigned_to
    LEFT JOIN users cu ON cu.id = t.created_by
    ${where} ORDER BY (t.due_date IS NULL), t.due_date ASC, t.created_at DESC LIMIT ? OFFSET ?`).all(...params, +pageSize, offset);

  // Attach a display label for the linked entity, if any.
  const withEntity = rows.map(t => ({ ...t, entity_label: entityLabel(t.entity_type, t.entity_id) }));
  res.json({ tasks: withEntity, total, page: +page, pageSize: +pageSize });
});

// Full-detail CSV export. Must be registered before /:id.
router.get('/export', requirePermission('tasks', 'can_export'), (req, res) => {
  const { assigned_to, status, overdue } = req.query;
  let where = 'WHERE t.org_id = ?';
  const params = [req.user.org_id];
  if (assigned_to) { where += ' AND t.assigned_to = ?'; params.push(assigned_to === 'me' ? req.user.id : assigned_to); }
  if (status) { where += ' AND t.status = ?'; params.push(status); }
  if (overdue === 'true') { where += ` AND t.status != 'done' AND t.due_date IS NOT NULL AND t.due_date < date('now')`; }
  const rows = db.prepare(`SELECT t.*, au.first_name as assignee_first_name, au.last_name as assignee_last_name
    FROM tasks t LEFT JOIN users au ON au.id = t.assigned_to ${where} ORDER BY t.created_at DESC`).all(...params);
  sendXlsx(res, `tasks-${Date.now()}.xlsx`, rows.map(t => ({ ...t, entity_label: entityLabel(t.entity_type, t.entity_id) })));
});

router.get('/:id', (req, res) => {
  const task = db.prepare(`SELECT t.*, au.first_name as assignee_first_name, au.last_name as assignee_last_name
    FROM tasks t LEFT JOIN users au ON au.id = t.assigned_to WHERE t.id = ? AND t.org_id = ?`).get(req.params.id, req.user.org_id);
  if (!task) return res.status(404).json({ error: 'Not found' });
  res.json({ task: { ...task, entity_label: entityLabel(task.entity_type, task.entity_id) } });
});

router.post('/', requirePermission('tasks', 'can_edit'), (req, res) => {
  const { title, description, assigned_to, due_date, priority, entity_type, entity_id } = req.body || {};
  if (!title) return res.status(400).json({ error: 'Title is required' });
  if (assigned_to) {
    const assignee = db.prepare('SELECT id FROM users WHERE id = ? AND org_id = ?').get(assigned_to, req.user.org_id);
    if (!assignee) return res.status(400).json({ error: 'Assigned user not found' });
  }
  const id = uuid();
  db.prepare(`INSERT INTO tasks (id, org_id, title, description, assigned_to, created_by, entity_type, entity_id, due_date, priority)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id, req.user.org_id, title, description || '', assigned_to || null, req.user.id, entity_type || null, entity_id || null, due_date || null, priority || 'normal');
  res.status(201).json({ task: db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) });
});

router.put('/:id', requirePermission('tasks', 'can_edit'), (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!task) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  if (b.assigned_to !== undefined && b.assigned_to !== null) {
    const assignee = db.prepare('SELECT id FROM users WHERE id = ? AND org_id = ?').get(b.assigned_to, req.user.org_id);
    if (!assignee) return res.status(400).json({ error: 'Assigned user not found' });
  }
  const fields = ['title', 'description', 'assigned_to', 'due_date', 'priority', 'entity_type', 'entity_id'];
  const sets = fields.filter(f => b[f] !== undefined);
  // Reset the reminder clock whenever the due date changes, so a pushed-out
  // task doesn't get an immediate stale reminder.
  const resetReminder = b.due_date !== undefined && b.due_date !== task.due_date;
  if (sets.length || resetReminder) {
    const setSql = [...sets.map(f => `${f}=?`), resetReminder ? `last_reminded_at=NULL` : null, `updated_at=datetime('now')`].filter(Boolean).join(',');
    db.prepare(`UPDATE tasks SET ${setSql} WHERE id=?`).run(...sets.map(f => b[f]), task.id);
  }
  res.json({ task: db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id) });
});

router.post('/:id/status', requirePermission('tasks', 'can_edit'), (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!task) return res.status(404).json({ error: 'Not found' });
  const { status } = req.body || {};
  if (!['open', 'in_progress', 'done'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  db.prepare(`UPDATE tasks SET status=?, completed_at=CASE WHEN ?='done' THEN datetime('now') ELSE NULL END, updated_at=datetime('now') WHERE id=?`)
    .run(status, status, task.id);
  res.json({ task: db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id) });
});

router.post('/mass-status', requirePermission('tasks', 'can_edit'), (req, res) => {
  const { ids, status } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids array required' });
  if (!['open', 'in_progress', 'done'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  let updated = 0, skipped = 0;
  for (const id of ids) {
    const task = db.prepare('SELECT id FROM tasks WHERE id = ? AND org_id = ?').get(id, req.user.org_id);
    if (!task) { skipped++; continue; }
    db.prepare(`UPDATE tasks SET status=?, completed_at=CASE WHEN ?='done' THEN datetime('now') ELSE NULL END, updated_at=datetime('now') WHERE id=?`)
      .run(status, status, task.id);
    updated++;
  }
  res.json({ updated, skipped });
});

router.post('/mass-reassign', requirePermission('tasks', 'can_edit'), (req, res) => {
  const { ids, assigned_to } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids array required' });
  if (assigned_to) {
    const assignee = db.prepare('SELECT id FROM users WHERE id = ? AND org_id = ?').get(assigned_to, req.user.org_id);
    if (!assignee) return res.status(400).json({ error: 'Assigned user not found' });
  }
  let updated = 0, skipped = 0;
  for (const id of ids) {
    const task = db.prepare('SELECT id FROM tasks WHERE id = ? AND org_id = ?').get(id, req.user.org_id);
    if (!task) { skipped++; continue; }
    db.prepare(`UPDATE tasks SET assigned_to=?, updated_at=datetime('now') WHERE id=?`).run(assigned_to || null, task.id);
    updated++;
  }
  res.json({ updated, skipped });
});

router.post('/mass-delete', requirePermission('tasks', 'can_edit'), (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids array required' });
  let deleted = 0, skipped = 0;
  for (const id of ids) {
    const task = db.prepare('SELECT id FROM tasks WHERE id = ? AND org_id = ?').get(id, req.user.org_id);
    if (!task) { skipped++; continue; }
    db.prepare('DELETE FROM tasks WHERE id = ?').run(task.id);
    deleted++;
  }
  res.json({ deleted, skipped });
});

router.delete('/:id', requirePermission('tasks', 'can_edit'), (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!task) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM tasks WHERE id = ?').run(task.id);
  res.json({ ok: true });
});

function entityLabel(type, id) {
  if (!type || !id) return null;
  if (type === 'shul') return db.prepare('SELECT name_en as label FROM shuls WHERE id = ?').get(id)?.label || null;
  if (type === 'applicant') { const a = db.prepare('SELECT first_name, last_name FROM applicants WHERE id = ?').get(id); return a ? `${a.first_name} ${a.last_name}` : null; }
  if (type === 'store') return db.prepare('SELECT name as label FROM stores WHERE id = ?').get(id)?.label || null;
  return null;
}

export default router;
