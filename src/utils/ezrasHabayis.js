import { db, uuid } from '../db.js';

// "Ezras Habayis" applicants don't go through a shul — they self-apply
// directly. Rather than requiring a real shul record for every submission,
// every season gets exactly one permanent, locked system shul named
// "Ezras Habayis" that all of that season's Ezras Habayis applicants
// auto-attach to. It's excluded from normal shul management/portal flows
// (see shuls.js's public-list endpoint and admin list filtering) — nobody
// manages it as a real shul, and it has no portal login.
export function getOrCreateEzrasHabayisShul(orgId, seasonId) {
  const existing = seasonId
    ? db.prepare(`SELECT * FROM shuls WHERE org_id = ? AND season_id = ? AND is_locked = 1 AND name_en = 'Ezras Habayis'`).get(orgId, seasonId)
    : db.prepare(`SELECT * FROM shuls WHERE org_id = ? AND season_id IS NULL AND is_locked = 1 AND name_en = 'Ezras Habayis'`).get(orgId);
  if (existing) return existing;

  const id = uuid();
  db.prepare(`INSERT INTO shuls (id, org_id, season_id, name_en, name_he, address, city, state, zip,
      ruv_first_name, ruv_last_name, ruv_phone, gabai_first_name, gabai_last_name, gabai_cell, gabai_email,
      status, source, slots_allocated, is_locked)
    VALUES (?,?,?,'Ezras Habayis','','N/A','N/A','NA','00000', 'N/A','N/A','000-000-0000', 'N/A','N/A','000-000-0000','ezras-habayis@system.local',
      'approved','admin', 0, 1)`)
    .run(id, orgId, seasonId || null);
  return db.prepare('SELECT * FROM shuls WHERE id = ?').get(id);
}
