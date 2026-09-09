import { uuid } from '../db.js';

// Request-level trace for Admin > Logs' "API Requests" tab — every /api/*
// request gets one row (method, path, status, timing, who), independent of
// services/audit.js's audit_log (which only logs meaningful data changes,
// with a before/after diff). Listens on res.on('finish') rather than
// logging synchronously so it can be mounted once, early, before any
// router — auth (applied per-router, see routes/*.js's own `router.use(auth, ...)`)
// still runs and populates req.user well before the response actually
// finishes, so req.user is reliably available here regardless of mount order.
//
// Deliberately logs ONLY method/path/status/timing/user/ip — never a
// request or response body. Several routes handle raw card data
// (routes/shulPayments.js's /mine/sola-charge and /admin-charge) and this
// app has a standing rule, already written into services/sola.js and
// shulPayments.js, that that data is never logged anywhere in any form — a
// generic body-dump here would violate that the moment someone adds one
// without specifically excluding those routes. If per-route detail is ever
// needed later, add it narrowly on that one route, not here.
export function requestLog(db) {
  const insert = db.prepare(`INSERT INTO api_request_logs
    (id, org_id, method, path, status_code, duration_ms, user_id, user_email, user_role, ip_address)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  return (req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      // Only /api/* is meaningful here — this app serves the whole
      // frontend as static files from the same Express app (no build
      // step), so without this guard every page load/asset fetch would
      // flood the table.
      if (!req.path.startsWith('/api/')) return;
      try {
        insert.run(
          uuid(), req.user?.org_id || null, req.method, req.path, res.statusCode,
          Date.now() - start, req.user?.id || null, req.user?.email || null,
          req.user?.role || null, req.ip,
        );
      } catch (e) { console.error('[requestLog] failed to write:', e.message); }
    });
    next();
  };
}

// Called once at boot (index.js) — a row per request grows fast (this app
// already runs a 15-minute card-sync sweep and a 30-minute reminder sweep
// hitting its own API internally, on top of real traffic), so this prunes
// anything older than the retention window daily. 30 days is a starting
// default, not a considered policy — an admin who wants a different window
// should say so.
export function startRequestLogPruning(db, retentionDays = 30) {
  const prune = () => {
    try { db.prepare(`DELETE FROM api_request_logs WHERE created_at < datetime('now', ?)`).run(`-${retentionDays} days`); }
    catch (e) { console.error('[requestLog] prune failed:', e.message); }
  };
  setTimeout(prune, 60 * 1000);
  setInterval(prune, 24 * 60 * 60 * 1000);
}
