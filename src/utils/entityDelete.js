// Shared cleanup for the polymorphic entity_type/entity_id (or
// related_entity_type/related_entity_id) columns used across the app —
// documents, tasks, duplicate_flags, sms_messages, emails_sent, and
// form_responses all reference a shul/applicant/store this way instead of a
// real foreign key, so deleting the parent record never trips SQLite's FK
// enforcement, but would otherwise leave orphaned rows a list/detail page
// might still try to render. entityType is 'shul' | 'applicant' | 'store',
// matching the values those tables were actually written with.
import { db } from '../db.js';

export function deletePolymorphicRefs(entityType, entityId) {
  db.prepare(`DELETE FROM documents WHERE entity_type = ? AND entity_id = ?`).run(entityType, entityId);
  db.prepare(`DELETE FROM tasks WHERE entity_type = ? AND entity_id = ?`).run(entityType, entityId);
  db.prepare(`DELETE FROM duplicate_flags WHERE entity_type = ? AND (entity_id = ? OR matched_entity_id = ?)`).run(entityType, entityId, entityId);
  db.prepare(`DELETE FROM sms_messages WHERE related_entity_type = ? AND related_entity_id = ?`).run(entityType, entityId);
  db.prepare(`DELETE FROM emails_sent WHERE related_entity_type = ? AND related_entity_id = ?`).run(entityType, entityId);
  db.prepare(`DELETE FROM form_responses WHERE entity_type = ? AND entity_id = ?`).run(entityType, entityId);
}

// The full hard-delete cascade for one shul — shared by routes/shuls.js's
// single and mass "delete permanent" routes and by services/audit.js's
// mass-import undo (deleting a row a mass upload just created). Callers
// still own their own db.transaction() wrapper and any pre-delete side
// effects; deactivating a portal login is handled here since it's a plain
// column update, but locking a disccardpromos card is a network call and
// stays the caller's responsibility, same as before this was extracted.
export function hardDeleteShul(shul) {
  db.prepare('UPDATE applicants SET shul_id = NULL WHERE shul_id = ?').run(shul.id);
  db.prepare('UPDATE shuls SET duplicate_of_shul_id = NULL WHERE duplicate_of_shul_id = ?').run(shul.id);
  db.prepare('DELETE FROM contracts WHERE shul_id = ?').run(shul.id);
  db.prepare('DELETE FROM shul_notes WHERE shul_id = ?').run(shul.id);
  // shul_allocations/shul_payments/shul_payment_method_requests all have a
  // NOT NULL foreign key on shul_id (foreign_keys=ON, db.js) — added after
  // this cascade was first written, and missed then, so deleting a shul
  // with any payment/allocation history threw an unhandled FOREIGN KEY
  // constraint error instead of a real delete. Erased here, not
  // unlinked, matching how this same cascade already erases (not
  // preserves) contracts/notes for a deleted shul.
  db.prepare('DELETE FROM shul_allocations WHERE shul_id = ?').run(shul.id);
  db.prepare('DELETE FROM shul_payments WHERE shul_id = ?').run(shul.id);
  db.prepare('DELETE FROM shul_payment_method_requests WHERE shul_id = ?').run(shul.id);
  if (shul.portal_user_id) db.prepare('UPDATE users SET is_active = 0, token_version = token_version + 1 WHERE id = ?').run(shul.portal_user_id);
  deletePolymorphicRefs('shul', shul.id);
  db.prepare('DELETE FROM shuls WHERE id = ?').run(shul.id);
}

// Same as hardDeleteShul but for an applicant — card locking (a
// disccardpromos network call) is likewise left to the caller; this is
// DB-only.
export function hardDeleteApplicant(applicant) {
  db.prepare('DELETE FROM card_transactions WHERE card_id IN (SELECT id FROM cards WHERE applicant_id = ?)').run(applicant.id);
  db.prepare('DELETE FROM cards WHERE applicant_id = ?').run(applicant.id);
  db.prepare('DELETE FROM applicant_notes WHERE applicant_id = ?').run(applicant.id);
  // Same NOT NULL FK gap as hardDeleteShul above, on the applicant_id side —
  // an applicant who's ever had money allocated to them (shul_payments >
  // give to applicant) couldn't be deleted at all before this.
  db.prepare('DELETE FROM shul_allocations WHERE applicant_id = ?').run(applicant.id);
  db.prepare('UPDATE applicants SET duplicate_of_applicant_id = NULL WHERE duplicate_of_applicant_id = ?').run(applicant.id);
  deletePolymorphicRefs('applicant', applicant.id);
  db.prepare('DELETE FROM applicants WHERE id = ?').run(applicant.id);
}

// Same idea for a store — card_transactions keep their history but are
// unlinked (store_id set to null) rather than deleted, same as
// hardDeleteShul/hardDeleteApplicant's own note about not losing a card's
// own ledger. Extracted here (was inlined twice in routes/stores.js) so
// services/audit.js can call the exact same cascade when it needs to
// re-delete a store — e.g. redoing a hard delete that undo had just restored.
export function hardDeleteStore(store) {
  db.prepare('UPDATE card_transactions SET store_id = NULL WHERE store_id = ?').run(store.id);
  db.prepare('DELETE FROM store_billing WHERE store_id = ?').run(store.id);
  if (store.portal_user_id) db.prepare('UPDATE users SET is_active = 0, token_version = token_version + 1 WHERE id = ?').run(store.portal_user_id);
  deletePolymorphicRefs('store', store.id);
  db.prepare('DELETE FROM stores WHERE id = ?').run(store.id);
}

// ---------------------------------------------------------------------------
// Snapshot + restore support so a hard delete can be FULLY undone from
// Recent Actions — not just the shul/applicant/store row itself (all
// services/audit.js's generic restoreEntityState() knows how to bring
// back), but everything the cascades above just removed or unlinked. The
// delete routes capture one of these snapshots right before calling
// hardDelete*() and pass it as the audit_log 'before' value in place of the
// bare row; services/audit.js recognizes the `kind` marker and dispatches
// to the matching restore*Snapshot() function below instead of its normal
// single-row restore. The "Delete Permanently" UI itself is unchanged —
// still reads and behaves as a real, permanent delete — this only means a
// super_admin can bring the whole thing back afterward from Recent Actions.
// ---------------------------------------------------------------------------

// Re-inserts a previously-captured row if (and only if) nothing with that
// id exists already — restoring the same snapshot twice (e.g. a stray
// double-click on Undo) is a safe no-op rather than a duplicate-key error.
function insertIfMissing(table, row) {
  if (!row) return;
  if (db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(row.id)) return;
  const keys = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...keys.map(k => row[k]));
}

function capturePolymorphicRefs(entityType, entityId) {
  return {
    documents: db.prepare('SELECT * FROM documents WHERE entity_type = ? AND entity_id = ?').all(entityType, entityId),
    tasks: db.prepare('SELECT * FROM tasks WHERE entity_type = ? AND entity_id = ?').all(entityType, entityId),
    duplicateFlags: db.prepare('SELECT * FROM duplicate_flags WHERE entity_type = ? AND (entity_id = ? OR matched_entity_id = ?)').all(entityType, entityId, entityId),
    smsMessages: db.prepare('SELECT * FROM sms_messages WHERE related_entity_type = ? AND related_entity_id = ?').all(entityType, entityId),
    emailsSent: db.prepare('SELECT * FROM emails_sent WHERE related_entity_type = ? AND related_entity_id = ?').all(entityType, entityId),
    formResponses: db.prepare('SELECT * FROM form_responses WHERE entity_type = ? AND entity_id = ?').all(entityType, entityId),
  };
}
function restorePolymorphicRefs(snap) {
  snap.documents.forEach(r => insertIfMissing('documents', r));
  snap.tasks.forEach(r => insertIfMissing('tasks', r));
  snap.duplicateFlags.forEach(r => insertIfMissing('duplicate_flags', r));
  snap.smsMessages.forEach(r => insertIfMissing('sms_messages', r));
  snap.emailsSent.forEach(r => insertIfMissing('emails_sent', r));
  snap.formResponses.forEach(r => insertIfMissing('form_responses', r));
}

// Captures is_active/token_version rather than a boolean "was active" —
// restoring exactly those two columns puts the portal login back to
// whatever state it was actually in right before the delete (which might
// already have been inactive), instead of assuming delete always found it active.
function capturePortalUser(portalUserId) {
  return portalUserId ? db.prepare('SELECT id, is_active, token_version FROM users WHERE id = ?').get(portalUserId) || null : null;
}
function restorePortalUser(portalUser) {
  if (portalUser) db.prepare('UPDATE users SET is_active = ?, token_version = ? WHERE id = ?').run(portalUser.is_active, portalUser.token_version, portalUser.id);
}

export function captureShulSnapshot(shul) {
  return {
    kind: 'shul-cascade',
    row: shul,
    contracts: db.prepare('SELECT * FROM contracts WHERE shul_id = ?').all(shul.id),
    notes: db.prepare('SELECT * FROM shul_notes WHERE shul_id = ?').all(shul.id),
    shulAllocations: db.prepare('SELECT * FROM shul_allocations WHERE shul_id = ?').all(shul.id),
    shulPayments: db.prepare('SELECT * FROM shul_payments WHERE shul_id = ?').all(shul.id),
    shulPaymentMethodRequests: db.prepare('SELECT * FROM shul_payment_method_requests WHERE shul_id = ?').all(shul.id),
    unlinkedApplicantIds: db.prepare('SELECT id FROM applicants WHERE shul_id = ?').all(shul.id).map(r => r.id),
    duplicateOfShulIds: db.prepare('SELECT id FROM shuls WHERE duplicate_of_shul_id = ?').all(shul.id).map(r => r.id),
    portalUser: capturePortalUser(shul.portal_user_id),
    ...capturePolymorphicRefs('shul', shul.id),
  };
}
export function restoreShulSnapshot(snap) {
  insertIfMissing('shuls', snap.row);
  snap.contracts.forEach(r => insertIfMissing('contracts', r));
  snap.notes.forEach(r => insertIfMissing('shul_notes', r));
  // '|| []' — snapshots captured before these three tables were added here
  // won't have the key at all; restoring one of those older snapshots
  // should still work, just without money/request history that was never
  // captured for it in the first place.
  (snap.shulAllocations || []).forEach(r => insertIfMissing('shul_allocations', r));
  (snap.shulPayments || []).forEach(r => insertIfMissing('shul_payments', r));
  (snap.shulPaymentMethodRequests || []).forEach(r => insertIfMissing('shul_payment_method_requests', r));
  snap.unlinkedApplicantIds.forEach(id => db.prepare('UPDATE applicants SET shul_id = ? WHERE id = ? AND shul_id IS NULL').run(snap.row.id, id));
  snap.duplicateOfShulIds.forEach(id => db.prepare('UPDATE shuls SET duplicate_of_shul_id = ? WHERE id = ?').run(snap.row.id, id));
  restorePortalUser(snap.portalUser);
  restorePolymorphicRefs(snap);
}

export function captureApplicantSnapshot(applicant) {
  const cards = db.prepare('SELECT * FROM cards WHERE applicant_id = ?').all(applicant.id);
  const cardIds = cards.map(c => c.id);
  const cardTransactions = cardIds.length
    ? db.prepare(`SELECT * FROM card_transactions WHERE card_id IN (${cardIds.map(() => '?').join(',')})`).all(...cardIds)
    : [];
  return {
    kind: 'applicant-cascade',
    row: applicant,
    cards, cardTransactions,
    notes: db.prepare('SELECT * FROM applicant_notes WHERE applicant_id = ?').all(applicant.id),
    shulAllocations: db.prepare('SELECT * FROM shul_allocations WHERE applicant_id = ?').all(applicant.id),
    duplicateOfApplicantIds: db.prepare('SELECT id FROM applicants WHERE duplicate_of_applicant_id = ?').all(applicant.id).map(r => r.id),
    ...capturePolymorphicRefs('applicant', applicant.id),
  };
}
export function restoreApplicantSnapshot(snap) {
  insertIfMissing('applicants', snap.row);
  snap.cards.forEach(r => insertIfMissing('cards', r));
  snap.cardTransactions.forEach(r => insertIfMissing('card_transactions', r));
  snap.notes.forEach(r => insertIfMissing('applicant_notes', r));
  // '|| []' — snapshots captured before shul_allocations was added here
  // won't have the key; restoring one of those still works, just without
  // allocation history that was never captured for it.
  (snap.shulAllocations || []).forEach(r => insertIfMissing('shul_allocations', r));
  snap.duplicateOfApplicantIds.forEach(id => db.prepare('UPDATE applicants SET duplicate_of_applicant_id = ? WHERE id = ?').run(snap.row.id, id));
  restorePolymorphicRefs(snap);
}

export function captureStoreSnapshot(store) {
  return {
    kind: 'store-cascade',
    row: store,
    billing: db.prepare('SELECT * FROM store_billing WHERE store_id = ?').all(store.id),
    unlinkedCardTransactionIds: db.prepare('SELECT id FROM card_transactions WHERE store_id = ?').all(store.id).map(r => r.id),
    portalUser: capturePortalUser(store.portal_user_id),
    ...capturePolymorphicRefs('store', store.id),
  };
}
export function restoreStoreSnapshot(snap) {
  insertIfMissing('stores', snap.row);
  snap.billing.forEach(r => insertIfMissing('store_billing', r));
  if (snap.unlinkedCardTransactionIds.length) {
    const placeholders = snap.unlinkedCardTransactionIds.map(() => '?').join(',');
    db.prepare(`UPDATE card_transactions SET store_id = ? WHERE id IN (${placeholders}) AND store_id IS NULL`).run(snap.row.id, ...snap.unlinkedCardTransactionIds);
  }
  restorePortalUser(snap.portalUser);
  restorePolymorphicRefs(snap);
}
