import { db, uuid } from '../db.js';
import {
  hardDeleteShul, hardDeleteApplicant, hardDeleteStore,
  restoreShulSnapshot, restoreApplicantSnapshot, restoreStoreSnapshot,
} from '../utils/entityDelete.js';

// Dispatch tables for undoing a hard delete (shul/applicant/store):
// CASCADE_RESTORERS brings a full snapshot (see entityDelete.js) back —
// used whenever the audit_log 'before' value is one of these snapshots,
// i.e. undoing an original delete, or redoing a previous undo of one.
// HARD_DELETERS is the reverse direction — re-deleting the entity via its
// real cascade (not a naive single-row DELETE, which would violate FK
// constraints against contracts/notes a prior undo just restored) — used
// whenever the target state is "this entity shouldn't exist" (before ===
// null) for one of these three entity types, whether that's undoing a
// 'create' or redoing an original delete.
const CASCADE_RESTORERS = { 'shul-cascade': restoreShulSnapshot, 'applicant-cascade': restoreApplicantSnapshot, 'store-cascade': restoreStoreSnapshot };
const HARD_DELETERS = { shul: hardDeleteShul, applicant: hardDeleteApplicant, store: hardDeleteStore };

// ---------------------------------------------------------------------------
// Shared audit trail + generic undo/redo. Previously logAudit() was a local,
// unexported function duplicated only in shuls.js — every other route's
// mutations went completely unlogged. Pulled out here so every route can log
// consistently, and so undo/redo has one real implementation instead of N
// bespoke ones.
//
// Undo/redo works by restoring exactly the columns captured in before_json/
// after_json — NOT a full-row replace — so an undo never clobbers a column
// some *other*, later action touched. "Redo" isn't a separate code path:
// undoing an action logs a new audit_log row recording what it just did
// (before = the state right before the undo, after = the state it restored
// to); redoing is just calling undo() again on THAT new row. This keeps the
// history a simple forward-only append log instead of a branching structure.
//
// Only a curated set of action names are undoable at all (see
// UNDOABLE_ACTIONS below) — workflow/notification actions like esign, login,
// or send_contract have before/after shapes that don't represent full row
// state, and generically "restoring" them would do something destructive or
// meaningless (e.g. undoing an esign by deleting the contract row instead of
// un-signing it, which is a real, separate feature already).
// ---------------------------------------------------------------------------

// 'undo' is here deliberately: undoing an action logs a new 'undo' entry
// (see undoAuditEntry below), and that entry must itself be undoable — that
// symmetry IS how redo works, rather than a separate redo code path.
export const UNDOABLE_ACTIONS = ['create', 'update', 'delete', 'approve', 'reject', 'undo'];

// entity_type (as used in audit_log) -> real table + primary key column.
const ENTITY_TABLES = {
  shul: { table: 'shuls', pk: 'id' },
  applicant: { table: 'applicants', pk: 'id' },
  store: { table: 'stores', pk: 'id' },
  season: { table: 'seasons', pk: 'id' },
  task: { table: 'tasks', pk: 'id' },
  user: { table: 'users', pk: 'id' },
  card: { table: 'cards', pk: 'id' },
};

export function logAudit(orgId, userId, action, entityType, entityId, before, after, ip) {
  const id = uuid();
  db.prepare(`INSERT INTO audit_log (id, org_id, user_id, action, entity_type, entity_id, before_json, after_json, ip_address)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(id, orgId, userId, action, entityType, entityId, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, ip || null);
  return id;
}

// One audit_log row for an entire bulk action (mass-approve, mass-delete, a
// whole mass-upload job, ...) instead of one row per record it touched — a
// 300-row import or a 50-shul mass-approve used to flood Recent Actions with
// that many individual entries from a single click. entity_id is
// deliberately null (there's no single record this row is "about"); `ids`
// and whatever else the caller has on hand (skipped count, display names,
// the uniform value applied, ...) live in after_json instead. Never
// undoable — action names passed here are never added to UNDOABLE_ACTIONS,
// so getRecentActions' undoable check fails on the action name alone;
// reversing dozens of different records' worth of changes through the
// single-entity restore mechanism below isn't something this generically
// supports. No-ops (returns null) if nothing was actually affected — a mass
// action that skipped every row isn't worth a log entry.
export function logMassAudit(orgId, userId, action, entityType, ids, extra, ip) {
  if (!ids || !ids.length) return null;
  return logAudit(orgId, userId, action, entityType, null, null, { ids, count: ids.length, ...extra }, ip);
}

// Last N hours of audit_log for an org, newest first, with the acting user's
// name attached. `null` user_id (public form submissions, system actions)
// shows as "System".
export function getRecentActions(orgId, hours = 48) {
  const rows = db.prepare(`SELECT a.*, u.first_name, u.last_name, u.email AS user_email
    FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
    WHERE a.org_id = ? AND a.created_at >= datetime('now', ?) ORDER BY a.created_at DESC`)
    .all(orgId, `-${hours} hours`);
  // A row is only "redoable" if the undo-entry it points to hasn't itself
  // been undone yet — otherwise that undo was already consumed by a
  // previous redo (or a second undo/redo cycle), and pointing at it again
  // would hit "already undone" instead of doing anything. Looked up
  // separately since the target row can, in principle, sit outside this
  // window's LIMIT if a lot happened since — a plain id lookup is safe either way.
  const undoEntryIds = [...new Set(rows.map(r => r.undo_entry_id).filter(Boolean))];
  const consumedIds = new Set();
  if (undoEntryIds.length) {
    const placeholders = undoEntryIds.map(() => '?').join(',');
    db.prepare(`SELECT id FROM audit_log WHERE id IN (${placeholders}) AND undone_at IS NOT NULL`).all(...undoEntryIds)
      .forEach(r => consumedIds.add(r.id));
  }
  // shul_allocation isn't in ENTITY_TABLES — its reversal is money-aware
  // (checks live card balance via disccardpromos, see services/matching.js
  // reverseAllocation), not a column-restore, so it deliberately never goes
  // through the generic undo() flow above and 'undoable' is always false for
  // it. The admin UI still needs to know whether a "create" row's allocation
  // has already been reversed since — live-checked here (never cached, same
  // rule as every other money figure in this app) rather than trusted from
  // the audit row's own after_json, which is a point-in-time snapshot.
  const allocationIds = [...new Set(rows.filter(r => r.entity_type === 'shul_allocation' && r.action === 'create').map(r => r.entity_id).filter(Boolean))];
  const reversedAllocationIds = new Set();
  if (allocationIds.length) {
    const placeholders = allocationIds.map(() => '?').join(',');
    db.prepare(`SELECT id FROM shul_allocations WHERE id IN (${placeholders}) AND reversed_at IS NOT NULL`).all(...allocationIds)
      .forEach(r => reversedAllocationIds.add(r.id));
  }
  const parsed = rows.map(r => ({
    ...r,
    before: r.before_json ? JSON.parse(r.before_json) : null,
    after: r.after_json ? JSON.parse(r.after_json) : null,
  }));
  // shul_allocations before/after snapshots only carry shul_id/applicant_id,
  // not names — resolved here (live, not denormalized onto the row at
  // write time) purely so the Recent Actions headline reads "Congregation
  // X gave $250 to Jane Doe" instead of raw ids.
  const shulIds = new Set(), applicantIds = new Set();
  parsed.forEach(r => {
    if (r.entity_type !== 'shul_allocation') return;
    const snap = r.after || r.before;
    if (snap?.shul_id) shulIds.add(snap.shul_id);
    if (snap?.applicant_id) applicantIds.add(snap.applicant_id);
  });
  const shulNames = {}, applicantNames = {};
  if (shulIds.size) {
    const placeholders = [...shulIds].map(() => '?').join(',');
    db.prepare(`SELECT id, name_en FROM shuls WHERE id IN (${placeholders})`).all(...shulIds)
      .forEach(r => { shulNames[r.id] = r.name_en; });
  }
  if (applicantIds.size) {
    const placeholders = [...applicantIds].map(() => '?').join(',');
    db.prepare(`SELECT id, first_name, last_name FROM applicants WHERE id IN (${placeholders})`).all(...applicantIds)
      .forEach(r => { applicantNames[r.id] = `${r.first_name || ''} ${r.last_name || ''}`.trim(); });
  }
  return parsed.map(r => ({
    ...r,
    undoable: (UNDOABLE_ACTIONS.includes(r.action) || r.action === 'mass-import' || r.action === 'mass-delete') && !!ENTITY_TABLES[r.entity_type] && !r.undone_at && !!(r.before_json || r.after_json),
    // Lets the UI put a "Redo" button directly on an already-undone row
    // instead of making the admin go find the separate "Reversed a change
    // to..." entry the undo created.
    redoable: !!r.undone_at && !!r.undo_entry_id && !consumedIds.has(r.undo_entry_id),
    allocationReversible: r.entity_type === 'shul_allocation' && r.action === 'create' && !reversedAllocationIds.has(r.entity_id),
    ...(r.entity_type === 'shul_allocation' ? {
      allocationShulName: shulNames[(r.after || r.before)?.shul_id] || '',
      allocationApplicantName: applicantNames[(r.after || r.before)?.applicant_id] || '',
    } : {}),
  }));
}

// Every audit_log row for ONE specific record (an applicant/shul/store/...),
// newest first, with the acting user's name attached — this is what a
// regular admin sees on that record's own "History" tab. Deliberately a
// much narrower read than getRecentActions: that one is a firehose across
// every entity in the org and stays super_admin-only; this is scoped to a
// single record the admin is already allowed to view, so any admin can see
// who touched it. `null` user_id (public form submissions, system actions)
// shows as "System".
export function getEntityHistory(orgId, entityType, entityId, limit = 100) {
  const rows = db.prepare(`SELECT a.id, a.action, a.before_json, a.after_json, a.created_at, u.first_name, u.last_name
    FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
    WHERE a.org_id = ? AND a.entity_type = ? AND a.entity_id = ?
    ORDER BY a.created_at DESC LIMIT ?`).all(orgId, entityType, entityId, limit);
  return rows.map(r => {
    const after = r.after_json ? JSON.parse(r.after_json) : null;
    // For 'update' rows, before/after are captured as exactly the changed
    // fields (see every route's logAudit('update', ...) call) — so after's
    // keys ARE the changed-field list, no diffing needed.
    const changedFields = r.action === 'update' && after ? Object.keys(after) : [];
    return {
      id: r.id, action: r.action, created_at: r.created_at, changedFields,
      userName: r.first_name ? `${r.first_name} ${r.last_name || ''}`.trim() : null,
    };
  });
}

// Restores `targetState` onto entityId in its table:
//  - targetState is an object and the row exists  -> UPDATE just those columns
//  - targetState is an object and the row is gone  -> re-INSERT it (full or partial row)
//  - targetState is null and the row exists        -> DELETE it
//  - targetState is null and the row is gone        -> already correct, no-op
function restoreEntityState(entityType, entityId, targetState) {
  const def = ENTITY_TABLES[entityType];
  if (!def) throw new Error(`Entity type "${entityType}" is not undoable`);
  const exists = !!db.prepare(`SELECT 1 FROM ${def.table} WHERE ${def.pk} = ?`).get(entityId);
  if (targetState === null) {
    if (exists) db.prepare(`DELETE FROM ${def.table} WHERE ${def.pk} = ?`).run(entityId);
    return;
  }
  const keys = Object.keys(targetState).filter(k => k !== def.pk);
  if (exists) {
    if (!keys.length) return;
    db.prepare(`UPDATE ${def.table} SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE ${def.pk} = ?`)
      .run(...keys.map(k => targetState[k]), entityId);
  } else {
    const allKeys = [def.pk, ...keys];
    db.prepare(`INSERT INTO ${def.table} (${allKeys.join(', ')}) VALUES (${allKeys.map(() => '?').join(', ')})`)
      .run(...allKeys.map(k => (k === def.pk ? entityId : targetState[k])));
  }
}

// Undoes one audit_log entry: restores before_json, marks it undone, and
// logs a fresh 'undo' entry (before = after_json, after = before_json) that
// itself is undoable — clicking Undo on THAT entry is what redo is.
// Reverses a mass upload: every row it created gets hard-deleted, and every
// row it edited gets its touched columns restored to what they said right
// before the import — using the per-row before-snapshot the import route
// captured at update time (updatedDiffs, see routes/shuls.js and
// routes/applicants.js POST /import). Rows this entry never touched are
// left alone even if they've since been deleted or changed elsewhere —
// each id is independently checked to still exist before acting on it.
//
// Entries logged before this snapshot existed (mass-import rows from the
// narrow window after mass-action logging was consolidated to one row per
// click, but before per-row undo data was added) only carry the combined
// id list and counts — but since that list was always built as
// [...createdIds, ...updatedIds] in that exact order, the first `created`
// ids are still safely recoverable as "these were newly created" and can
// be deleted; the remaining ids were edits with no captured before-state,
// so those can't be reverted and are reported back as unrestorable rather
// than silently left alone.
//
// Deliberately NOT itself undoable/redoable — logged as 'mass-import-undo'
// (not 'undo'), a name that's neither in UNDOABLE_ACTIONS nor recognized by
// this function's own dispatch, and undo_entry_id is left unset on the
// original entry so no Redo button appears for it. Reversing dozens of
// deletes-and-restores through the generic single-entity redo mechanism
// isn't something this supports — if the import needs to happen again,
// that's a fresh upload.
function undoMassImportEntry(entry, actingUser, ip) {
  const def = ENTITY_TABLES[entry.entity_type];
  if (!def) throw new Error(`"${entry.entity_type}" records can't be undone`);
  const after = entry.after_json ? JSON.parse(entry.after_json) : {};
  const createdIds = after.createdIds || (after.ids || []).slice(0, after.created || 0);
  const updatedDiffs = after.updatedDiffs || [];
  const legacyUnrestorableCount = after.updatedDiffs ? 0 : Math.max(0, (after.ids || []).length - createdIds.length);
  if (!createdIds.length && !updatedDiffs.length) throw new Error('Nothing to restore for this import — no created or restorable updated records.');

  const hardDelete = { shul: hardDeleteShul, applicant: hardDeleteApplicant }[entry.entity_type]
    || ((row) => db.prepare(`DELETE FROM ${def.table} WHERE ${def.pk} = ?`).run(row[def.pk]));

  let deletedCreated = 0, restoredUpdated = 0;
  const run = db.transaction(() => {
    for (const id of createdIds) {
      const row = db.prepare(`SELECT * FROM ${def.table} WHERE ${def.pk} = ? AND org_id = ?`).get(id, entry.org_id);
      if (!row) continue;
      hardDelete(row);
      deletedCreated++;
    }
    for (const { id, before } of updatedDiffs) {
      if (!before || !Object.keys(before).length) continue;
      const exists = db.prepare(`SELECT 1 FROM ${def.table} WHERE ${def.pk} = ? AND org_id = ?`).get(id, entry.org_id);
      if (!exists) continue;
      const keys = Object.keys(before);
      db.prepare(`UPDATE ${def.table} SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE ${def.pk} = ?`)
        .run(...keys.map(k => before[k]), id);
      restoredUpdated++;
    }
  });
  run();

  db.prepare(`UPDATE audit_log SET undone_at = datetime('now') WHERE id = ?`).run(entry.id);
  const summary = { reversedEntry: entry.id, deletedCreated, restoredUpdated, unrestorableUpdated: legacyUnrestorableCount };
  const touchedIds = [...createdIds, ...updatedDiffs.map(d => d.id)];
  return logMassAudit(entry.org_id, actingUser.id, 'mass-import-undo', entry.entity_type, touchedIds.length ? touchedIds : [entry.id], summary, ip);
}

// Reverses a mass-delete: every record it hard-deleted gets fully restored
// (main row + every related row the cascade removed/unlinked) from the
// per-row snapshot routes/{shuls,applicants,stores}.js captured right
// before deleting each one (see captureShulSnapshot() & friends). Same
// "deliberately not itself undoable/redoable" shape as
// undoMassImportEntry above, for the same reason — logged as
// 'mass-delete-undo', not 'undo', and never wired to a Redo button.
function undoMassDeleteEntry(entry, actingUser, ip) {
  const after = entry.after_json ? JSON.parse(entry.after_json) : {};
  const snapshots = after.snapshots || [];
  if (!snapshots.length) throw new Error('Nothing to restore for this mass delete — no snapshot data was saved for these records.');
  let restored = 0;
  const run = db.transaction(() => {
    for (const snap of snapshots) {
      const restore = CASCADE_RESTORERS[snap.kind];
      if (!restore) continue;
      restore(snap);
      restored++;
    }
  });
  run();
  db.prepare(`UPDATE audit_log SET undone_at = datetime('now') WHERE id = ?`).run(entry.id);
  const touchedIds = snapshots.map(s => s.row.id);
  return logMassAudit(entry.org_id, actingUser.id, 'mass-delete-undo', entry.entity_type, touchedIds.length ? touchedIds : [entry.id], { restored }, ip);
}

export function undoAuditEntry(auditId, actingUser, ip) {
  const entry = db.prepare('SELECT * FROM audit_log WHERE id = ?').get(auditId);
  if (!entry) throw new Error('Action not found');
  if (entry.org_id !== actingUser.org_id) throw new Error('Not found');
  if (entry.undone_at) throw new Error('This action was already undone');
  if (entry.action === 'mass-import') return undoMassImportEntry(entry, actingUser, ip);
  if (entry.action === 'mass-delete') return undoMassDeleteEntry(entry, actingUser, ip);
  if (!UNDOABLE_ACTIONS.includes(entry.action)) throw new Error(`"${entry.action}" actions can't be undone`);
  if (!ENTITY_TABLES[entry.entity_type]) throw new Error(`"${entry.entity_type}" records can't be undone`);
  const before = entry.before_json ? JSON.parse(entry.before_json) : null;
  const after = entry.after_json ? JSON.parse(entry.after_json) : null;
  if (before === null && after === null) throw new Error('Nothing to restore for this action');

  const run = db.transaction(() => {
    if (before && before.kind && CASCADE_RESTORERS[before.kind]) {
      // Undoing a hard delete (or redoing a previous undo of one) — bring
      // back the whole snapshot, not just the bare row.
      CASCADE_RESTORERS[before.kind](before);
    } else if (before === null && HARD_DELETERS[entry.entity_type]) {
      // Target state is "doesn't exist" for a shul/applicant/store — use
      // the real cascade delete rather than restoreEntityState's naive
      // single-row DELETE, which would fail (or leave orphans) against any
      // FK-constrained related rows a prior undo just restored.
      const def = ENTITY_TABLES[entry.entity_type];
      const row = db.prepare(`SELECT * FROM ${def.table} WHERE ${def.pk} = ?`).get(entry.entity_id);
      if (row) HARD_DELETERS[entry.entity_type](row);
    } else {
      restoreEntityState(entry.entity_type, entry.entity_id, before);
    }
  });
  run();

  const undoEntryId = logAudit(entry.org_id, actingUser.id, 'undo', entry.entity_type, entry.entity_id, after, before, ip);
  db.prepare(`UPDATE audit_log SET undone_at = datetime('now'), undo_entry_id = ? WHERE id = ?`).run(undoEntryId, auditId);
  return undoEntryId;
}
