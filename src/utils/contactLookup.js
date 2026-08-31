// Reverse lookup: given a phone number or email address as it appears on an
// SMS/email log row, find which account it belongs to (shul, store,
// applicant, or staff user). Powers the "Account" column in the SMS/Email
// Center logs — useful because inbound messages and group/broadcast sends
// don't carry a related_entity_type/id the way a single entity-triggered
// send does, so that column alone can't answer "who is this."
//
// Matches against the same normalized phone format normalizePhone() writes
// everywhere else (see db.js's normalizePhoneColumn migration), so this
// works against existing data without a backfill.
import { db } from '../db.js';
import { normalizePhone } from './phone.js';
import { getActiveSeasonId } from './formSchedule.js';

// Shuls and applicants get a fresh row every season, so the SAME phone
// number (a gabai's cell, say) can legitimately match more than one row —
// one per season they've ever been enrolled. Preferring the org's active
// season on a tie means an SMS/email thread gets attributed to the CURRENT
// enrollment, not whichever old row SQLite happened to return first; still
// falls back to any match (most recently created) if there's no
// active-season match, so historical messages stay attributable too.
function preferActiveSeason(orgId) {
  const seasonId = getActiveSeasonId(orgId);
  return { clause: seasonId ? ' ORDER BY (season_id = ?) DESC, created_at DESC' : ' ORDER BY created_at DESC', param: seasonId };
}

export function findAccountByPhone(orgId, rawPhone) {
  if (!rawPhone) return null;
  const phone = normalizePhone(rawPhone);
  if (!phone) return null;
  const { clause, param } = preferActiveSeason(orgId);
  const orderParams = param ? [param] : [];

  const shul = db.prepare(`SELECT id, name_en AS label, season_id FROM shuls WHERE org_id = ? AND (gabai_cell = ? OR ruv_phone = ?)${clause}`).get(orgId, phone, phone, ...orderParams);
  if (shul) return { type: 'shul', id: shul.id, label: shul.label, season_id: shul.season_id };

  const store = db.prepare(`SELECT id, name AS label FROM stores WHERE org_id = ? AND (manager_phone = ? OR owner_phone = ? OR phone = ?)`).get(orgId, phone, phone, phone);
  if (store) return { type: 'store', id: store.id, label: store.label, season_id: null };

  const applicant = db.prepare(`SELECT id, (first_name || ' ' || last_name) AS label, season_id FROM applicants WHERE org_id = ? AND (husband_cell = ? OR wife_cell = ? OR home_phone = ?)${clause}`).get(orgId, phone, phone, phone, ...orderParams);
  if (applicant) return { type: 'applicant', id: applicant.id, label: applicant.label, season_id: applicant.season_id };

  const user = db.prepare(`SELECT id, (first_name || ' ' || last_name) AS label FROM users WHERE org_id = ? AND phone = ?`).get(orgId, phone);
  if (user) return { type: 'user', id: user.id, label: user.label, season_id: null };

  return null;
}

export function findAccountByEmail(orgId, rawEmail) {
  if (!rawEmail) return null;
  const email = String(rawEmail).trim().toLowerCase();
  if (!email) return null;
  const { clause, param } = preferActiveSeason(orgId);
  const orderParams = param ? [param] : [];

  const shul = db.prepare(`SELECT id, name_en AS label, season_id FROM shuls WHERE org_id = ? AND LOWER(gabai_email) = ?${clause}`).get(orgId, email, ...orderParams);
  if (shul) return { type: 'shul', id: shul.id, label: shul.label, season_id: shul.season_id };

  const store = db.prepare(`SELECT id, name AS label FROM stores WHERE org_id = ? AND (LOWER(manager_email) = ? OR LOWER(owner_email) = ?)`).get(orgId, email, email);
  if (store) return { type: 'store', id: store.id, label: store.label, season_id: null };

  const applicant = db.prepare(`SELECT id, (first_name || ' ' || last_name) AS label, season_id FROM applicants WHERE org_id = ? AND LOWER(email) = ?${clause}`).get(orgId, email, ...orderParams);
  if (applicant) return { type: 'applicant', id: applicant.id, label: applicant.label, season_id: applicant.season_id };

  const user = db.prepare(`SELECT id, (first_name || ' ' || last_name) AS label FROM users WHERE org_id = ? AND LOWER(email) = ?`).get(orgId, email);
  if (user) return { type: 'user', id: user.id, label: user.label, season_id: null };

  return null;
}
