import { Router } from 'express';
import xlsx from 'xlsx';
import { db } from '../db.js';
import { auth, requireAdmin } from '../middleware/auth.js';

const router = Router();
router.use(auth, requireAdmin);

// One-click download of everything — every table, every field, every
// transaction — as a single multi-sheet Excel workbook. Deliberately not
// gated behind can_export field redaction: this is the "give me the whole
// database" button, meant for admins who already see everything.
router.get('/', (req, res) => {
  const orgId = req.user.org_id;
  const wb = xlsx.utils.book_new();
  const addSheet = (name, rows) => {
    const sheet = xlsx.utils.json_to_sheet(rows.length ? rows : [{}]);
    xlsx.utils.book_append_sheet(wb, sheet, name.slice(0, 31)); // Excel sheet name limit
  };

  addSheet('Shuls', db.prepare('SELECT * FROM shuls WHERE org_id = ? ORDER BY created_at').all(orgId));
  addSheet('Shul Notes', db.prepare(`SELECT n.*, u.email as author_email FROM shul_notes n
    JOIN shuls s ON s.id = n.shul_id LEFT JOIN users u ON u.id = n.user_id WHERE s.org_id = ? ORDER BY n.created_at`).all(orgId));
  addSheet('Contracts', db.prepare(`SELECT c.* FROM contracts c JOIN shuls s ON s.id = c.shul_id WHERE s.org_id = ? ORDER BY c.created_at`).all(orgId));
  addSheet('Applicants', db.prepare(`SELECT a.*, s.name_en as shul_name FROM applicants a LEFT JOIN shuls s ON s.id = a.shul_id WHERE a.org_id = ? ORDER BY a.created_at`).all(orgId));
  addSheet('Applicant Notes', db.prepare(`SELECT n.*, u.email as author_email FROM applicant_notes n
    JOIN applicants a ON a.id = n.applicant_id LEFT JOIN users u ON u.id = n.user_id WHERE a.org_id = ? ORDER BY n.created_at`).all(orgId));
  addSheet('Cards', db.prepare(`SELECT c.*, a.first_name, a.last_name FROM cards c LEFT JOIN applicants a ON a.id = c.applicant_id WHERE c.org_id = ? ORDER BY c.created_at`).all(orgId));
  addSheet('Card Transactions', db.prepare(`SELECT t.*, a.first_name, a.last_name, c.card_number_masked FROM card_transactions t
    JOIN cards c ON c.id = t.card_id LEFT JOIN applicants a ON a.id = c.applicant_id WHERE c.org_id = ? ORDER BY t.occurred_at`).all(orgId));
  addSheet('Stores', db.prepare('SELECT * FROM stores WHERE org_id = ? ORDER BY created_at').all(orgId));
  addSheet('Store Bills Submitted', db.prepare(`SELECT b.* FROM store_bill_submissions b JOIN stores s ON s.id = b.store_id WHERE s.org_id = ? ORDER BY b.submitted_at`).all(orgId));
  addSheet('Tasks', db.prepare(`SELECT t.*, au.email as assignee_email FROM tasks t LEFT JOIN users au ON au.id = t.assigned_to WHERE t.org_id = ? ORDER BY t.created_at`).all(orgId));
  addSheet('Users', db.prepare('SELECT id, email, first_name, last_name, role, is_active, is_paused, last_login_at, created_at FROM users WHERE org_id = ? ORDER BY created_at').all(orgId));
  addSheet('Seasons', db.prepare('SELECT * FROM seasons WHERE org_id = ? ORDER BY created_at').all(orgId));
  addSheet('Duplicate Flags', db.prepare('SELECT * FROM duplicate_flags WHERE org_id = ? ORDER BY created_at').all(orgId));
  addSheet('Audit Log', db.prepare('SELECT * FROM audit_log WHERE org_id = ? ORDER BY created_at DESC LIMIT 5000').all(orgId));

  const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="kipas-hair-bp-full-export-${Date.now()}.xlsx"`);
  res.send(buf);
});

export default router;
