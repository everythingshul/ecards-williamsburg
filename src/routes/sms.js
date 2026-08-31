import { Router } from 'express';
import { db, uuid } from '../db.js';
import { auth } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import { sendSmsChecked, logInboundSms, isSmsMockMode, syncInboundSms, getOwnSmsNumber } from '../services/sms.js';
import { sendXlsx } from '../services/xlsx.js';
import { findAccountByPhone } from '../utils/contactLookup.js';
import { getActiveSeasonId } from '../utils/formSchedule.js';

const router = Router();

// ============================= Inbound webhook (public) =============================
// No auth — this is what you point the provider's inbound-message webhook at
// (SimpleSender: Developer > Docs & Keys > Webhooks). Accepts several common
// field-name variants, including one level of nesting (some providers wrap
// the message under `data`/`message`/`payload`), and normalizes to
// {from, body} before logging.
//
// Never silently drops a payload we can't parse: an unrecognized shape still
// gets logged to the console (full raw body, so a real hit from the
// provider tells us exactly what field names to add) and stored to
// sms_messages as a 'received' row with a placeholder body, so at minimum
// the Inbox tab shows *that* something arrived even before we know how to
// read it. Always responds 200 so the provider doesn't retry.
router.post('/webhook/inbound', (req, res) => {
  const b = req.body || {};
  const nested = b.data || b.message || b.payload || {};
  const from = b.from || b.From || b.sender || b.msisdn || b.phone || b.source
    || nested.from || nested.From || nested.sender || nested.msisdn || nested.phone;
  const body = b.body || b.Body || b.text || b.message || b.content
    || nested.body || nested.Body || nested.text || nested.content;
  if (from && typeof body === 'string') {
    try { logInboundSms(null, from, body); } catch (e) { console.error('[sms] failed to log inbound message:', e.message); }
  } else {
    console.warn('[sms] inbound webhook hit with an unrecognized payload shape — logging raw body for review:', JSON.stringify(b));
    try { logInboundSms(null, from || '(unknown sender)', body || `Unrecognized webhook payload — raw: ${JSON.stringify(b).slice(0, 500)}`); }
    catch (e) { console.error('[sms] failed to log unrecognized inbound payload:', e.message); }
  }
  res.json({ ok: true });
});

router.use(auth, requirePermission('sms')); // internal team feature — staff/org_admin/super_admin only

router.get('/config', (req, res) => res.json({ mockMode: isSmsMockMode() }));

// Inbound messages have no per-recipient row the way Updates does (any admin
// can read them, there's no fixed audience), so "unread" here means "since
// this admin last opened the Inbox tab" — a per-user timestamp in the
// generic user_preferences table rather than a dedicated read-tracking table.
// Stored/compared in SQLite's own datetime('now') format ('YYYY-MM-DD
// HH:MM:SS') rather than ISO ('...THH:MM:SS.sssZ') — the two sort
// differently as plain text (space < 'T' lexicographically), so comparing
// an ISO string against created_at would silently misclassify same-day
// messages as already-seen.
function sqliteNow() { return new Date().toISOString().slice(0, 19).replace('T', ' '); }
router.get('/inbox/unread-count', (req, res) => {
  const pref = db.prepare(`SELECT value FROM user_preferences WHERE user_id = ? AND key = 'sms_inbox_seen_at'`).get(req.user.id);
  const seenAt = pref ? JSON.parse(pref.value) : '1970-01-01 00:00:00';
  const c = db.prepare(`SELECT COUNT(*) c FROM sms_messages WHERE org_id = ? AND direction = 'inbound' AND created_at > ?`).get(req.user.org_id, seenAt);
  res.json({ count: c.c });
});
router.post('/inbox/mark-seen', (req, res) => {
  db.prepare(`INSERT INTO user_preferences (user_id, key, value) VALUES (?, 'sms_inbox_seen_at', ?)
    ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`)
    .run(req.user.id, JSON.stringify(sqliteNow()));
  res.json({ ok: true });
});

// Pulls new inbound messages from SimpleSender's /v1/messages right now —
// also runs automatically on a background interval (see index.js), same
// pattern as the card-transaction sync.
router.post('/inbox/sync', async (req, res) => {
  try { res.json({ ...(await syncInboundSms(req.user.org_id, getOwnSmsNumber(req.user.org_id))), mockMode: isSmsMockMode() }); }
  catch (e) { res.status(502).json({ error: `Sync failed: ${e.message}` }); }
});

// ============================= Message log =============================
// season_id filters to that season's shul/applicant-linked messages PLUS
// every message with no season (store/staff/unmatched/group-broadcast) —
// a season filter narrowing the list shouldn't also make store or
// unattributable messages vanish, since those were never "in" any season
// to begin with (see services/sms.js's resolveSeasonId).
router.get('/', (req, res) => {
  const { search, status, direction, season_id, page = 1, pageSize = 50 } = req.query;
  let where = 'WHERE m.org_id = ?';
  const params = [req.user.org_id];
  if (status) { where += ' AND m.status = ?'; params.push(status); }
  if (direction) { where += ' AND m.direction = ?'; params.push(direction); }
  if (search) { where += ' AND (m.phone LIKE ? OR m.body LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
  if (season_id) { where += ' AND (m.season_id = ? OR m.season_id IS NULL)'; params.push(season_id); }
  const total = db.prepare(`SELECT COUNT(*) c FROM sms_messages m ${where}`).get(...params).c;
  const offset = (Math.max(1, +page) - 1) * +pageSize;
  // sent_by_name: the acting admin for anything triggered from the admin
  // side, blank for inbound messages or genuinely automatic sends.
  const rows = db.prepare(`SELECT m.*, TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')) AS sent_by_name
    FROM sms_messages m LEFT JOIN users u ON u.id = m.sent_by
    ${where} ORDER BY m.created_at DESC LIMIT ? OFFSET ?`).all(...params, +pageSize, offset);
  const messages = rows.map(r => ({ ...r, account: findAccountByPhone(req.user.org_id, r.phone) }));
  res.json({ messages, total });
});

router.get('/export', requirePermission('sms', 'can_export'), (req, res) => {
  const { season_id } = req.query;
  let where = 'WHERE m.org_id = ?';
  const params = [req.user.org_id];
  if (season_id) { where += ' AND (m.season_id = ? OR m.season_id IS NULL)'; params.push(season_id); }
  const rows = db.prepare(`SELECT m.direction, m.phone, m.body, m.status, m.error_message, m.related_entity_type, m.related_entity_id, m.created_at,
      TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')) AS sent_by_name
    FROM sms_messages m LEFT JOIN users u ON u.id = m.sent_by
    ${where} ORDER BY m.created_at DESC`).all(...params);
  const withAccount = rows.map(r => {
    const account = findAccountByPhone(req.user.org_id, r.phone);
    return { ...r, account_type: account?.type || '', account_name: account?.label || '' };
  });
  sendXlsx(res, `sms-messages-${Date.now()}.xlsx`, withAccount, ['direction', 'phone', 'account_type', 'account_name', 'body', 'status', 'error_message', 'related_entity_type', 'related_entity_id', 'sent_by_name', 'created_at']);
});

// ============================= Templates =============================
router.get('/templates/all', (req, res) => {
  const templates = db.prepare('SELECT * FROM sms_templates WHERE org_id = ? ORDER BY name').all(req.user.org_id);
  res.json({ templates });
});

router.post('/templates', requirePermission('sms', 'can_edit'), (req, res) => {
  const { name, category, body: msgBody } = req.body || {};
  if (!name || !msgBody) return res.status(400).json({ error: 'name and body are required' });
  const id = uuid();
  db.prepare(`INSERT INTO sms_templates (id, org_id, name, category, body, created_by) VALUES (?,?,?,?,?,?)`)
    .run(id, req.user.org_id, name, category || '', msgBody, req.user.id);
  res.status(201).json({ template: db.prepare('SELECT * FROM sms_templates WHERE id = ?').get(id) });
});

router.put('/templates/:id', requirePermission('sms', 'can_edit'), (req, res) => {
  const tmpl = db.prepare('SELECT * FROM sms_templates WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!tmpl) return res.status(404).json({ error: 'Not found' });
  const { name, category, body: msgBody } = req.body || {};
  db.prepare(`UPDATE sms_templates SET name=COALESCE(?,name), category=COALESCE(?,category), body=COALESCE(?,body), updated_at=datetime('now') WHERE id=?`)
    .run(name, category, msgBody, tmpl.id);
  res.json({ template: db.prepare('SELECT * FROM sms_templates WHERE id = ?').get(tmpl.id) });
});

router.delete('/templates/:id', requirePermission('sms', 'can_edit'), (req, res) => {
  const tmpl = db.prepare('SELECT * FROM sms_templates WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!tmpl) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM sms_templates WHERE id = ?').run(tmpl.id);
  res.json({ ok: true });
});

// ============================= Recipients =============================
// Powers the "send to a group" picker — resolves each group to a list of
// {label, phone} pairs from wherever that group's phone numbers actually
// live (shuls' Gabai cell, stores' manager/owner phone, applicants' own
// numbers, internal staff's users.phone). Individual entities with no phone
// on file are silently skipped (nothing to send to).
router.get('/groups/:group', (req, res) => {
  const orgId = req.user.org_id;
  let rows = [];
  if (req.params.group === 'shuls') {
    rows = db.prepare(`SELECT name_en AS label, gabai_cell AS phone FROM shuls WHERE org_id = ? AND gabai_cell IS NOT NULL AND gabai_cell != ''`).all(orgId);
  } else if (req.params.group === 'stores') {
    rows = db.prepare(`SELECT name AS label, COALESCE(NULLIF(manager_phone,''), owner_phone) AS phone FROM stores WHERE org_id = ? AND (manager_phone IS NOT NULL AND manager_phone != '' OR owner_phone IS NOT NULL AND owner_phone != '')`).all(orgId);
  } else if (req.params.group === 'applicants') {
    rows = db.prepare(`SELECT first_name || ' ' || last_name AS label, COALESCE(NULLIF(husband_cell,''), NULLIF(wife_cell,''), home_phone) AS phone FROM applicants WHERE org_id = ? AND (husband_cell IS NOT NULL AND husband_cell != '' OR wife_cell IS NOT NULL AND wife_cell != '' OR home_phone IS NOT NULL AND home_phone != '')`).all(orgId);
  } else if (req.params.group === 'staff') {
    rows = db.prepare(`SELECT first_name || ' ' || last_name AS label, phone FROM users WHERE org_id = ? AND role IN ('super_admin','org_admin','staff') AND is_active = 1 AND phone IS NOT NULL AND phone != ''`).all(orgId);
  } else {
    return res.status(400).json({ error: 'Invalid group' });
  }
  res.json({ recipients: rows.filter(r => r.phone) });
});

// ============================= Compose & send =============================
// `to` is either a single phone number, or `group` is one of
// shuls|stores|applicants|staff to broadcast to every phone on file for
// that group. {{variable}} placeholders in body are substituted from
// `variables` for single sends (groups don't get per-recipient variables —
// send the same message to everyone).
router.post('/send', requirePermission('sms', 'can_edit'), async (req, res) => {
  const { to, group, body, variables, season_id } = req.body || {};
  if (!body) return res.status(400).json({ error: 'body is required' });
  const substitute = (text) => String(text).replace(/\{\{(\w+)\}\}/g, (m, key) => (variables && variables[key] != null ? variables[key] : m));

  if (group) {
    let recipients = [];
    const orgId = req.user.org_id;
    // Shuls/applicants get a fresh row every season — an unscoped "All
    // Shuls"/"All Applicants" blast used to text literally every one of
    // those rows ever created, including shuls that never renewed and
    // applicants from seasons long over. Scoped to the given season,
    // defaulting to the org's active one. Stores/staff aren't scoped: a
    // store is one persistent record reused every season, and staff aren't
    // seasonal at all.
    const seasonId = season_id || getActiveSeasonId(orgId);
    if (group === 'shuls') recipients = db.prepare(`SELECT gabai_cell AS phone FROM shuls WHERE org_id = ? AND gabai_cell IS NOT NULL AND gabai_cell != '' AND season_id = ?`).all(orgId, seasonId);
    else if (group === 'stores') recipients = db.prepare(`SELECT COALESCE(NULLIF(manager_phone,''), owner_phone) AS phone FROM stores WHERE org_id = ?`).all(orgId);
    else if (group === 'applicants') recipients = db.prepare(`SELECT COALESCE(NULLIF(husband_cell,''), NULLIF(wife_cell,''), home_phone) AS phone FROM applicants WHERE org_id = ? AND season_id = ?`).all(orgId, seasonId);
    else if (group === 'staff') recipients = db.prepare(`SELECT phone FROM users WHERE org_id = ? AND role IN ('super_admin','org_admin','staff') AND is_active = 1 AND phone IS NOT NULL AND phone != ''`).all(orgId);
    else return res.status(400).json({ error: 'Invalid group' });
    const phones = [...new Set(recipients.map(r => r.phone).filter(Boolean))];
    if (!phones.length) return res.status(400).json({ error: 'No recipients with a phone number on file for this group' });
    let sent = 0, failed = 0;
    for (const phone of phones) {
      const { emailError } = await sendSmsChecked(orgId, phone, body, { sentBy: req.user.id });
      if (emailError) failed++; else sent++;
    }
    return res.json({ ok: true, sent, failed, total: phones.length });
  }

  if (!to) return res.status(400).json({ error: 'to or group is required' });
  const { emailError } = await sendSmsChecked(req.user.org_id, to, substitute(body), { sentBy: req.user.id });
  res.json({ ok: !emailError, emailError });
});

export default router;
