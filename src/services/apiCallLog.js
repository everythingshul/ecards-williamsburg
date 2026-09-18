// Outbound-call trace for Admin > Logs' "Provider Calls" tab — the mirror
// image of middleware/requestLog.js's api_request_logs (which tracks
// requests THIS app received). This tracks requests this app SENT to a
// third-party provider (disccardpromos, Brevo email, SMS), so "did a batch
// operation actually make one bulk call or N per-record calls" and "why did
// this send fail" are answerable from the admin UI — this app's deployed
// environment gives admins no server console access, so a real HTTP trace
// they can filter/search themselves is the only way to verify provider
// traffic without asking a developer to read logs on their behalf.
import { db, uuid, DEFAULT_ORG_ID } from '../db.js';

// Truncates before writing — request/response summaries are for a human
// skimming a list, not a full payload dump, and this keeps one noisy call
// from bloating the table.
// 600 chars (was 2000): after the 2026-09-17 incident, where a burst of
// provider calls filled the persistent disk with this table, the stored
// bodies are kept short — enough to see the endpoint/status/error and
// the start of a payload, not a dump.
function clip(s, max = 600) {
  if (s == null) return null;
  const str = typeof s === 'string' ? s : JSON.stringify(s);
  return str.length > max ? str.slice(0, max) + '…' : str;
}

// Never throws — a logging failure must never break the real provider call
// it's describing. orgId defaults to DEFAULT_ORG_ID since this app is
// single-org and most call sites (services/giftcard.js in particular) only
// have a seasonId in hand, not an orgId, at the point they'd log this.
export function logApiCall(provider, { orgId, method, endpoint, requestSummary, statusCode, success, responseSummary, errorMessage, durationMs, relatedEntityType, relatedEntityId, seasonId } = {}) {
  try {
    db.prepare(`INSERT INTO provider_call_log
      (id, org_id, provider, method, endpoint, request_summary, status_code, success, response_summary, error_message, duration_ms, related_entity_type, related_entity_id, season_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(uuid(), orgId || DEFAULT_ORG_ID, provider, method, endpoint, clip(requestSummary), statusCode ?? null, success ? 1 : 0, clip(responseSummary), clip(errorMessage, 2000), durationMs ?? null, relatedEntityType || null, relatedEntityId || null, seasonId || null);
  } catch (e) {
    console.error('[apiCallLog] failed to write:', e.message);
  }
}

function apiCallLogWhere(orgId, { provider, success, search, hours } = {}) {
  let where = 'WHERE org_id = ?';
  const params = [orgId];
  if (provider) { where += ' AND provider = ?'; params.push(provider); }
  if (success === '0' || success === 0 || success === false) { where += ' AND success = 0'; }
  else if (success === '1' || success === 1 || success === true) { where += ' AND success = 1'; }
  if (search) {
    where += ' AND (endpoint LIKE ? OR request_summary LIKE ? OR response_summary LIKE ? OR error_message LIKE ?)';
    const like = `%${search}%`;
    params.push(like, like, like, like);
  }
  if (hours) { where += ` AND created_at >= datetime('now', ?)`; params.push(`-${Math.min(8760, Math.max(1, +hours))} hours`); }
  return { where, params };
}

// Paginated: `limit` is the page size (capped at 10,000), `offset` the
// number of rows to skip, and the result carries `total` (the full match
// count for these filters) so the UI can show "page N of M" and step
// through every row in the retention window, not just the newest slice.
export function getApiCallLogs(orgId, { provider, success, search, hours, limit = 500, offset = 0 } = {}) {
  const { where, params } = apiCallLogWhere(orgId, { provider, success, search, hours });
  const pageSize = Math.min(10000, Math.max(1, +limit || 500));
  const skip = Math.max(0, +offset || 0);
  const total = db.prepare(`SELECT COUNT(*) AS n FROM provider_call_log ${where}`).get(...params).n;
  const logs = db.prepare(`SELECT * FROM provider_call_log ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params, pageSize, skip);
  return { logs, total, limit: pageSize, offset: skip };
}

// Called once at boot (index.js). A row per outbound call grows fast once
// the 60-second card-sync sweep and every mail/SMS send are all logging
// here — and after the 2026-09-17 incident (a burst of per-customer calls
// filled the disk faster than a daily prune could react) this runs HOURLY,
// keeps 7 days, caps the table at the newest 100,000 rows regardless of
// age, and deletes in small batches with a WAL RESTART checkpoint between
// them so it keeps working even when the disk is nearly full. The same
// pass also runs at boot before migrations (db.js's emergencyLogPrune).
export function startProviderCallLogPruning(retentionDays = 7, maxRows = 100000) {
  const prune = () => {
    try {
      for (let i = 0; i < 200; i++) {
        let n = db.prepare(`DELETE FROM provider_call_log WHERE rowid IN (
            SELECT rowid FROM provider_call_log WHERE created_at < datetime('now', ?) LIMIT 2000)`).run(`-${retentionDays} days`).changes;
        if (!n) n = db.prepare(`DELETE FROM provider_call_log WHERE rowid IN (
            SELECT rowid FROM provider_call_log ORDER BY created_at DESC LIMIT 2000 OFFSET ?)`).run(maxRows).changes;
        if (!n) break;
        try { db.pragma('wal_checkpoint(RESTART)'); } catch {}
      }
    } catch (e) { console.error('[apiCallLog] prune failed:', e.message); }
  };
  setTimeout(prune, 60 * 1000);
  setInterval(prune, 60 * 60 * 1000);
}
