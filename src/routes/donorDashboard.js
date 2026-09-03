import { Router } from 'express';
import { db } from '../db.js';
import { auth } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';

const router = Router();
// Donor's Dash (frontend/admin/donor-dashboard.html) is its own separately
// grantable resource — deliberately NOT gated on 'dashboard' (see
// middleware/permissions.js's PERMISSION_RESOURCES), so an admin can hand
// this out to someone (e.g. a board member / fundraising lead) without also
// handing them the main operational Dashboard, and vice versa. Every number
// here is org-wide, never scoped to one shul/store, matching routes/
// dashboard.js's own reasoning for requiring this at the router level.
router.use(auth, requirePermission('donor_dashboard'));

// Same shape of numbers as routes/dashboard.js's GET /stats and GET /daily
// (reused deliberately — one source of truth for what "approved funds"/
// "total spent" mean), just packaged for a chart-first page instead of flat
// stat tiles, and under this page's own permission instead of piggybacking
// on 'dashboard'.
router.get('/stats', (req, res) => {
  const orgId = req.user.org_id;
  const seasonId = req.query.season_id || '';
  const seasonClause = seasonId ? ' AND season_id = ?' : '';
  const seasonParams = seasonId ? [seasonId] : [];

  const applicantsTotal = db.prepare(`SELECT COUNT(*) c FROM applicants WHERE org_id = ?${seasonClause}`).get(orgId, ...seasonParams).c;
  const applicantsByStatus = db.prepare(`SELECT approval_status, COUNT(*) c FROM applicants WHERE org_id = ?${seasonClause} GROUP BY approval_status`).all(orgId, ...seasonParams);
  const statusCount = (s) => applicantsByStatus.find(r => r.approval_status === s)?.c || 0;
  const applicants = {
    total: applicantsTotal,
    pending: statusCount('pending'),
    approved: statusCount('approved'),
    rejected: statusCount('rejected'),
    // Everything else (incomplete/draft/soft_rejected — mid-flow states,
    // not a real yes/no/waiting decision) grouped into one "other" slice so
    // the pie stays readable instead of fragmenting into every status.
    other: applicantsTotal - statusCount('pending') - statusCount('approved') - statusCount('rejected'),
  };

  const shulsTotal = db.prepare(`SELECT COUNT(*) c FROM shuls WHERE org_id = ? AND is_locked = 0${seasonClause}`).get(orgId, ...seasonParams).c;
  const shulsByStatus = db.prepare(`SELECT status, COUNT(*) c FROM shuls WHERE org_id = ? AND is_locked = 0${seasonClause} GROUP BY status`).all(orgId, ...seasonParams);
  const shulStatusCount = (s) => shulsByStatus.find(r => r.status === s)?.c || 0;
  const shuls = {
    total: shulsTotal,
    // submitted/contract_sent/contract_signed are all "still in progress
    // toward approval" from a donor's-eye view — same grouping the main
    // Dashboard's pending-shuls count uses.
    pending: shulStatusCount('submitted') + shulStatusCount('contract_sent') + shulStatusCount('contract_signed'),
    approved: shulStatusCount('approved'),
    rejected: shulStatusCount('rejected'),
  };

  const cardsTotal = db.prepare(`SELECT COUNT(*) c FROM cards WHERE org_id = ?${seasonClause}`).get(orgId, ...seasonParams).c;
  const cardsByStatus = db.prepare(`SELECT status, COUNT(*) c FROM cards WHERE org_id = ?${seasonClause} GROUP BY status`).all(orgId, ...seasonParams);
  const cardStatusCount = (s) => cardsByStatus.find(r => r.status === s)?.c || 0;
  const cards = {
    total: cardsTotal,
    unassigned: cardStatusCount('unassigned'),
    assigned: cardStatusCount('assigned'),
    activated: cardStatusCount('activated'),
    // deactivated + lost grouped together (both mean "no longer a live
    // card"), same reasoning as applicants.other above.
    deactivated: cardStatusCount('deactivated') + cardStatusCount('lost'),
  };

  // Same two formulas as routes/dashboard.js's funds panel: loaded is every
  // approved applicant's committed card_amount (pushed to disccardpromos at
  // approval, independent of whether a physical card has been assigned
  // yet); spent sums every negative (purchase) card_transactions row for
  // this org/season via the card's own season, same negative-amount-is-a-
  // purchase convention used everywhere else in the app.
  const loaded = db.prepare(`SELECT COALESCE(SUM(card_amount),0) t FROM applicants WHERE org_id = ? AND approval_status = 'approved'${seasonClause}`).get(orgId, ...seasonParams).t;
  const storeSeasonClause = seasonId ? ' AND c2.season_id = ?' : '';
  const spent = db.prepare(`SELECT COALESCE(SUM(CASE WHEN t.amount < 0 THEN -t.amount ELSE 0 END),0) s
    FROM card_transactions t JOIN cards c2 ON c2.id = t.card_id WHERE c2.org_id = ?${storeSeasonClause}`).get(orgId, ...seasonParams).s;
  const funds = { loaded, spent, remaining: Math.round((loaded - spent) * 100) / 100 };

  const duplicatesOpen = db.prepare(`SELECT COUNT(*) c FROM duplicate_flags WHERE org_id = ? AND status = 'open'`).get(orgId).c;

  res.json({ applicants, shuls, cards, funds, duplicatesOpen });
});

router.get('/daily', (req, res) => {
  const orgId = req.user.org_id;
  const seasonId = req.query.season_id || '';
  const days = Math.min(90, Math.max(1, +req.query.days || 30));
  const seasonClause = seasonId ? ' AND season_id = ?' : '';
  const seasonParams = seasonId ? [seasonId] : [];

  const dates = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    dates.push(d.toISOString().slice(0, 10));
  }
  const since = dates[0];
  const toMap = (rows) => Object.fromEntries(rows.map(r => [r.d, r.c]));
  const newApplicants = toMap(db.prepare(`SELECT date(created_at) d, COUNT(*) c FROM applicants WHERE org_id = ? AND date(created_at) >= ?${seasonClause} GROUP BY d`).all(orgId, since, ...seasonParams));
  const approved = toMap(db.prepare(`SELECT date(approved_at) d, COUNT(*) c FROM applicants WHERE org_id = ? AND approval_status = 'approved' AND date(approved_at) >= ?${seasonClause} GROUP BY d`).all(orgId, since, ...seasonParams));
  const loadedRows = db.prepare(`SELECT date(approved_at) d, COALESCE(SUM(card_amount),0) c FROM applicants WHERE org_id = ? AND approval_status = 'approved' AND date(approved_at) >= ?${seasonClause} GROUP BY d`).all(orgId, since, ...seasonParams);
  const loaded = Object.fromEntries(loadedRows.map(r => [r.d, r.c]));

  const daily = dates.map(d => ({ date: d, newApplicants: newApplicants[d] || 0, approved: approved[d] || 0, loaded: loaded[d] || 0 }));
  res.json({ daily });
});

export default router;
