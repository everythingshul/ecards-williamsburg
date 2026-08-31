// Due-date email reminders for the task/to-do system. Runs as a lightweight
// in-process interval (see index.js) rather than an external cron service —
// fine for a single Render web dyno; if this ever moves to a multi-instance
// deployment, move this to a dedicated scheduled job so it doesn't fire once
// per instance.
import { db } from '../db.js';
import { sendMail } from './mail.js';

export async function sendDueTaskReminders() {
  // Due today, tomorrow, or already overdue; not done; assigned to someone;
  // not reminded in the last 20 hours (so a periodic check doesn't spam).
  const rows = db.prepare(`
    SELECT t.*, u.email as assignee_email, u.first_name as assignee_first_name
    FROM tasks t
    JOIN users u ON u.id = t.assigned_to
    WHERE t.status != 'done'
      AND t.due_date IS NOT NULL
      AND date(t.due_date) <= date('now', '+1 day')
      AND (t.last_reminded_at IS NULL OR t.last_reminded_at < datetime('now', '-20 hours'))
  `).all();

  for (const t of rows) {
    if (!t.assignee_email) continue;
    try {
      const overdue = t.due_date < new Date().toISOString().slice(0, 10);
      const subject = overdue ? `Overdue task: ${t.title}` : `Task reminder: ${t.title}`;
      const body = `<p>Hi ${t.assignee_first_name || ''},</p>
        <p>${overdue ? '<strong>This task is overdue.</strong>' : 'This task is due soon.'}</p>
        <p><strong>${t.title}</strong>${t.description ? `<br>${t.description}` : ''}</p>
        <p>Due: <strong>${t.due_date}</strong></p>`;
      await sendMail(t.org_id, t.assignee_email, subject, body);
      db.prepare(`UPDATE tasks SET last_reminded_at = datetime('now') WHERE id = ?`).run(t.id);
    } catch (e) {
      console.error('[reminders] failed to send reminder for task', t.id, e.message);
    }
  }
  return rows.length;
}
