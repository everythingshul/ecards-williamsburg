// ---------------------------------------------------------------------------
// SMS provider — SimpleSender (https://simplesender.com) REST API. MOCK MODE
// (logged only, nothing actually sent) until SMS_API_BASE / SMS_API_KEY are
// set in the deploy environment.
//
// SimpleSender's API takes a bare 10-digit `to` and a `message` field (no
// `from` — the account has a single dedicated sending number), and considers
// a "queued" response a successful hand-off, not a delivery guarantee (mirrors
// how every other status here — "sent" — is really just "accepted by the
// provider"). Base URL + key: Developer > Docs & Keys in the SimpleSender
// dashboard.
// ---------------------------------------------------------------------------

import { db, uuid, DEFAULT_ORG_ID } from '../db.js';
import { findAccountByPhone } from '../utils/contactLookup.js';

// A shul/applicant is a fresh row every season, so a message tied to one of
// those directly (meta.relatedEntityType/Id, set by whichever profile page
// sent it) is scoped to THAT row's own season — exact, no ambiguity, since
// the entity id already pins the specific season. Stores/staff users and
// group/broadcast sends have no meaningful season and get null.
function resolveSeasonId(orgId, meta, to) {
  if (meta.relatedEntityType === 'shul' && meta.relatedEntityId) {
    return db.prepare('SELECT season_id FROM shuls WHERE id = ?').get(meta.relatedEntityId)?.season_id || null;
  }
  if (meta.relatedEntityType === 'applicant' && meta.relatedEntityId) {
    return db.prepare('SELECT season_id FROM applicants WHERE id = ?').get(meta.relatedEntityId)?.season_id || null;
  }
  if (meta.relatedEntityType === 'store' || meta.relatedEntityType === 'user') return null;
  // No related entity given (inbound, or an outbound send with no known
  // link) — fall back to the same phone-match the "Account" column uses,
  // which already prefers the active season on ties (see contactLookup.js).
  return findAccountByPhone(orgId, to)?.season_id || null;
}

const CONFIG = {
  apiBase: process.env.SMS_API_BASE || '',
  apiKey: process.env.SMS_API_KEY || '',
};

export function isSmsMockMode() {
  return !CONFIG.apiBase || !CONFIG.apiKey;
}

// The org's own SimpleSender number — anything a synced message is addressed
// `to` gets classified as inbound (see classifyDirection below). Settings >
// SMS lets an admin change this if the number is ever reassigned; falls back
// to the number confirmed at setup time so sync works out of the box even
// before anyone visits that settings screen.
const DEFAULT_OWN_NUMBER = '+18555996232';
export function getOwnSmsNumber(orgId) {
  const row = db.prepare(`SELECT value FROM settings WHERE org_id = ? AND key = 'sms_own_number'`).get(orgId || DEFAULT_ORG_ID);
  return row?.value || DEFAULT_OWN_NUMBER;
}

// Sends one SMS and returns { emailError: null } on success or
// { emailError: <reason> } on failure/mock — named to match sendMailChecked's
// return shape so frontend toast-handling code can treat them identically.
// Always logs to sms_messages regardless of outcome, which is what backs
// the SMS Center's "Sent Messages" list.
export async function sendSmsChecked(orgId, to, body, meta = {}) {
  let status = 'sent', error = null;
  if (isSmsMockMode()) {
    status = 'mock';
    error = 'SMS provider not configured (SMS_API_BASE/SMS_API_KEY missing). No message was actually sent.';
    console.log(`[sms:MOCK org=${orgId || 'platform'}] To: ${to}\n${body}`);
  } else {
    try {
      const res = await fetch(`${CONFIG.apiBase}/v1/messages/send`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${CONFIG.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: String(to).replace(/\D/g, ''), message: body }),
      });
      const resBody = await res.json().catch(() => ({}));
      // A 2xx response is treated as success by default — SimpleSender's
      // documented success-status wording ("queued") isn't the only value
      // seen in practice, and requiring an exact allowlist match previously
      // caused real, successfully-sent messages to be logged as "failed"
      // whenever the provider used different wording. Only an explicit
      // failure signal in the body (or a non-2xx HTTP status) counts as a
      // real failure now.
      if (!res.ok || resBody?.status === 'failed' || resBody?.success === false || resBody?.error) {
        status = 'failed'; error = resBody?.error || resBody?.message || `SMS send failed (${res.status})`;
      }
    } catch (e) {
      status = 'failed'; error = e.message;
    }
  }
  try {
    const seasonId = resolveSeasonId(orgId || DEFAULT_ORG_ID, meta, to);
    db.prepare(`INSERT INTO sms_messages (id, org_id, direction, phone, body, status, error_message, related_entity_type, related_entity_id, season_id, sent_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(uuid(), orgId || DEFAULT_ORG_ID, 'outbound', to, body, status, error, meta.relatedEntityType || null, meta.relatedEntityId || null, seasonId, meta.sentBy || null);
  } catch (e) { console.error('[sms] failed to log sent message:', e.message); }
  return { emailError: error };
}

// Logs an inbound message (called from the public webhook route). Provider
// payload shapes vary; the webhook route normalizes to {from, body} before
// calling this.
export function logInboundSms(orgId, from, body) {
  const seasonId = findAccountByPhone(orgId || DEFAULT_ORG_ID, from)?.season_id || null;
  db.prepare(`INSERT INTO sms_messages (id, org_id, direction, phone, body, status, season_id) VALUES (?,?,?,?,?,'received',?)`)
    .run(uuid(), orgId || DEFAULT_ORG_ID, 'inbound', from, body, seasonId);
}

// ---------------------------------------------------------------------------
// Inbound sync via polling GET /v1/messages — SimpleSender doesn't support
// inbound webhooks yet, so this is the only way to see incoming replies for
// now (the webhook route above stays in place for whenever they add that).
//
// The only confirmed shape of that endpoint's response is
// `{ messages: [...], total: N }` — no sample message object and no docs
// were available when this was built. Critically, `total` (456 in the one
// response seen) suggests this returns the FULL message history, sent and
// received mixed — importing everything blindly would duplicate every
// outbound send this app already logs at send time in sendSmsChecked().
//
// Classification is now driven by the org's own SMS number (Settings > SMS,
// `sms_own_number` — confirmed by the org: anything addressed `to` that
// number is inbound) rather than guessing at a direction/type field, since
// that's a real, confirmed signal instead of a guess. `to`/`from` field
// names on each message are still a best guess covering common REST SMS
// provider conventions (no docs access) — the direction/type field guess
// below stays as a fallback for any message where a `to`/`from` field can't
// be found or doesn't match at all. If a sync run finds messages but
// classifies none of them, it logs one sample item's raw JSON so the real
// field names are visible in the server log the moment this runs against
// production credentials.
// ---------------------------------------------------------------------------
const INBOUND_DIRECTION_VALUES = ['inbound', 'in', 'received', 'incoming', 'mo'];
const OUTBOUND_DIRECTION_VALUES = ['outbound', 'out', 'sent', 'outgoing', 'mt'];

const digitsOnly = (v) => String(v ?? '').replace(/\D/g, '');

function classifyDirection(m, ownNumberDigits) {
  if (ownNumberDigits) {
    const to = digitsOnly(m.to ?? m.To ?? m.destination ?? m.recipient);
    const from = digitsOnly(m.from ?? m.From ?? m.sender ?? m.source);
    // Compare on the last 10 digits so a `+1` country-code prefix on one
    // side and not the other (or vice versa) doesn't cause a false miss.
    const ownLast10 = ownNumberDigits.slice(-10);
    if (to && ownLast10 && to.slice(-10) === ownLast10) return 'inbound';
    if (from && ownLast10 && from.slice(-10) === ownLast10) return 'outbound';
  }
  const raw = String(m.direction ?? m.type ?? m.message_type ?? m.messageType ?? '').toLowerCase();
  if (INBOUND_DIRECTION_VALUES.includes(raw)) return 'inbound';
  if (OUTBOUND_DIRECTION_VALUES.includes(raw)) return 'outbound';
  return null;
}

export async function syncInboundSms(orgId, ownNumber) {
  if (isSmsMockMode()) return { imported: 0, skipped: 0, total: 0 };
  const ownNumberDigits = digitsOnly(ownNumber);
  const res = await fetch(`${CONFIG.apiBase}/v1/messages`, { headers: { Authorization: `Bearer ${CONFIG.apiKey}` } });
  if (!res.ok) throw new Error(`SimpleSender /v1/messages failed (${res.status})`);
  const data = await res.json().catch(() => ({}));
  const messages = Array.isArray(data.messages) ? data.messages : [];

  let imported = 0, skipped = 0, classified = 0;
  const insert = db.prepare(`INSERT INTO sms_messages (id, org_id, direction, phone, body, status, provider_message_id, season_id) VALUES (?,?,?,?,?,'received',?,?)`);
  const findByProviderId = db.prepare(`SELECT 1 FROM sms_messages WHERE org_id = ? AND provider_message_id = ?`);
  const findByPhoneBody = db.prepare(`SELECT 1 FROM sms_messages WHERE org_id = ? AND direction = 'inbound' AND phone = ? AND body = ? AND created_at > datetime('now', '-2 days')`);

  for (const m of messages) {
    const direction = classifyDirection(m, ownNumberDigits);
    if (direction !== 'inbound') { skipped++; continue; }
    classified++;
    const phone = m.from || m.sender || m.phone || m.msisdn || m.source;
    const body = m.body || m.text || m.message || m.content;
    if (!phone || typeof body !== 'string') { skipped++; continue; }
    const providerId = m.id != null ? String(m.id) : (m.message_id || m.sid || m.uuid || null);
    if (providerId) {
      if (findByProviderId.get(orgId, providerId)) continue;
    } else if (findByPhoneBody.get(orgId, phone, body)) {
      continue;
    }
    insert.run(uuid(), orgId, 'inbound', phone, body, providerId, findAccountByPhone(orgId, phone)?.season_id || null);
    imported++;
  }
  // Diagnostics for whichever failure mode is actually happening in
  // production, surfaced all the way to the admin's "Check Now" click
  // (see routes/sms.js) instead of sitting only in a server log the admin
  // has no access to — nobody here has ever seen a real response from this
  // endpoint, so the two most likely blind spots are: the array itself isn't
  // under `data.messages` (rawKeys catches that — messages.length would be
  // 0 even though the provider has messages, per `total`), or it is, but the
  // per-message field names guessed in classifyDirection()/phone/body above
  // don't match the provider's real ones (sample catches that).
  const diagnostics = {};
  if (!messages.length && (data.total || Object.keys(data).length)) diagnostics.rawKeys = Object.keys(data);
  if (messages.length && classified === 0) {
    diagnostics.sample = messages[0];
    console.warn(`[sms] synced ${messages.length} message(s) from /v1/messages but classified 0 as inbound — sample item for review:`, JSON.stringify(messages[0]));
  }
  return { imported, skipped, total: data.total ?? messages.length, ...diagnostics };
}
