import { Router } from 'express';
import multer from 'multer';
import { join } from 'path';
import { writeFileSync } from 'fs';
import { db, uuid, DEFAULT_ORG_ID, DATA_DIR } from '../db.js';
import { auth, requireAdmin } from '../middleware/auth.js';
import { requirePermission, redact } from '../middleware/permissions.js';
import { sendMailChecked, renderSystemTemplate, notifyNewSignup, renderSignupDetails } from '../services/mail.js';
import { sendXlsx } from '../services/xlsx.js';
import { normalizePhone, isValidPhone } from '../utils/phone.js';
import { normalizeEmail } from '../utils/email.js';
import { validateBySchema, getEffectiveSchema, getEffectiveImportSchema, getTemplateExclusions } from '../utils/formValidation.js';
import { logAudit, logMassAudit, getEntityHistory } from '../services/audit.js';
import { hardDeleteStore, captureStoreSnapshot } from '../utils/entityDelete.js';
import { generateGenericDocumentPdf } from '../services/pdf.js';
import { resolveEntity } from './documents.js';
import { getActiveSeasonId } from '../utils/formSchedule.js';
import { parseSpreadsheet, buildXlsxTemplate, STORE_IMPORT_COLUMNS } from '../services/importer.js';

const router = Router();
const billUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const BILLS_DIR = join(DATA_DIR, 'store-bills');

// Public: store self-application (mirrors the shul public form) — spec #9 says
// stores can be added by admin OR sign up themselves. Starts at setup_status
// 'pending'; admin reviews and invites to the portal same as an admin-added
// store. Fixed question set (see utils/builtinSchemas.js) — no longer driven
// by an editable Form Builder row.
router.post('/apply', async (req, res) => {
  const orgId = req.body.org_id || DEFAULT_ORG_ID;
  const b = req.body || {};
  const errors = validateBySchema(getEffectiveSchema('store_application'), b, { isAdmin: false });
  if (errors.length) return res.status(400).json({ error: errors[0] });
  if (!b.name || !b.owner_email) return res.status(400).json({ error: 'Store name and owner email are required' });
  const id = uuid();
  const samePerson = !!b.same_person;
  db.prepare(`INSERT INTO stores (id, org_id, season_id, name, address, city, state, zip, phone, pos_system, discount_details, manager_name, manager_phone, manager_email,
      owner_name, owner_phone, owner_email, same_person, comments, setup_status, has_provider_account, source)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, ?,?,?,?,?,'pending',?, 'application')`)
    .run(id, orgId, getActiveSeasonId(orgId), b.name, b.address || '', b.city || '', b.state || '', b.zip || '',
      normalizePhone(b.phone || ''), b.pos_system || '', b.discount_details || '',
      samePerson ? b.owner_name || '' : b.manager_name || '', samePerson ? normalizePhone(b.owner_phone || '') : normalizePhone(b.manager_phone || ''), samePerson ? b.owner_email || '' : b.manager_email || '',
      b.owner_name || '', normalizePhone(b.owner_phone || ''), b.owner_email, samePerson ? 1 : 0,
      b.comments || '', b.has_provider_account ? 1 : 0);
  const store = db.prepare('SELECT * FROM stores WHERE id = ?').get(id);
  await notifyNewSignup(orgId, 'notify_new_store_signup_email', 'newStoreSignup', {
    storeName: store.name, contactName: store.owner_name || store.manager_name || '',
    contactEmail: store.owner_email || store.manager_email || '', contactPhone: store.owner_phone || store.manager_phone || '',
    details: renderSignupDetails(store),
  });

  const signAtSignup = db.prepare(`SELECT value FROM settings WHERE org_id = ? AND key = 'store_contract_at_signup'`).get(orgId)?.value !== '0';
  if (!signAtSignup) {
    // No agreement at signup — just a plain "we received it" email, not the
    // actual agreement. The real one gets sent later as a deliberate,
    // separate step (Store detail > Documents tab), not automatically here.
    const tmpl = renderSystemTemplate(orgId, 'applicationReceived', { entityName: store.name });
    const { emailError } = await sendMailChecked(orgId, store.owner_email || store.manager_email, tmpl.subject, tmpl.body, { replyTo: tmpl.replyTo });
    if (emailError) console.error('[mail] application-received email failed:', emailError);
    return res.status(201).json({ store, contractAtSignup: false, message: "Application received. We'll be in touch." });
  }
  res.status(201).json({ store, contractAtSignup: true, message: 'Application received. We will reach out once your store is reviewed and approved.' });
});

// Public: immediately generate the store's participation agreement right
// after application submission, so it can be signed in the same sitting —
// same "fill out a form, then esign right here" flow as shuls (see
// shuls.js POST /:id/generate-contract), just backed by the generic
// documents system instead of a dedicated contracts table. Only ever called
// by apply-store.html when Settings > Documents > Store Agreement has
// "Require signing during signup" turned on — when it's off, /apply sends a
// plain "we received it" email instead and this route is never reached.
// Idempotent per store. Signing itself goes through documents.js's public
// token endpoints (GET/POST /documents/sign/:token...) since a store's
// agreement is just another entity_type='store' document.
router.post('/:id/generate-contract', async (req, res) => {
  const store = db.prepare('SELECT * FROM stores WHERE id = ?').get(req.params.id);
  if (!store) return res.status(404).json({ error: 'Not found' });
  const existing = db.prepare(`SELECT * FROM documents WHERE org_id = ? AND entity_type = 'store' AND entity_id = ? ORDER BY created_at DESC LIMIT 1`)
    .get(store.org_id, store.id);
  if (existing) return res.json({ sign_token: existing.status === 'signed' ? null : existing.sign_token, alreadySigned: existing.status === 'signed' });

  const entity = resolveEntity('store', store.id, store.org_id);
  const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(store.org_id);
  const templateSetting = db.prepare(`SELECT value FROM settings WHERE org_id = ? AND key = 'document_template_text_store'`).get(store.org_id);
  const pdfPath = await generateGenericDocumentPdf({
    entityType: 'store', entityId: store.id, title: 'Store Participation Agreement', fieldLines: entity.fieldLines,
    templateText: templateSetting?.value, orgName: org?.name,
    record: entity.record, extra: entity.extra, orgId: store.org_id,
  });
  const id = uuid();
  const token = uuid();
  const expires = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
  db.prepare(`INSERT INTO documents (id, org_id, entity_type, entity_id, title, pdf_path, status, sign_token, sign_token_expires, sent_at)
    VALUES (?,?,'store',?,?,?,'sent',?,?,datetime('now'))`).run(id, store.org_id, store.id, 'Store Participation Agreement', pdfPath, token, expires);
  res.json({ sign_token: token, alreadySigned: false });
});

router.use(auth, requirePermission('stores'));

// Admin-authored banner shown at the top of each store portal page (see
// renderShell() in app.js) — one independent banner per page (keyed by the
// last segment of its href, matching STORE_NAV in app.js), rich HTML with
// RTL support, same createRichTextEditor used by Updates/Shul Portal
// Banners. Edited from Settings > Store Portal Banners and stored as a
// single JSON blob under the 'store_portal_banners' org-wide setting (same
// pattern as routes/shuls.js's GET /mine/portal-banner). No permission
// check beyond the router's own 'stores' gate above, since it's just
// read-only banner content, not store data.
router.get('/mine/portal-banner', (req, res) => {
  if (req.user.role !== 'store') return res.status(403).json({ error: 'Not permitted' });
  const raw = db.prepare(`SELECT value FROM settings WHERE org_id = ? AND key = 'store_portal_banners'`).get(req.user.org_id)?.value;
  let banners = {};
  try { banners = JSON.parse(raw) || {}; } catch { banners = {}; }
  res.json({ banners });
});

function scopeWhere(req) {
  let where = 'WHERE org_id = ?';
  const params = [req.user.org_id];
  if (req.user.role === 'store') { where += ' AND id = ?'; params.push(req.user.store_id); }
  else if (req.permission.scope === 'assigned') {
    where += ` AND id IN (SELECT entity_id FROM user_assignments WHERE user_id = ? AND entity_type = 'store')`;
    params.push(req.user.id);
  }
  return { where, params };
}

router.get('/', (req, res) => {
  const { search, setup_status, season_id } = req.query;
  let { where, params } = scopeWhere(req);
  if (setup_status) { where += ' AND setup_status = ?'; params.push(setup_status); }
  if (season_id) { where += ' AND season_id = ?'; params.push(season_id); }
  if (search) {
    // Phone columns get a second, dash-stripped comparison too — stored
    // numbers are always formatted "123-456-7890" (normalizePhone), so a
    // search typed without dashes wouldn't otherwise match once the typed
    // run of digits crosses where a dash sits.
    where += ` AND (name LIKE ? OR address LIKE ? OR city LIKE ? OR state LIKE ? OR zip LIKE ? OR phone LIKE ?
      OR manager_name LIKE ? OR manager_phone LIKE ? OR manager_email LIKE ? OR owner_name LIKE ? OR owner_phone LIKE ? OR owner_email LIKE ?
      OR pos_system LIKE ? OR discount_details LIKE ? OR comments LIKE ? OR discount LIKE ?
      OR REPLACE(phone,'-','') LIKE ? OR REPLACE(manager_phone,'-','') LIKE ? OR REPLACE(owner_phone,'-','') LIKE ?)`;
    const like = `%${search}%`;
    const likeDigits = `%${search.replace(/-/g, '')}%`;
    params.push(like, like, like, like, like, like, like, like, like, like, like, like, like, like, like, like, likeDigits, likeDigits, likeDigits);
  }
  const stores = db.prepare(`SELECT * FROM stores ${where} ORDER BY created_at DESC`).all(...params);
  // Live spend per store — computed fresh on every request from the synced
  // transaction ledger, not cached, so it's always current as of the last sync.
  const spendStmt = db.prepare(`SELECT COALESCE(SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END),0) total_purchases,
    COALESCE(SUM(CASE WHEN type='refund' THEN amount ELSE 0 END),0) total_refunds, COUNT(*) txn_count
    FROM card_transactions WHERE store_id = ?`);
  const withSpend = stores.map(s => ({ ...s, ...spendStmt.get(s.id) }));
  // discount is admin-only info about the store, not something the store's
  // own portal login should ever see about itself.
  if (req.user.role === 'store') withSpend.forEach(s => { delete s.discount; });
  res.json({ stores: redact(withSpend, req.permission.hidden_fields) });
});

// Full-detail CSV export — every field. Must be registered before /:id.
router.get('/export', requirePermission('stores', 'can_export'), (req, res) => {
  const { search, setup_status, season_id } = req.query;
  let { where, params } = scopeWhere(req);
  if (setup_status) { where += ' AND setup_status = ?'; params.push(setup_status); }
  if (season_id) { where += ' AND season_id = ?'; params.push(season_id); }
  if (search) {
    // Phone columns get a second, dash-stripped comparison too — stored
    // numbers are always formatted "123-456-7890" (normalizePhone), so a
    // search typed without dashes wouldn't otherwise match once the typed
    // run of digits crosses where a dash sits.
    where += ` AND (name LIKE ? OR address LIKE ? OR city LIKE ? OR state LIKE ? OR zip LIKE ? OR phone LIKE ?
      OR manager_name LIKE ? OR manager_phone LIKE ? OR manager_email LIKE ? OR owner_name LIKE ? OR owner_phone LIKE ? OR owner_email LIKE ?
      OR pos_system LIKE ? OR discount_details LIKE ? OR comments LIKE ? OR discount LIKE ?
      OR REPLACE(phone,'-','') LIKE ? OR REPLACE(manager_phone,'-','') LIKE ? OR REPLACE(owner_phone,'-','') LIKE ?)`;
    const like = `%${search}%`;
    const likeDigits = `%${search.replace(/-/g, '')}%`;
    params.push(like, like, like, like, like, like, like, like, like, like, like, like, like, like, like, like, likeDigits, likeDigits, likeDigits);
  }
  const stores = db.prepare(`SELECT * FROM stores ${where} ORDER BY created_at DESC`).all(...params);
  const withSpend = stores.map(s => {
    const totals = db.prepare(`SELECT COALESCE(SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END),0) total_purchases, COALESCE(SUM(CASE WHEN type='refund' THEN amount ELSE 0 END),0) total_refunds FROM card_transactions WHERE store_id = ?`).get(s.id);
    return { ...s, total_purchases: totals.total_purchases, total_refunds: totals.total_refunds };
  });
  sendXlsx(res, `stores-${Date.now()}.xlsx`, redact(withSpend, req.permission.hidden_fields));
});

router.get('/:id', (req, res) => {
  const store = db.prepare('SELECT * FROM stores WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!store) return res.status(404).json({ error: 'Not found' });
  if (req.user.role === 'store' && store.id !== req.user.store_id) return res.status(403).json({ error: 'Not your store' });
  const transactionTotals = db.prepare(`SELECT COUNT(*) count, COALESCE(SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END),0) total_purchases,
    COALESCE(SUM(CASE WHEN type='refund' THEN amount ELSE 0 END),0) total_refunds
    FROM card_transactions WHERE store_id = ?`).get(store.id);
  // A store's own portal login sees its total purchases (their own sales
  // figure) but not transaction count or refund totals — internal-only
  // numbers a store shouldn't be able to reconstruct their transaction
  // history's shape from.
  if (req.user.role === 'store') { delete transactionTotals.count; delete transactionTotals.total_refunds; delete store.discount; }
  // Latest participation agreement, if any — same "just the newest one"
  // rule as shuls.js's GET /:id contract field, so the profile can show an
  // at-a-glance signed/not-signed status without a second round trip to the
  // full Documents tab list.
  const latestAgreement = db.prepare(`SELECT status, sent_at, signed_at, signer_name FROM documents
    WHERE org_id = ? AND entity_type = 'store' AND entity_id = ? ORDER BY created_at DESC LIMIT 1`).get(req.user.org_id, store.id) || null;
  res.json({ store: redact(store, req.permission.hidden_fields), transactionTotals, latestAgreement });
});

// Who edited this record and when — not shown to the store viewing their own record.
router.get('/:id/history', requireAdmin, (req, res) => {
  const store = db.prepare('SELECT id FROM stores WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!store) return res.status(404).json({ error: 'Not found' });
  res.json({ history: getEntityHistory(req.user.org_id, 'store', store.id) });
});

// Stores are season-scoped like shuls (see Carry Forward below) — this
// finds every other season's record for "the same" store, matched the same
// way carry-forward reuses a target-season record: owner email, falling
// back to manager email, falling back to name.
router.get('/:id/other-seasons', requireAdmin, (req, res) => {
  const store = db.prepare('SELECT * FROM stores WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!store) return res.status(404).json({ error: 'Not found' });
  const email = store.owner_email || store.manager_email;
  const matches = email
    ? db.prepare(`SELECT s.id, s.name, s.setup_status AS status, s.season_id, se.name AS season_name FROM stores s LEFT JOIN seasons se ON se.id = s.season_id
        WHERE s.org_id = ? AND s.id != ? AND (s.owner_email = ? OR s.manager_email = ?) ORDER BY se.created_at DESC`).all(req.user.org_id, store.id, email, email)
    : db.prepare(`SELECT s.id, s.name, s.setup_status AS status, s.season_id, se.name AS season_name FROM stores s LEFT JOIN seasons se ON se.id = s.season_id
        WHERE s.org_id = ? AND s.id != ? AND s.name = ? ORDER BY se.created_at DESC`).all(req.user.org_id, store.id, store.name);
  res.json({ matches });
});

router.post('/', requirePermission('stores', 'can_edit'), (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'Store name is required' });
  for (const [f, label] of [['phone', 'Store Phone'], ['manager_phone', 'Manager Phone'], ['owner_phone', 'Owner Phone']]) {
    if (!isValidPhone(b[f])) return res.status(400).json({ error: `${label} must be a valid phone number (10 digits, or 11 digits starting with 1)` });
  }
  const id = uuid();
  db.prepare(`INSERT INTO stores (id, org_id, season_id, name, address, city, state, zip, phone, pos_system, discount_details, manager_name, manager_phone, manager_email,
      owner_name, owner_phone, owner_email, same_person, comments, setup_status, has_provider_account, discount)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?)`)
    .run(id, req.user.org_id, getActiveSeasonId(req.user.org_id), b.name, b.address || '', b.city || '', b.state || '', b.zip || '', normalizePhone(b.phone || ''), b.pos_system || '', b.discount_details || '',
      b.manager_name || '', normalizePhone(b.manager_phone || ''), b.manager_email || '', b.owner_name || '', normalizePhone(b.owner_phone || ''), b.owner_email || '',
      b.same_person ? 1 : 0, b.comments || '', b.setup_status || 'pending', b.has_provider_account ? 1 : 0, b.discount || '');
  const store = db.prepare('SELECT * FROM stores WHERE id = ?').get(id);
  logAudit(req.user.org_id, req.user.id, 'create', 'store', id, null, store, req.ip);
  res.status(201).json({ store });
});

router.put('/:id', requirePermission('stores', 'can_edit'), (req, res) => {
  const store = db.prepare('SELECT * FROM stores WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!store) return res.status(404).json({ error: 'Not found' });
  const fields = ['name','address','city','state','zip','phone','pos_system','discount_details','manager_name','manager_phone','manager_email','owner_name','owner_phone','owner_email','same_person','comments','setup_status','has_provider_account','provider_store_id','discount','disccard_setup_comments','disccard_setup_complete'];
  const b = req.body || {};
  if (b.phone !== undefined) b.phone = normalizePhone(b.phone);
  if (b.manager_phone !== undefined) b.manager_phone = normalizePhone(b.manager_phone);
  if (b.owner_phone !== undefined) b.owner_phone = normalizePhone(b.owner_phone);
  for (const [f, label] of [['phone', 'Store Phone'], ['manager_phone', 'Manager Phone'], ['owner_phone', 'Owner Phone']]) {
    if (!isValidPhone(b[f])) return res.status(400).json({ error: `${label} must be a valid phone number (10 digits, or 11 digits starting with 1)` });
  }
  const sets = fields.filter(f => b[f] !== undefined);
  if (sets.length) {
    const vals = sets.map(f => (f === 'has_provider_account' || f === 'same_person' || f === 'disccard_setup_complete') ? (b[f] ? 1 : 0) : b[f]);
    db.prepare(`UPDATE stores SET ${sets.map(f=>`${f}=?`).join(',')} WHERE id=?`).run(...vals, store.id);
    logAudit(req.user.org_id, req.user.id, 'update', 'store', store.id, Object.fromEntries(sets.map(f => [f, store[f]])), Object.fromEntries(sets.map((f,i) => [f, vals[i]])), req.ip);
  }
  // Editing (or blanking) owner_email/manager_email here used to have zero
  // effect on an already-issued portal login — inviteStoreToPortal only
  // ever reads these fields at invite time, so a login's users.email is
  // independent of them from then on. That meant "removing" a store's
  // email in this form never actually revoked the access it was granted
  // under: the old login kept working with the old address indefinitely.
  // This route is never called by the store role itself (can_edit defaults
  // to 0 for that role — store-portal self-service goes through its own
  // dedicated onboarding routes, not this one), so there's no self-edit
  // case to protect here the way shuls.js's PUT /:id has to — every caller
  // is an admin, so revoking is always the right call, not a session they
  // might be mid-edit of themselves.
  if (store.portal_user_id && (sets.includes('owner_email') || sets.includes('manager_email'))) {
    const updatedStore = db.prepare('SELECT owner_email, manager_email FROM stores WHERE id = ?').get(store.id);
    const portalUser = db.prepare('SELECT * FROM users WHERE id = ?').get(store.portal_user_id);
    const currentEmails = [updatedStore.owner_email, updatedStore.manager_email].filter(Boolean).map(normalizeEmail);
    if (portalUser && portalUser.is_active && !currentEmails.includes(normalizeEmail(portalUser.email))) {
      db.prepare('UPDATE users SET is_active = 0, token_version = token_version + 1 WHERE id = ?').run(portalUser.id);
      logAudit(req.user.org_id, req.user.id, 'update', 'user', portalUser.id, { is_active: 1 }, { is_active: 0 }, req.ip);
    }
  }
  res.json({ store: db.prepare('SELECT * FROM stores WHERE id = ?').get(store.id) });
});

const STORE_STATUSES = ['pending', 'in_progress', 'active', 'inactive', 'rejected'];
router.post('/mass-set-status', requirePermission('stores', 'can_edit'), (req, res) => {
  const { ids, setup_status } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids array required' });
  if (!STORE_STATUSES.includes(setup_status)) return res.status(400).json({ error: `setup_status must be one of: ${STORE_STATUSES.join(', ')}` });
  let updated = 0, skipped = 0;
  const affectedIds = [], names = [];
  for (const id of ids) {
    const store = db.prepare('SELECT * FROM stores WHERE id = ? AND org_id = ?').get(id, req.user.org_id);
    if (!store) { skipped++; continue; }
    db.prepare('UPDATE stores SET setup_status = ? WHERE id = ?').run(setup_status, store.id);
    affectedIds.push(store.id); names.push(store.name);
    updated++;
  }
  logMassAudit(req.user.org_id, req.user.id, 'mass-set-status', 'store', affectedIds, { skipped, setup_status, names }, req.ip);
  res.json({ updated, skipped });
});

// Permanent deletion — full removal. Card transactions against this store
// are kept (a card's own ledger shouldn't lose history) but unlinked
// (store_id set to null) since the store record itself is gone; billing
// rows are hard-deleted since they're meaningless without the store. A
// linked portal login is deactivated, not deleted (that's user
// management's job). FK enforcement is ON, so every hard reference is
// cleaned up first, wrapped in a transaction.
router.delete('/:id/permanent', requirePermission('stores', 'can_edit'), (req, res) => {
  const store = db.prepare('SELECT * FROM stores WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!store) return res.status(404).json({ error: 'Not found' });
  // Snapshot every related row before the cascade removes/unlinks it, so a
  // super_admin can fully undo this from Recent Actions — "Delete
  // Permanently" still reads and behaves as a real permanent delete, this
  // is purely a safety net (see utils/entityDelete.js's snapshot/restore
  // comment block).
  const snapshot = captureStoreSnapshot(store);
  const del = db.transaction(() => hardDeleteStore(store));
  del();
  logAudit(req.user.org_id, req.user.id, 'delete', 'store', store.id, snapshot, null, req.ip);
  res.json({ ok: true });
});

router.post('/mass-delete-permanent', requirePermission('stores', 'can_edit'), (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids array required' });
  let deleted = 0, skipped = 0;
  const affectedIds = [], names = [], snapshots = [];
  for (const id of ids) {
    const store = db.prepare('SELECT * FROM stores WHERE id = ? AND org_id = ?').get(id, req.user.org_id);
    if (!store) { skipped++; continue; }
    const snapshot = captureStoreSnapshot(store);
    const del = db.transaction(() => hardDeleteStore(store));
    del();
    snapshots.push(snapshot);
    affectedIds.push(store.id); names.push(store.name);
    deleted++;
  }
  // snapshots carries the full undo data for this whole click (see
  // undoMassDeleteEntry in services/audit.js) — names/count stay separate
  // since those are what the Recent Actions headline reads.
  logMassAudit(req.user.org_id, req.user.id, 'mass-delete', 'store', affectedIds, { skipped, names, snapshots }, req.ip);
  res.json({ deleted, skipped });
});

// Shared by the single and mass invite routes below.
async function inviteStoreToPortal(orgId, store, emailOverride, sentBy = null) {
  // Normalized before it ever touches users.email — login lowercases its
  // lookup, so a mixed-case users.email is an account nobody can sign into.
  const email = normalizeEmail(emailOverride || store.owner_email || store.manager_email);
  if (!email) return { error: 'No email on file for this store' };
  let user = db.prepare('SELECT * FROM users WHERE store_id = ?').get(store.id);
  const emailTaken = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(email, user?.id || '');
  if (emailTaken) return { error: `${email} is already used by another account. Update the store's contact email or that account first.` };
  const token = uuid();
  const expires = new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString();
  if (user) {
    db.prepare('UPDATE users SET invite_token=?, invite_expires=?, email=? WHERE id=?').run(token, expires, email, user.id);
  } else {
    const uid = uuid();
    db.prepare(`INSERT INTO users (id, org_id, email, first_name, role, store_id, invite_token, invite_expires, is_active) VALUES (?,?,?,?,'store',?,?,?,0)`)
      .run(uid, orgId, email, store.manager_name || store.name, store.id, token, expires);
  }
  db.prepare(`UPDATE stores SET portal_user_id = (SELECT id FROM users WHERE store_id = ?) WHERE id = ?`).run(store.id, store.id);
  const portalUrl = `${process.env.APP_URL || ''}/accept-invite?token=${token}`;
  const tmpl = renderSystemTemplate(orgId, 'storeSetup', { storeName: store.name, portalUrl });
  const { emailError } = await sendMailChecked(orgId, email, tmpl.subject, tmpl.body, { replyTo: tmpl.replyTo, sentBy });
  if (emailError) console.error('[mail] store invite email failed:', emailError);
  return { emailError };
}

// When "Require signing during signup" is ON, a store signs its agreement
// itself as part of applying (POST /documents/store-agreement), so there's
// nothing to gate here by the time an admin invites them. When it's OFF,
// nothing sends an agreement automatically — an admin has to send one from
// the store's own Documents tab first, same requirement as shuls have for
// their contract before approval.
function storeNeedsAgreementBeforeInvite(orgId, store) {
  const atSignup = db.prepare(`SELECT value FROM settings WHERE org_id = ? AND key = 'store_contract_at_signup'`).get(orgId)?.value !== '0';
  if (atSignup) return false;
  const doc = db.prepare(`SELECT status FROM documents WHERE org_id = ? AND entity_type = 'store' AND entity_id = ? ORDER BY created_at DESC LIMIT 1`).get(orgId, store.id);
  return !doc || !['sent', 'signed'].includes(doc.status);
}

// Invite a store to their self-service portal.
router.post('/:id/invite', requirePermission('stores', 'can_edit'), async (req, res) => {
  const store = db.prepare('SELECT * FROM stores WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!store) return res.status(404).json({ error: 'Not found' });
  if (!req.body?.bypass_contract && storeNeedsAgreementBeforeInvite(req.user.org_id, store)) {
    return res.status(400).json({ error: "This store's agreement isn't required at signup and hasn't been sent yet. Send it from the Documents tab before inviting, or bypass to skip the requirement.", code: 'CONTRACT_NOT_SENT' });
  }
  const result = await inviteStoreToPortal(req.user.org_id, store, req.body?.email, req.user.id);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json({ ok: true, emailError: result.emailError });
});

// Mints a short-lived, single-use exchange code for "Enter Portal" (see
// POST /auth/impersonate/:token in auth.js, which redeems it for a real
// session) — never the store's own JWT/password, so this staff member's
// own session is never at risk of being handed to the store, and the
// store's actual password (if they have one) is never read, changed, or
// even touched. Gated on the dedicated portal_impersonation permission
// (default-denied for everyone but super_admin, same as Recent Actions)
// rather than stores' own can_edit — "can edit this store's record" and
// "can act as this store in their own portal" are different levels of
// trust and shouldn't be bundled by default. Mirrors shuls.js's identical
// route.
router.post('/:id/impersonate', requireAdmin, requirePermission('portal_impersonation'), (req, res) => {
  const store = db.prepare('SELECT * FROM stores WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!store) return res.status(404).json({ error: 'Not found' });
  const portalUser = db.prepare(`SELECT * FROM users WHERE store_id = ? AND role = 'store'`).get(store.id);
  if (!portalUser || !portalUser.is_active) return res.status(400).json({ error: "This store doesn't have an active portal login yet — approve or invite them first." });
  const token = uuid();
  const expires = new Date(Date.now() + 2 * 60 * 1000).toISOString();
  db.prepare(`INSERT INTO impersonation_tokens (token, user_id, created_by, org_id, expires_at) VALUES (?,?,?,?,?)`)
    .run(token, portalUser.id, req.user.id, req.user.org_id, expires);
  logAudit(req.user.org_id, req.user.id, 'impersonate', 'store', store.id, null, { name: store.name, impersonated_email: portalUser.email }, req.ip);
  res.json({ token });
});

router.post('/mass-invite', requirePermission('stores', 'can_edit'), async (req, res) => {
  const { ids, bypass_contract } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids array required' });
  let invited = 0, skipped = 0, emailErrors = 0;
  for (const id of ids) {
    const store = db.prepare('SELECT * FROM stores WHERE id = ? AND org_id = ?').get(id, req.user.org_id);
    if (!store) { skipped++; continue; }
    if (!bypass_contract && storeNeedsAgreementBeforeInvite(req.user.org_id, store)) { skipped++; continue; }
    const result = await inviteStoreToPortal(req.user.org_id, store, null, req.user.id);
    if (result.error) { skipped++; continue; }
    if (result.emailError) emailErrors++;
    invited++;
  }
  res.json({ invited, skipped, emailErrors });
});

// One-click "Send Contract" — same gate/mechanism as the public self-service
// flow and carry-forward, just an explicit admin action for a store that
// already exists and needs (or needs to redo) its agreement, mirroring
// shuls.js's POST /:id/send-contract.
router.post('/:id/send-contract', requirePermission('stores', 'can_edit'), async (req, res) => {
  const store = db.prepare('SELECT * FROM stores WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!store) return res.status(404).json({ error: 'Not found' });
  const to = req.body?.email || store.owner_email || store.manager_email;
  const result = await sendStoreAgreement(req.user.org_id, store, to, req.user.id);
  if (result.error) return res.status(409).json({ error: result.error });
  logAudit(req.user.org_id, req.user.id, 'send_contract', 'store', store.id, null, { to }, req.ip);
  res.json({ ok: true, document: result.document, emailError: result.emailError });
});

// Approve: the single "yes, this store is accepted" action, mirroring
// shuls.js's POST /:id/approve — creates/ensures the portal login (same
// welcome email invite already sends) and moves setup_status to 'active' in
// one step, gated on the same agreement-on-file requirement invite already
// enforces (bypassable the same way). "Invite to Portal" still exists
// separately for a store that's already been approved some other way (e.g.
// carried forward) and just needs its login (re)sent.
router.post('/:id/approve', requirePermission('stores', 'can_edit'), async (req, res) => {
  const store = db.prepare('SELECT * FROM stores WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!store) return res.status(404).json({ error: 'Not found' });
  if (!req.body?.bypass_contract && storeNeedsAgreementBeforeInvite(req.user.org_id, store)) {
    return res.status(400).json({ error: "This store's agreement isn't required at signup and hasn't been sent yet. Send it from the Documents tab before approving, or bypass to skip the requirement.", code: 'CONTRACT_NOT_SENT' });
  }
  const result = await inviteStoreToPortal(req.user.org_id, store, req.body?.email, req.user.id);
  if (result.error) return res.status(400).json({ error: result.error });
  db.prepare(`UPDATE stores SET setup_status = 'active' WHERE id = ?`).run(store.id);
  logAudit(req.user.org_id, req.user.id, 'approve', 'store', store.id, { setup_status: store.setup_status }, { setup_status: 'active' }, req.ip);
  res.json({ ok: true, store: db.prepare('SELECT * FROM stores WHERE id = ?').get(store.id), emailError: result.emailError });
});

router.post('/mass-approve', requirePermission('stores', 'can_edit'), async (req, res) => {
  const { ids, bypass_contract } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids array required' });
  let approved = 0, skipped = 0, emailErrors = 0;
  const affectedIds = [], names = [];
  for (const id of ids) {
    const store = db.prepare('SELECT * FROM stores WHERE id = ? AND org_id = ?').get(id, req.user.org_id);
    if (!store) { skipped++; continue; }
    if (!bypass_contract && storeNeedsAgreementBeforeInvite(req.user.org_id, store)) { skipped++; continue; }
    const result = await inviteStoreToPortal(req.user.org_id, store, null, req.user.id);
    if (result.error) { skipped++; continue; }
    if (result.emailError) emailErrors++;
    db.prepare(`UPDATE stores SET setup_status = 'active' WHERE id = ?`).run(store.id);
    affectedIds.push(store.id); names.push(store.name);
    approved++;
  }
  logMassAudit(req.user.org_id, req.user.id, 'mass-approve', 'store', affectedIds, { skipped, emailErrors, names }, req.ip);
  res.json({ approved, skipped, emailErrors });
});

// Reuses an already-active portal login for a returning store (same
// owner/manager email) by repointing its store_id at the new season's row,
// instead of colliding with users.email's UNIQUE constraint — same pattern
// as shuls.js's ensureShulPortalUser, needed because inviteStoreToPortal
// above only ever looks up a user by the CURRENT store's own id.
function ensureStorePortalUser(orgId, store, emailOverride) {
  let user = db.prepare('SELECT * FROM users WHERE store_id = ?').get(store.id);
  if (user) return user;
  // Same users.email normalization as inviteStoreToPortal above.
  const email = normalizeEmail(emailOverride || store.owner_email || store.manager_email);
  const existing = email ? db.prepare('SELECT * FROM users WHERE org_id = ? AND email = ?').get(orgId, email) : null;
  if (existing) {
    db.prepare('UPDATE users SET store_id = ? WHERE id = ?').run(store.id, existing.id);
    return db.prepare('SELECT * FROM users WHERE id = ?').get(existing.id);
  }
  const token = uuid();
  const expires = new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString();
  const uid = uuid();
  db.prepare(`INSERT INTO users (id, org_id, email, first_name, role, store_id, invite_token, invite_expires, is_active) VALUES (?,?,?,?,'store',?,?,?,0)`)
    .run(uid, orgId, email, store.manager_name || store.name, store.id, token, expires);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
}
function storeLoginUrl(user) {
  if (user.is_active) return `${process.env.APP_URL || ''}/login`;
  const token = uuid();
  const expires = new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString();
  db.prepare('UPDATE users SET invite_token = ?, invite_expires = ? WHERE id = ?').run(token, expires, user.id);
  return `${process.env.APP_URL || ''}/accept-invite?token=${token}`;
}

// Generates + emails a fresh participation agreement for a store — same
// generic-documents mechanism as the public self-service flow (POST
// /:id/generate-contract), just admin-triggered with an email step,
// mirroring shuls.js's sendContractForShul. Shared by carry-forward and the
// single-store "Send Contract" route below.
async function sendStoreAgreement(orgId, store, toEmail, sentBy = null) {
  if (!toEmail) return { error: 'No email on file for this store' };
  // Same guard as shuls.js's sendContractForShul — the store detail view
  // always shows the *latest* document row, so generating a new one here
  // unconditionally would shadow an already-executed, legally-signed
  // agreement behind a fresh unsigned one. Retracting the signature first
  // (a separate, explicit, audited action) is the real way to redo one.
  const existing = db.prepare(`SELECT status FROM documents WHERE org_id = ? AND entity_type = 'store' AND entity_id = ? ORDER BY created_at DESC LIMIT 1`).get(orgId, store.id);
  if (existing?.status === 'signed') {
    return { error: 'This store already has a signed agreement on file. Retract the existing signature first if you need to send a new one.' };
  }
  const entity = resolveEntity('store', store.id, orgId);
  const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(orgId);
  const templateSetting = db.prepare(`SELECT value FROM settings WHERE org_id = ? AND key = 'document_template_text_store'`).get(orgId);
  const pdfPath = await generateGenericDocumentPdf({
    entityType: 'store', entityId: store.id, title: 'Store Participation Agreement', fieldLines: entity.fieldLines,
    templateText: templateSetting?.value, orgName: org?.name,
    record: entity.record, extra: entity.extra, orgId,
  });
  const id = uuid();
  const token = uuid();
  const expires = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
  db.prepare(`INSERT INTO documents (id, org_id, entity_type, entity_id, title, pdf_path, status, sign_token, sign_token_expires, sent_at, created_by)
    VALUES (?,?,'store',?,?,?,'sent',?,?,datetime('now'),?)`).run(id, orgId, store.id, 'Store Participation Agreement', pdfPath, token, expires, sentBy);
  const signUrl = `${process.env.APP_URL || ''}/sign-document?token=${token}`;
  const { subject, body, replyTo } = renderSystemTemplate(orgId, 'documentReady', { docTitle: 'Store Participation Agreement', entityName: store.name, signUrl });
  const { emailError } = await sendMailChecked(orgId, toEmail, subject, body, { replyTo, sentBy });
  return { document: db.prepare('SELECT * FROM documents WHERE id = ?').get(id), emailError };
}

// Core of Carry Forward, shared by the single-store route and
// /mass-carry-forward: brings one store (a known, returning participant)
// into a different season without re-running the application. Reuses a
// matching store record in the target season if one already exists (owner
// email, falling back to manager email, falling back to name — same
// heuristic as GET /:id/other-seasons), so this is safe to run more than
// once without creating duplicates.
async function carryForwardStore(orgId, userId, source, targetSeason, { ip } = {}) {
  if (targetSeason.id === source.season_id) return { error: "Target season must be different from the store's current season", status: 400 };
  const email = source.owner_email || source.manager_email;
  let target = email
    ? db.prepare('SELECT * FROM stores WHERE org_id = ? AND season_id = ? AND (owner_email = ? OR manager_email = ?)').get(orgId, targetSeason.id, email, email)
    : db.prepare('SELECT * FROM stores WHERE org_id = ? AND season_id = ? AND name = ?').get(orgId, targetSeason.id, source.name);
  let storeCreated = false;
  let emailError = null, agreementEmailError = null;
  if (!target) {
    const id = uuid();
    db.prepare(`INSERT INTO stores (id, org_id, season_id, name, address, city, state, zip, phone, pos_system, discount_details, manager_name, manager_phone, manager_email,
        owner_name, owner_phone, owner_email, same_person, comments, setup_status, has_provider_account, source)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?, 'carried_forward')`)
      .run(id, orgId, targetSeason.id, source.name, source.address || '', source.city || '', source.state || '', source.zip || '', source.phone || '', source.pos_system || '', source.discount_details || '',
        source.manager_name || '', source.manager_phone || '', source.manager_email || '', source.owner_name || '', source.owner_phone || '', source.owner_email || '',
        source.same_person, source.comments || '', source.setup_status || 'pending', source.has_provider_account ? 1 : 0);
    target = db.prepare('SELECT * FROM stores WHERE id = ?').get(id);
    storeCreated = true;

    let user = ensureStorePortalUser(orgId, target);
    db.prepare(`UPDATE stores SET portal_user_id = (SELECT id FROM users WHERE store_id = ?) WHERE id = ?`).run(target.id, target.id);
    target = db.prepare('SELECT * FROM stores WHERE id = ?').get(target.id);

    const loginUrl = storeLoginUrl(user);
    const tmpl = renderSystemTemplate(orgId, 'storeSetup', { storeName: target.name, portalUrl: loginUrl });
    ({ emailError } = await sendMailChecked(orgId, user.email, tmpl.subject, tmpl.body, { replyTo: tmpl.replyTo, sentBy: userId }));
    if (emailError) console.error('[mail] store carry-forward invite email failed:', emailError);

    const agreementResult = await sendStoreAgreement(orgId, target, email, userId);
    agreementEmailError = agreementResult.error || agreementResult.emailError || null;
  }
  logAudit(orgId, userId, 'carry-forward', 'store', source.id, { season_id: source.season_id }, { target_store_id: target.id, target_season_id: targetSeason.id }, ip);
  return { store: target, storeCreated, emailError, agreementEmailError };
}

router.post('/:id/carry-forward', requirePermission('stores', 'can_edit'), async (req, res) => {
  const source = db.prepare('SELECT * FROM stores WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!source) return res.status(404).json({ error: 'Not found' });
  const targetSeason = db.prepare('SELECT * FROM seasons WHERE id = ? AND org_id = ?').get(req.body?.season_id, req.user.org_id);
  if (!targetSeason) return res.status(400).json({ error: 'Target season not found' });
  const result = await carryForwardStore(req.user.org_id, req.user.id, source, targetSeason, { ip: req.ip });
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json(result);
});

router.post('/mass-carry-forward', requirePermission('stores', 'can_edit'), async (req, res) => {
  const { ids, season_id } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids array required' });
  const targetSeason = db.prepare('SELECT * FROM seasons WHERE id = ? AND org_id = ?').get(season_id, req.user.org_id);
  if (!targetSeason) return res.status(400).json({ error: 'Target season not found' });
  let carried = 0, skipped = 0; const affectedIds = [], names = [];
  for (const id of ids) {
    const source = db.prepare('SELECT * FROM stores WHERE id = ? AND org_id = ?').get(id, req.user.org_id);
    if (!source) { skipped++; continue; }
    const result = await carryForwardStore(req.user.org_id, req.user.id, source, targetSeason, { ip: req.ip });
    if (result.error) { skipped++; continue; }
    affectedIds.push(result.store.id); names.push(result.store.name);
    carried++;
  }
  logMassAudit(req.user.org_id, req.user.id, 'mass-carry-forward', 'store', affectedIds, { skipped, target_season_id: targetSeason.id, names }, req.ip);
  res.json({ carried, skipped });
});

// ---- Store portal onboarding wizard ----
// Steps: 1 = confirm store/contact info, 2 = billing contact + agree to terms, 3 = complete.
// Callable by the store's own portal login OR an admin walking them through it.
router.put('/:id/onboarding', (req, res) => {
  const store = db.prepare('SELECT * FROM stores WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!store) return res.status(404).json({ error: 'Not found' });
  if (req.user.role === 'store' && store.id !== req.user.store_id) return res.status(403).json({ error: 'Not your store' });
  if (!['store', 'super_admin', 'org_admin', 'staff'].includes(req.user.role)) return res.status(403).json({ error: 'Not permitted' });

  const { step, info, agree_terms } = req.body || {};
  if (info) {
    if (info.phone !== undefined) info.phone = normalizePhone(info.phone);
    if (info.manager_phone !== undefined) info.manager_phone = normalizePhone(info.manager_phone);
    if (info.owner_phone !== undefined) info.owner_phone = normalizePhone(info.owner_phone);
    for (const [f, label] of [['phone', 'Store Phone'], ['manager_phone', 'Manager Phone'], ['owner_phone', 'Owner Phone']]) {
      if (!isValidPhone(info[f])) return res.status(400).json({ error: `${label} must be a valid phone number (10 digits, or 11 digits starting with 1)` });
    }
    const fields = ['name', 'address', 'city', 'state', 'zip', 'phone', 'manager_name', 'manager_phone', 'manager_email', 'owner_name', 'owner_phone', 'owner_email'];
    const sets = fields.filter(f => info[f] !== undefined);
    if (sets.length) db.prepare(`UPDATE stores SET ${sets.map(f => `${f}=?`).join(',')} WHERE id=?`).run(...sets.map(f => info[f]), store.id);
  }
  if (agree_terms) db.prepare(`UPDATE stores SET agreed_terms_at = datetime('now') WHERE id = ?`).run(store.id);

  const newStep = Math.max(store.onboarding_step || 0, +step || 0);
  const isComplete = newStep >= 3;
  db.prepare(`UPDATE stores SET onboarding_step = ?, onboarding_completed_at = CASE WHEN ? THEN COALESCE(onboarding_completed_at, datetime('now')) ELSE onboarding_completed_at END,
      setup_status = CASE WHEN setup_status = 'pending' AND ? THEN 'in_progress' ELSE setup_status END
    WHERE id = ?`).run(newStep, isComplete ? 1 : 0, newStep > 0 ? 1 : 0, store.id);

  res.json({ store: db.prepare('SELECT * FROM stores WHERE id = ?').get(store.id) });
});

// ===================== Bills a store submits TO the org =====================
// We never bill a store — a store bills us (e.g. reimbursement for
// gift-card redemptions it's already honored). A store portal login
// submits these; an admin can also log one on the store's behalf (email,
// paper) via the same endpoint. An admin reviews and marks them paid.
router.get('/:id/bill-submissions', (req, res) => {
  const store = db.prepare('SELECT * FROM stores WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!store) return res.status(404).json({ error: 'Not found' });
  if (req.user.role === 'store' && store.id !== req.user.store_id) return res.status(403).json({ error: 'Not your store' });
  res.json({ bills: db.prepare('SELECT * FROM store_bill_submissions WHERE store_id = ? ORDER BY submitted_at DESC').all(store.id) });
});

router.post('/:id/bill-submissions', billUpload.single('file'), (req, res) => {
  const store = db.prepare('SELECT * FROM stores WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!store) return res.status(404).json({ error: 'Not found' });
  if (req.user.role === 'store' && store.id !== req.user.store_id) return res.status(403).json({ error: 'Not your store' });
  if (req.user.role !== 'store' && req.user.role !== 'super_admin' && req.user.role !== 'org_admin' && req.user.role !== 'staff') return res.status(403).json({ error: 'Not permitted' });
  const { period, amount, description } = req.body || {};
  const amountNum = +amount;
  if (!amountNum || amountNum <= 0) return res.status(400).json({ error: 'A valid amount is required' });
  const id = uuid();
  let filePath = null, fileName = null;
  if (req.file) {
    fileName = req.file.originalname;
    const safeName = `${id}-${fileName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    writeFileSync(join(BILLS_DIR, safeName), req.file.buffer);
    filePath = safeName;
  }
  db.prepare(`INSERT INTO store_bill_submissions (id, org_id, store_id, period, amount, description, file_path, file_name)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run(id, req.user.org_id, store.id, period || '', amountNum, description || '', filePath, fileName);
  res.status(201).json({ bill: db.prepare('SELECT * FROM store_bill_submissions WHERE id = ?').get(id) });
});

router.put('/bill-submissions/:billId', requirePermission('stores', 'can_edit'), (req, res) => {
  const row = db.prepare(`SELECT b.* FROM store_bill_submissions b JOIN stores s ON s.id=b.store_id WHERE b.id=? AND s.org_id=?`).get(req.params.billId, req.user.org_id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const { status, admin_notes } = req.body || {};
  db.prepare(`UPDATE store_bill_submissions SET status=COALESCE(?,status), admin_notes=COALESCE(?,admin_notes),
    reviewed_at=CASE WHEN ? IS NOT NULL THEN datetime('now') ELSE reviewed_at END WHERE id=?`)
    .run(status, admin_notes, status, row.id);
  res.json({ bill: db.prepare('SELECT * FROM store_bill_submissions WHERE id = ?').get(row.id) });
});

// Authenticated download for a submitted bill's attachment (not a public
// static mount — these are financial documents) — either the owning
// store's own portal login, or an admin.
router.get('/bill-submissions/:billId/file', (req, res) => {
  const row = db.prepare(`SELECT b.*, s.org_id FROM store_bill_submissions b JOIN stores s ON s.id=b.store_id WHERE b.id=?`).get(req.params.billId);
  if (!row || row.org_id !== req.user.org_id) return res.status(404).json({ error: 'Not found' });
  if (req.user.role === 'store' && row.store_id !== req.user.store_id) return res.status(403).json({ error: 'Not your bill' });
  if (!row.file_path) return res.status(404).json({ error: 'No file attached' });
  res.download(join(BILLS_DIR, row.file_path), row.file_name || 'bill');
});

router.get('/import/template', requireAdmin, (req, res) => {
  const excluded = getTemplateExclusions('store_application');
  const columns = STORE_IMPORT_COLUMNS.filter(c => !excluded.has(c));
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="store_import_template.xlsx"');
  res.send(buildXlsxTemplate(['id', ...columns]));
});

// Every column an UPDATE row (matched by a filled-in `id` column) can
// touch, and how to read it off a parsed sheet row — a blank cell means
// "leave this column alone," not "clear it," same contract as the shuls
// and applicants imports.
const STORE_UPDATABLE_FIELDS = {
  name: r => r.name, address: r => r.address, city: r => r.city, state: r => r.state, zip: r => r.zip,
  phone: r => r.phone && normalizePhone(r.phone), pos_system: r => r.pos_system, discount_details: r => r.discount_details,
  manager_name: r => r.manager_name, manager_phone: r => r.manager_phone && normalizePhone(r.manager_phone), manager_email: r => r.manager_email,
  owner_name: r => r.owner_name, owner_phone: r => r.owner_phone && normalizePhone(r.owner_phone), owner_email: r => r.owner_email,
  comments: r => r.comments,
};

router.post('/import', requirePermission('stores', 'can_edit'), upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  if (!/\.xlsx$/i.test(req.file.originalname || '')) return res.status(400).json({ error: 'Only .xlsx files are accepted (CSV does not reliably support Hebrew text).' });
  const jobId = uuid();
  const rows = parseSpreadsheet(req.file.buffer, req.file.originalname);
  // Required, not defaulted — an admin must explicitly pick which season
  // every row in this upload lands in, rather than silently falling back to
  // whatever happens to be active right now.
  if (!req.body.season_id) return res.status(400).json({ error: 'A season is required for a mass upload.' });
  const season = db.prepare('SELECT * FROM seasons WHERE id = ? AND org_id = ?').get(req.body.season_id, req.user.org_id);
  if (!season) return res.status(400).json({ error: 'Season not found' });

  // Spreadsheet cells arrive as strings ("TRUE"/"1"/"yes"), not real
  // booleans — normalize the two checkbox columns up front so both
  // validateBySchema's requiredUnless (same_person exempting manager
  // fields) and the INSERT below see a real boolean either way.
  const truthy = v => /^(y|yes|true|1)$/i.test(String(v ?? '').trim());
  for (const r of rows) { r.same_person = truthy(r.same_person); r.has_provider_account = truthy(r.has_provider_account); }

  // A row with a non-blank `id` column that matches an existing store in
  // this org is an edit, not a new application — same file you get from
  // Export Excel, edited in place and re-uploaded.
  const rowExisting = rows.map(r => {
    const id = r.id ? String(r.id).trim() : '';
    if (!id) return null;
    return db.prepare('SELECT * FROM stores WHERE id = ? AND org_id = ?').get(id, req.user.org_id) || null;
  });

  // All-or-nothing: every true-create row must have every field the fixed
  // Store Application question set requires, or NOTHING in the sheet is
  // imported — nothing is written to the database until every row checks
  // out. bypass_required (admin only) skips this whole check for the
  // entire sheet; name and owner_email stay hard-required per new row
  // below regardless, since a store record is meaningless without them.
  const bypassRequired = req.body.bypass_required === 'true' || req.body.bypass_required === true;
  const requiredErrors = bypassRequired ? [] : rows
    .map((r, i) => (rowExisting[i] ? null : { row: i + 2, errors: validateBySchema(getEffectiveImportSchema('store_application'), r, { isAdmin: true }) }))
    .filter(x => x && x.errors.length)
    .map(x => ({ row: x.row, error: x.errors.join('; ') }));
  const idNotFoundErrors = rows
    .map((r, i) => (r.id && String(r.id).trim() && !rowExisting[i]) ? { row: i + 2, error: `No existing store found with id "${r.id}"` } : null)
    .filter(Boolean);
  // Update rows skip validateBySchema entirely (see rowExisting above) — a
  // blank cell there means "leave alone," not "missing" — but a non-blank
  // phone cell still has to be a real phone number.
  const updatePhoneErrors = rows.map((r, i) => {
    if (!rowExisting[i]) return null;
    const bad = [['phone', 'Store Phone'], ['manager_phone', 'Manager Phone'], ['owner_phone', 'Owner Phone']].find(([f]) => r[f] && !isValidPhone(r[f]));
    return bad ? { row: i + 2, error: `${bad[1]} must be a valid phone number (10 digits, or 11 digits starting with 1)` } : null;
  }).filter(Boolean);
  const allErrors = [...requiredErrors, ...idNotFoundErrors, ...updatePhoneErrors].sort((a, b) => a.row - b.row);
  if (allErrors.length) {
    return res.status(400).json({ error: 'Some rows have errors. Nothing was imported — fix the sheet and re-upload.', errors: allErrors });
  }

  let success = 0, updated = 0; const errors = [];
  const createdIds = [], createdNames = [], updatedIds = [], updatedNames = [];
  // Per-row "what did this column used to say" snapshot, captured right
  // before each UPDATE — what makes mass-import undo able to actually
  // restore an edited row instead of just deleting the newly-created ones.
  const updatedDiffs = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const existing = rowExisting[i];
    if (existing) {
      try {
        const sets = Object.keys(STORE_UPDATABLE_FIELDS).filter(f => { const v = STORE_UPDATABLE_FIELDS[f](r); return v !== undefined && v !== ''; });
        if (sets.length) {
          const vals = sets.map(f => STORE_UPDATABLE_FIELDS[f](r));
          db.prepare(`UPDATE stores SET ${sets.map(f => `${f}=?`).join(',')} WHERE id=?`).run(...vals, existing.id);
          updatedIds.push(existing.id); updatedNames.push(existing.name);
          updatedDiffs.push({ id: existing.id, before: Object.fromEntries(sets.map(f => [f, existing[f]])) });
        }
        updated++;
      } catch (e) {
        errors.push({ row: i + 2, error: e.message });
      }
      continue;
    }
    if (!r.name || !r.owner_email) { errors.push({ row: i + 2, error: 'Missing name or owner_email' }); continue; }
    try {
      const id = uuid();
      const samePerson = !!r.same_person;
      db.prepare(`INSERT INTO stores (id, org_id, season_id, name, address, city, state, zip, phone, pos_system, discount_details, manager_name, manager_phone, manager_email,
          owner_name, owner_phone, owner_email, same_person, comments, setup_status, has_provider_account, source)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, ?,?,?,?,?,'pending',?, 'mass_upload')`)
        .run(id, req.user.org_id, season?.id || null, r.name, r.address || '', r.city || '', r.state || '', r.zip || '',
          normalizePhone(r.phone || ''), r.pos_system || '', r.discount_details || '',
          samePerson ? r.owner_name || '' : r.manager_name || '', samePerson ? normalizePhone(r.owner_phone || '') : normalizePhone(r.manager_phone || ''), samePerson ? r.owner_email || '' : r.manager_email || '',
          r.owner_name || '', normalizePhone(r.owner_phone || ''), r.owner_email, samePerson ? 1 : 0,
          r.comments || '', r.has_provider_account ? 1 : 0);
      const store = db.prepare('SELECT * FROM stores WHERE id = ?').get(id);
      createdIds.push(id); createdNames.push(store.name);
      success++;
    } catch (e) {
      errors.push({ row: i + 2, error: e.message });
    }
  }
  db.prepare(`INSERT INTO import_jobs (id, org_id, entity_type, file_name, status, total_rows, success_count, error_count, error_log, created_by)
    VALUES (?,?,?,?,'completed',?,?,?,?,?)`)
    .run(jobId, req.user.org_id, 'stores', req.file.originalname, rows.length, success, errors.length, JSON.stringify(errors), req.user.id);
  logMassAudit(req.user.org_id, req.user.id, 'mass-import', 'store', [...createdIds, ...updatedIds],
    { created: createdIds.length, updated: updatedIds.length, errors: errors.length, names: [...createdNames, ...updatedNames], createdIds, updatedIds, updatedDiffs }, req.ip);
  res.json({ jobId, total: rows.length, success, updated, errors });
});

export default router;
