import { Router } from 'express';
import { db, uuid, DEFAULT_ORG_ID } from '../db.js';
import { auth } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';

const router = Router();

// Public: fired by trackPageview() (frontend/js/app.js) on every public page
// load — home, apply forms, FAQ, contact, etc. Fire-and-forget from the
// caller's side, so failures here must never surface as a visible error;
// always 200s. Truncated defensively since this is unauthenticated input.
router.post('/pageview', (req, res) => {
  const { path, referrer, visitor_id } = req.body || {};
  if (typeof path === 'string' && path.trim()) {
    try {
      db.prepare('INSERT INTO page_views (id, org_id, path, referrer, visitor_id) VALUES (?,?,?,?,?)')
        .run(uuid(), DEFAULT_ORG_ID, path.trim().slice(0, 300), typeof referrer === 'string' ? referrer.trim().slice(0, 300) : null,
          typeof visitor_id === 'string' ? visitor_id.trim().slice(0, 100) : null);
    } catch (e) { console.error('[analytics] failed to log pageview:', e.message); }
  }
  res.json({ ok: true });
});

router.use(auth, requirePermission('dashboard'));

// Per-page totals + unique visitors, a daily total-views trend (zero-filled
// across the whole window, same pattern as dashboard.js's /daily), and top
// referrer hostnames — all scoped to the trailing `days` days (default 30,
// capped at 90, same convention as the main dashboard's daily breakdown).
router.get('/summary', (req, res) => {
  const orgId = req.user.org_id;
  const days = Math.min(90, Math.max(1, +req.query.days || 30));
  const dates = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    dates.push(d.toISOString().slice(0, 10));
  }
  const since = dates[0];

  const pages = db.prepare(`SELECT path, COUNT(*) views, COUNT(DISTINCT visitor_id) uniqueVisitors
    FROM page_views WHERE org_id = ? AND date(created_at) >= ? GROUP BY path ORDER BY views DESC LIMIT 50`).all(orgId, since);

  const dailyRows = db.prepare(`SELECT date(created_at) d, COUNT(*) c FROM page_views WHERE org_id = ? AND date(created_at) >= ? GROUP BY d`).all(orgId, since);
  const dailyMap = Object.fromEntries(dailyRows.map(r => [r.d, r.c]));
  const daily = dates.map(d => ({ date: d, views: dailyMap[d] || 0 }));

  const totals = db.prepare(`SELECT COUNT(*) views, COUNT(DISTINCT visitor_id) uniqueVisitors FROM page_views WHERE org_id = ? AND date(created_at) >= ?`).get(orgId, since);

  // Referrer hostnames, most-common first — the raw referrer URL can be
  // anything (query strings, paths); only the hostname is meaningful for
  // "where is traffic coming from."
  const referrerRows = db.prepare(`SELECT referrer FROM page_views WHERE org_id = ? AND date(created_at) >= ? AND referrer IS NOT NULL AND referrer != ''`).all(orgId, since);
  const refCounts = {};
  for (const r of referrerRows) {
    let host;
    try { host = new URL(r.referrer).hostname; } catch { continue; }
    if (!host) continue;
    refCounts[host] = (refCounts[host] || 0) + 1;
  }
  const referrers = Object.entries(refCounts).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([host, count]) => ({ host, count }));

  res.json({ pages, daily, referrers, totalViews: totals.views, totalUniqueVisitors: totals.uniqueVisitors });
});

export default router;
