import { Router } from 'express';
import multer from 'multer';
import { db, uuid, DEFAULT_ORG_ID } from '../db.js';
import { auth, requireAdmin } from '../middleware/auth.js';
import { requirePermission, redact, getPermission } from '../middleware/permissions.js';
import { shulBalancesForIds } from '../services/shulBalance.js';
import { detectAndFlag, resolveFlag, getShulMergeGroupIds, mergeShuls } from '../services/duplicates.js';
import { generateContractPdf, stampSignatureFields, getSignatureFields, resolveSignatureValues } from '../services/pdf.js';
import { sendMailChecked, renderSystemTemplate, notifyNewSignup, notifyDocSigned, renderSignupDetails } from '../services/mail.js';
import { sendSmsChecked } from '../services/sms.js';
import { parseSpreadsheet, buildXlsxTemplate, SHUL_IMPORT_COLUMNS } from '../services/importer.js';
import { sendXlsx } from '../services/xlsx.js';
import { normalizePhone, isValidPhone } from '../utils/phone.js';
import { normalizeEmail } from '../utils/email.js';
import { getActiveSeasonId } from '../utils/formSchedule.js';
import { validateBySchema, shulInfoErrors, getEffectiveSchema, getEffectiveImportSchema, getTemplateExclusions } from '../utils/formValidation.js';
import { logAudit, logMassAudit, getEntityHistory } from '../services/audit.js';
import { hardDeleteShul, captureShulSnapshot } from '../utils/entityDelete.js';
import { generateApplicantExternalId, generateShulNumber } from '../utils/externalId.js';
import { maskForShul } from './applicants.js';
import { APPLICANT_IMPORT_COLUMNS } from '../services/importer.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const REQUIRED_SHUL_FIELDS = ['name_en', 'address', 'city', 'state', 'zip', 'ruv_first_name', 'ruv_last_name', 'ruv_phone', 'gabai_first_name', 'gabai_last_name', 'gabai_cell', 'gabai_email'];

// Finds-or-creates the portal login for a shul record being approved (or
// carried forward, which pre-approves) — used by POST /:id/approve and
// POST /:id/carry-forward. A shul row tied to THIS exact id never has a
// user yet (it's brand new), but `users.email` is UNIQUE org-wide, so a
// returning shul re-approved in a new season under the same gabai email
// would otherwise crash on the INSERT (their email is already taken by
// last season's user row) — this is the entirely normal case of a shul
// coming back the following year, not an edge case. When an existing user
// with that email is found, its shul_id is simply repointed at the new
// row (one login, whichever season's shul row it currently points to —
// same model as everywhere else: portal access tracks one specific shul
// row, not "the shul" as a recurring identity) instead of trying to make a
// second account with the same email.
function ensureShulPortalUser(orgId, shul, portalEmailOverride) {
  let user = db.prepare('SELECT * FROM users WHERE shul_id = ?').get(shul.id);
  if (user) return user;
  // gabai_email stays as typed on the shul row (fine for display/mailing),
  // but the users-table copy must be normalized — login lowercases its
  // lookup, so a mixed-case users.email is an account nobody can sign into.
  const email = normalizeEmail(portalEmailOverride || shul.gabai_email);
  const existing = email ? db.prepare('SELECT * FROM users WHERE org_id = ? AND email = ?').get(orgId, email) : null;
  if (existing) {
    db.prepare('UPDATE users SET shul_id = ? WHERE id = ?').run(shul.id, existing.id);
    return db.prepare('SELECT * FROM users WHERE id = ?').get(existing.id);
  }
  const token = uuid();
  const expires = new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString();
  const uid = uuid();
  db.prepare(`INSERT INTO users (id, org_id, email, first_name, last_name, role, shul_id, invite_token, invite_expires, is_active)
    VALUES (?,?,?,?,?,'shul',?,?,?,0)`).run(uid, orgId, email, shul.gabai_first_name, shul.gabai_last_name, shul.id, token, expires);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
}

// A reused already-active portal user (returning shul, same gabai email —
// see ensureShulPortalUser) has no invite_token to accept; send them
// straight to login instead of a broken /accept-invite?token=null link.
// Otherwise mints and persists a fresh invite token. Shared by approve,
// carry-forward, and mass-approve so this branch only lives in one place.
function shulLoginUrl(user) {
  if (user.is_active) return `${process.env.APP_URL || ''}/login`;
  const token = uuid();
  const expires = new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString();
  db.prepare('UPDATE users SET invite_token = ?, invite_expires = ? WHERE id = ?').run(token, expires, user.id);
  return `${process.env.APP_URL || ''}/accept-invite?token=${token}`;
}

// When "Require signing during signup" is ON, /apply already generated the
// contract automatically (see /:id/generate-contract) before an admin ever
// gets to approve, so there's nothing to gate here. When it's OFF, nothing
// generates a contract on its own — an admin has to click "Generate & Email
// Contract" on the shul's own profile first. Approving before that ever
// happens would let a shul into the program with no contract on file and no
// prompt to fix it later, so approve blocks on it (bypassable) instead.
function shulNeedsContractBeforeApproval(orgId, shul) {
  const atSignup = db.prepare(`SELECT value FROM settings WHERE org_id = ? AND key = 'shul_contract_at_signup'`).get(orgId)?.value !== '0';
  if (atSignup) return false;
  const contract = db.prepare('SELECT status FROM contracts WHERE shul_id = ? ORDER BY created_at DESC LIMIT 1').get(shul.id);
  return !contract || !['sent', 'signed'].includes(contract.status);
}

// ============================= PUBLIC ==============================
// Public shul onboarding form submission. No auth — this is the form referenced
// in spec item #1. Creates the shul record, runs duplicate detection, and
// generates (but does not yet send) the contract PDF.
router.post('/apply', async (req, res) => {
  const orgId = req.body.org_id || DEFAULT_ORG_ID;
  const b = req.body || {};
  // Fixed question set (see utils/builtinSchemas.js) — no longer driven by
  // an editable Form Builder row.
  const errors = validateBySchema(getEffectiveSchema('shul_application'), b, { isAdmin: false });
  if (errors.length) return res.status(400).json({ error: errors[0] });
  if (b.ruv_phone !== undefined) b.ruv_phone = normalizePhone(b.ruv_phone);
  if (b.gabai_cell !== undefined) b.gabai_cell = normalizePhone(b.gabai_cell);
  const seasonId = getActiveSeasonId(orgId);
  const id = uuid();
  // lat/lng/place_id (Places autocomplete) are technical fields the JS
  // widget fills in directly, not one of the fixed questions — read
  // straight off the body regardless.
  db.prepare(`INSERT INTO shuls (id, org_id, season_id, name_en, name_he, address, city, state, zip, lat, lng, place_id,
      ruv_first_name, ruv_last_name, ruv_phone, ruv_address, ruv_city, ruv_state, ruv_zip, ruv_place_id,
      gabai_first_name, gabai_last_name, gabai_cell, gabai_email, gabai_address, gabai_city, gabai_state, gabai_zip, gabai_place_id,
      status, source, shul_number)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?,?, 'submitted', 'form', ?)`)
    .run(id, orgId, seasonId, b.name_en, b.name_he || '', b.address, b.city, b.state, b.zip, b.lat || null, b.lng || null, b.place_id || null,
      b.ruv_first_name, b.ruv_last_name, b.ruv_phone, b.ruv_address || '', b.ruv_city || '', b.ruv_state || '', b.ruv_zip || '', b.ruv_place_id || null,
      b.gabai_first_name, b.gabai_last_name, b.gabai_cell, b.gabai_email, b.gabai_address || '', b.gabai_city || '', b.gabai_state || '', b.gabai_zip || '', b.gabai_place_id || null,
      generateShulNumber(db));

  const shulRow = db.prepare('SELECT * FROM shuls WHERE id = ?').get(id);
  const flag = detectAndFlag(orgId, 'shul', shulRow);
  logAudit(orgId, null, 'create', 'shul', id, null, shulRow, req.ip);
  await notifyNewSignup(orgId, 'notify_new_shul_signup_email', 'newShulSignup', {
    shulName: shulRow.name_en, contactName: `${shulRow.gabai_first_name} ${shulRow.gabai_last_name}`,
    contactEmail: shulRow.gabai_email || '', contactPhone: shulRow.gabai_cell || '',
    details: renderSignupDetails(shulRow),
  });
  if (flag) return res.status(201).json({ shul: shulRow, duplicate: true, message: 'Your application was received, but a similar shul is already on file. Our team will follow up.' });

  const signAtSignup = db.prepare(`SELECT value FROM settings WHERE org_id = ? AND key = 'shul_contract_at_signup'`).get(orgId)?.value !== '0';
  if (!signAtSignup) {
    // No contract at signup — just a plain "we received it" email, not the
    // actual contract. The real contract gets sent later as a deliberate,
    // separate step (Shul detail > Contract tab's "Generate & Email
    // Contract"), not automatically here.
    const tmpl = renderSystemTemplate(orgId, 'applicationReceived', { entityName: shulRow.name_en });
    const { emailError } = await sendMailChecked(orgId, shulRow.gabai_email, tmpl.subject, tmpl.body, { replyTo: tmpl.replyTo });
    if (emailError) console.error('[mail] application-received email failed:', emailError);
    return res.status(201).json({ shul: shulRow, duplicate: false, contractAtSignup: false, message: "Application received. We'll be in touch." });
  }
  res.status(201).json({ shul: shulRow, duplicate: false, contractAtSignup: true, message: 'Application received. You will receive an email with your contract to sign shortly.' });
});

// Public: minimal shul picker list for public applicant forms (name + id only).
// Excludes locked system shuls (e.g. "Ezras Habayis") — those auto-attach
// applicants themselves and were never meant to be picked from a list.
router.get('/public/list', (req, res) => {
  const orgId = req.query.org_id || DEFAULT_ORG_ID;
  const rows = db.prepare(`SELECT id, name_en, name_he FROM shuls WHERE org_id = ? AND status='approved' AND is_paused = 0 AND is_locked = 0 ORDER BY name_en`).all(orgId);
  res.json({ shuls: rows });
});

// Public: immediately generate the contract right after form submission so the
// applicant can sign in the same sitting (spec #1: "fill out a form... and
// esign a contract"), rather than waiting on an admin action. Only ever
// called by apply.html when Settings > Documents > Shul Contract has
// "Require signing during signup" turned on — when it's off, /apply sends a
// plain "we received it" email instead and this route is never reached; the
// actual contract gets sent later as its own deliberate step (Shul detail >
// Contract tab). Idempotent per shul.
router.post('/:id/generate-contract', async (req, res) => {
  const shul = db.prepare('SELECT * FROM shuls WHERE id = ?').get(req.params.id);
  if (!shul) return res.status(404).json({ error: 'Not found' });
  const existing = db.prepare(`SELECT * FROM contracts WHERE shul_id = ? ORDER BY created_at DESC LIMIT 1`).get(shul.id);
  if (existing) return res.json({ sign_token: existing.status === 'signed' ? null : existing.sign_token, alreadySigned: existing.status === 'signed' });
  const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(shul.org_id);
  const season = db.prepare('SELECT * FROM seasons WHERE id = ?').get(shul.season_id);
  const templateSetting = db.prepare(`SELECT value FROM settings WHERE org_id = ? AND key = 'contract_template_text'`).get(shul.org_id);
  const pdfPath = await generateContractPdf({ shul, season, templateText: templateSetting?.value, orgName: org?.name });
  const token = uuid();
  const expires = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
  db.prepare(`INSERT INTO contracts (id, shul_id, season_id, pdf_path, status, sign_token, sign_token_expires, sent_at)
    VALUES (?,?,?,?,'sent',?,?,datetime('now'))`).run(uuid(), shul.id, shul.season_id, pdfPath, token, expires);
  db.prepare(`UPDATE shuls SET status='contract_sent', updated_at=datetime('now') WHERE id=?`).run(shul.id);
  res.json({ sign_token: token, alreadySigned: false });
});

// Public: fetch a shul's contract by sign token (emailed link).
router.get('/contract/:token', (req, res) => {
  const contract = db.prepare('SELECT * FROM contracts WHERE sign_token = ?').get(req.params.token);
  if (!contract) return res.status(404).json({ error: 'Not found' });
  if (contract.status === 'signed') return res.json({ contract, alreadySigned: true });
  if (contract.sign_token_expires && new Date(contract.sign_token_expires) < new Date()) return res.status(410).json({ error: 'This signing link has expired. Contact us for a new one.' });
  const shul = db.prepare('SELECT * FROM shuls WHERE id = ?').get(contract.shul_id);
  res.json({ contract, shul, fields: getSignatureFields(DEFAULT_ORG_ID, 'shul') });
});

// Public: inline PDF preview (unsigned, or signed once complete) for the iframe on apply.html / sign-contract.html.
router.get('/contract/:token/pdf-preview', (req, res) => {
  const contract = db.prepare('SELECT * FROM contracts WHERE sign_token = ?').get(req.params.token);
  if (!contract) return res.status(404).send('Not found');
  const path = contract.signed_pdf_path || contract.pdf_path;
  if (!path) return res.status(404).send('PDF not available');
  res.sendFile(path);
});

// Public: submit e-signature.
router.post('/contract/:token/sign', async (req, res) => {
  const contract = db.prepare('SELECT * FROM contracts WHERE sign_token = ?').get(req.params.token);
  if (!contract) return res.status(404).json({ error: 'Not found' });
  if (contract.status === 'signed') return res.status(409).json({ error: 'This contract has already been signed' });
  const { signer_name, signer_title, consent } = req.body || {};
  if (!signer_name) return res.status(400).json({ error: 'Signer name is required' });
  if (!consent) return res.status(400).json({ error: 'You must consent to sign electronically before submitting.' });
  const fields = getSignatureFields(DEFAULT_ORG_ID, 'shul');
  const { values, missing } = resolveSignatureValues(fields, req.body);
  if (missing.length) return res.status(400).json({ error: `Please complete: ${missing.join(', ')}` });
  const signedAt = new Date().toISOString();
  const primary = fields.find(f => f.type === 'signature') || fields[0];
  const signedPath = await stampSignatureFields({ unsignedPath: contract.pdf_path, shulId: contract.shul_id, fields, values, signerName: signer_name, signedAt, ip: req.ip });
  const signatureData = primary ? values[primary.id] : null;
  db.prepare(`UPDATE contracts SET status='signed', signature_data=?, signer_name=?, signer_title=?, signed_at=?, ip_address=?, signed_pdf_path=?, field_values=?, esign_consent_at=? WHERE id=?`)
    .run(signatureData, signer_name, signer_title || '', signedAt, req.ip, signedPath, JSON.stringify(values), signedAt, contract.id);
  db.prepare(`UPDATE shuls SET status='contract_signed', updated_at=datetime('now') WHERE id=?`).run(contract.shul_id);
  const shul = db.prepare('SELECT * FROM shuls WHERE id = ?').get(contract.shul_id);
  logAudit(shul.org_id, null, 'esign', 'contract', contract.id, null, { signer_name, signedAt }, req.ip);
  await notifyDocSigned(shul.org_id, 'shul', {
    docTitle: 'Shul Contract', entityName: shul.name_en || '', signerName: signer_name, signedAt,
    entityUrl: `${process.env.APP_URL || ''}/admin/shuls?id=${shul.id}`,
  });
  res.json({ ok: true, message: 'Contract signed. An administrator will review and set up your account.' });
});

// ============================= ADMIN ==============================
router.use(auth, requirePermission('shuls'));

// Full, unpaginated shul list for the applicant-profile "Shul" dropdown
// (frontend/js/app.js's attachShulSelect) — every non-locked shul regardless
// of status, since an admin correcting an applicant's shul assignment needs
// to be able to pick any real shul, not just approved/active ones.
router.get('/all-list', (req, res) => {
  const { season_id } = req.query;
  const clause = season_id ? ' AND season_id = ?' : '';
  const params = season_id ? [req.user.org_id, season_id] : [req.user.org_id];
  const rows = db.prepare(`SELECT id, name_en, name_he, city, state FROM shuls WHERE org_id = ? AND is_locked = 0${clause} ORDER BY name_en`).all(...params);
  res.json({ shuls: rows });
});

router.get('/', (req, res) => {
  const { search, status, paused, season_id, sort = 'created_at', dir = 'DESC', page = 1, pageSize = 50 } = req.query;
  // Locked system shuls (e.g. "Ezras Habayis") are excluded from the normal
  // shul-management list — they're not a real shul to review/approve/edit.
  let where = 'WHERE org_id = ? AND is_locked = 0';
  const params = [req.user.org_id];
  if (req.permission.scope === 'assigned') {
    where += ` AND id IN (SELECT entity_id FROM user_assignments WHERE user_id = ? AND entity_type = 'shul')`;
    params.push(req.user.id);
  }
  if (status) { where += ' AND status = ?'; params.push(status); }
  // is_paused is orthogonal to status (a shul can be paused at any status),
  // so this is a separate filter, not one of the status dropdown's values.
  if (paused === '1' || paused === '0') { where += ' AND is_paused = ?'; params.push(+paused); }
  if (season_id) { where += ' AND season_id = ?'; params.push(season_id); }
  if (search) {
    // Phone columns get a second, dash-stripped comparison too — stored
    // numbers are always formatted "123-456-7890" (normalizePhone), so a
    // search typed without dashes wouldn't otherwise match once the typed
    // run of digits crosses where a dash sits.
    where += ` AND (name_en LIKE ? OR name_he LIKE ? OR address LIKE ? OR city LIKE ? OR state LIKE ? OR zip LIKE ?
      OR ruv_first_name LIKE ? OR ruv_last_name LIKE ? OR ruv_phone LIKE ? OR ruv_address LIKE ? OR ruv_city LIKE ?
      OR gabai_first_name LIKE ? OR gabai_last_name LIKE ? OR gabai_cell LIKE ? OR gabai_email LIKE ? OR gabai_address LIKE ? OR gabai_city LIKE ?
      OR permanent_comments LIKE ? OR REPLACE(ruv_phone,'-','') LIKE ? OR REPLACE(gabai_cell,'-','') LIKE ?)`;
    const like = `%${search}%`;
    const likeDigits = `%${search.replace(/-/g, '')}%`;
    params.push(like, like, like, like, like, like, like, like, like, like, like, like, like, like, like, like, like, like, likeDigits, likeDigits);
  }
  const allowedSort = ['created_at', 'name_en', 'status', 'city', 'shul_number'];
  const sortCol = allowedSort.includes(sort) ? sort : 'created_at';
  const sortDir = dir === 'ASC' ? 'ASC' : 'DESC';
  const total = db.prepare(`SELECT COUNT(*) c FROM shuls ${where}`).get(...params).c;
  const offset = (Math.max(1, +page) - 1) * +pageSize;
  const rows = db.prepare(`SELECT * FROM shuls ${where} ORDER BY ${sortCol} ${sortDir} LIMIT ? OFFSET ?`).all(...params, +pageSize, offset);
  // Balance columns are a distinct financial resource (shul_payments) from
  // 'shuls' itself — only attached when this viewer can actually see them,
  // so a staff user with shuls-view but no shul_payments-view never gets
  // money figures added to a list they're otherwise allowed to browse.
  const canViewPayments = getPermission(req.user, 'shul_payments').can_view;
  const balances = canViewPayments ? shulBalancesForIds(rows.map(s => s.id)) : null;
  const withCounts = rows.map(s => ({
    ...s,
    // 'incomplete' (carried forward from last season, not yet re-enrolled)
    // isn't a real submission for this season and shouldn't inflate this
    // shul's applicant count — every other status (including 'draft',
    // uploaded-but-not-yet-submitted) still counts.
    applicant_count: db.prepare(`SELECT COUNT(*) c FROM applicants WHERE shul_id = ? AND approval_status != 'incomplete'`).get(s.id).c,
    ...(canViewPayments ? (balances.get(s.id) || { pending: 0, approved: 0 }) : {}),
  }));
  res.json({ shuls: redact(withCounts, req.permission.hidden_fields), total, page: +page, pageSize: +pageSize });
});

// Full-detail CSV export — every field, no pagination, respects the same
// filters as the list view. Must be registered before /:id.
router.get('/export', requirePermission('shuls', 'can_export'), (req, res) => {
  const { search, status, paused, season_id } = req.query;
  let where = 'WHERE org_id = ? AND is_locked = 0';
  const params = [req.user.org_id];
  if (status) { where += ' AND status = ?'; params.push(status); }
  if (paused === '1' || paused === '0') { where += ' AND is_paused = ?'; params.push(+paused); }
  if (season_id) { where += ' AND season_id = ?'; params.push(season_id); }
  if (search) {
    // Phone columns get a second, dash-stripped comparison too — stored
    // numbers are always formatted "123-456-7890" (normalizePhone), so a
    // search typed without dashes wouldn't otherwise match once the typed
    // run of digits crosses where a dash sits.
    where += ` AND (name_en LIKE ? OR name_he LIKE ? OR address LIKE ? OR city LIKE ? OR state LIKE ? OR zip LIKE ?
      OR ruv_first_name LIKE ? OR ruv_last_name LIKE ? OR ruv_phone LIKE ? OR ruv_address LIKE ? OR ruv_city LIKE ?
      OR gabai_first_name LIKE ? OR gabai_last_name LIKE ? OR gabai_cell LIKE ? OR gabai_email LIKE ? OR gabai_address LIKE ? OR gabai_city LIKE ?
      OR permanent_comments LIKE ? OR REPLACE(ruv_phone,'-','') LIKE ? OR REPLACE(gabai_cell,'-','') LIKE ?)`;
    const like = `%${search}%`;
    const likeDigits = `%${search.replace(/-/g, '')}%`;
    params.push(like, like, like, like, like, like, like, like, like, like, like, like, like, like, like, like, like, like, likeDigits, likeDigits);
  }
  const rows = db.prepare(`SELECT * FROM shuls ${where} ORDER BY created_at DESC`).all(...params);
  // Per-shul applicant counts by status — one grouped query across every
  // exported shul rather than N+1 per-row queries. Only approved/pending/
  // rejected are broken out (what an admin actually wants to see at a
  // glance in the export); anything else (draft, soft_rejected, incomplete)
  // isn't a real submission yet and stays uncounted here, same as the
  // "Accepted So Far" season stat elsewhere in this app.
  const counts = {};
  if (rows.length) {
    const ids = rows.map(r => r.id);
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`SELECT shul_id, approval_status, COUNT(*) c FROM applicants WHERE shul_id IN (${placeholders}) AND approval_status IN ('approved','pending','rejected') GROUP BY shul_id, approval_status`)
      .all(...ids).forEach(r => { (counts[r.shul_id] ||= {})[r.approval_status] = r.c; });
  }
  const canViewPayments = getPermission(req.user, 'shul_payments').can_view;
  const balances = canViewPayments ? shulBalancesForIds(rows.map(r => r.id)) : null;
  const withCounts = rows.map(r => ({
    ...r,
    applicants_approved: counts[r.id]?.approved || 0,
    applicants_pending: counts[r.id]?.pending || 0,
    applicants_rejected: counts[r.id]?.rejected || 0,
    ...(canViewPayments ? (balances.get(r.id) || { pending: 0, approved: 0 }) : {}),
  }));
  sendXlsx(res, `shuls-${Date.now()}.xlsx`, redact(withCounts, req.permission.hidden_fields));
});

// A shul's portal login only ever points at ONE shul row at a time —
// carrying a shul forward into a new season re-points users.shul_id at the
// new season's row (see ensureShulPortalUser), so req.user.shul_id alone
// can't reach any earlier season's data. Every shul row this same shul has
// ever had (one per season it participated in) is found the same way
// carryForwardShul() already matches "is this the same shul": by
// gabai_email within the org, or by name_en for a shul with no gabai_email
// on file at all.
function myShulRowsAcrossSeasons(req) {
  const me = db.prepare('SELECT * FROM shuls WHERE id = ?').get(req.user.shul_id);
  if (!me) return [];
  const rows = me.gabai_email
    ? db.prepare('SELECT * FROM shuls WHERE org_id = ? AND gabai_email = ?').all(req.user.org_id, me.gabai_email)
    : db.prepare('SELECT * FROM shuls WHERE org_id = ? AND name_en = ?').all(req.user.org_id, me.name_en);
  return rows;
}

// Public (to the shul portal, not admin): every season this shul has a row
// in, for the Season Report picker on their dashboard.
router.get('/mine/seasons', (req, res) => {
  if (req.user.role !== 'shul') return res.status(403).json({ error: 'Not permitted' });
  const rows = myShulRowsAcrossSeasons(req);
  const seasons = rows.map(r => {
    const season = db.prepare('SELECT id, name, is_active FROM seasons WHERE id = ?').get(r.season_id);
    return season && { season_id: season.id, season_name: season.name, is_active: !!season.is_active, shul_status: r.status };
  }).filter(Boolean);
  res.json({ seasons });
});

// Admin-authored banner shown at the top of each shul portal page (see
// renderShell() in app.js) — one independent banner per page (keyed by the
// last segment of its href, matching SHUL_NAV in app.js), rich HTML with
// RTL support, same createRichTextEditor used by Updates. Edited from
// Settings > Shul Portal Banners and stored as a single JSON blob under the
// 'shul_portal_banners' org-wide setting (no dedicated table — same pattern
// as the homepage popup). No permission check beyond the router's own
// 'shuls' gate above, since it's just read-only banner content, not
// applicant data.
const SHUL_PORTAL_BANNER_PAGES = ['dashboard', 'upload', 'shul-info', 'payments', 'updates'];
router.get('/mine/portal-banner', (req, res) => {
  const rows = db.prepare(`SELECT key, value FROM settings WHERE org_id = ? AND key IN ('shul_portal_banners', 'shul_portal_banner_enabled', 'shul_portal_banner_html')`).all(req.user.org_id);
  const s = Object.fromEntries(rows.map(r => [r.key, r.value]));
  let banners = {};
  try { banners = JSON.parse(s.shul_portal_banners) || {}; } catch { banners = {}; }
  // One-time compatibility fallback: before per-page banners existed, a
  // single banner (shul_portal_banner_enabled/_html) showed identically on
  // every shul portal page. Until an admin saves anything under the new
  // per-page key, keep showing that same content everywhere rather than
  // silently dropping whatever was already configured — the first per-page
  // save (Settings > Shul Portal Banners) switches over for good.
  if (!Object.keys(banners).length && s.shul_portal_banner_enabled === '1' && s.shul_portal_banner_html) {
    banners = Object.fromEntries(SHUL_PORTAL_BANNER_PAGES.map(p => [p, { enabled: true, html: s.shul_portal_banner_html }]));
  }
  res.json({ banners });
});

// A shul's self-service report — every applicant they've ever submitted,
// across every season they've participated in (or just one, via
// ?season_id=), masked exactly like every other shul-facing applicant view
// (maskForShul: no rejection/duplicate status, card amount only if
// Settings > Organization has it turned on).
router.get('/mine/report', (req, res) => {
  if (req.user.role !== 'shul') return res.status(403).json({ error: 'Not permitted' });
  const rows = myShulRowsAcrossSeasons(req).filter(r => !req.query.season_id || req.query.season_id === 'all' || r.season_id === req.query.season_id);
  const seasonNames = new Map();
  const out = [];
  for (const shulRow of rows) {
    if (!seasonNames.has(shulRow.season_id)) {
      seasonNames.set(shulRow.season_id, db.prepare('SELECT name FROM seasons WHERE id = ?').get(shulRow.season_id)?.name || '(unknown season)');
    }
    const applicants = db.prepare(`SELECT * FROM applicants WHERE shul_id = ? AND approval_status != 'incomplete' ORDER BY created_at DESC`).all(shulRow.id);
    const masked = maskForShul(applicants, 'shul', req.user.org_id);
    for (const a of masked) out.push({ season: seasonNames.get(shulRow.season_id), ...a });
  }
  const columns = ['season', 'id', ...APPLICANT_IMPORT_COLUMNS.filter(c => c !== 'shul_name')];
  const formatted = out.map(r => Object.fromEntries(columns.map(c => {
    if (c === 'home_for_yomtov') return [c, r[c] ? 'Yes' : 'No'];
    return [c, r[c] ?? ''];
  })));
  sendXlsx(res, `season-report-${Date.now()}.xlsx`, formatted, columns);
});

router.get('/:id', (req, res) => {
  const shul = db.prepare('SELECT * FROM shuls WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!shul) return res.status(404).json({ error: 'Not found' });
  if (req.user.role === 'shul') { if (shul.id !== req.user.shul_id) return res.status(403).json({ error: 'Not your shul' }); }
  else { checkScope(req, res, shul.id); if (res.headersSent) return; }
  const notes = db.prepare('SELECT n.*, u.first_name, u.last_name FROM shul_notes n LEFT JOIN users u ON u.id = n.user_id WHERE n.shul_id = ? ORDER BY n.created_at DESC').all(shul.id);
  const contract = db.prepare('SELECT * FROM contracts WHERE shul_id = ? ORDER BY created_at DESC LIMIT 1').get(shul.id);
  const applicants = db.prepare('SELECT id, first_name, last_name, approval_status FROM applicants WHERE shul_id = ?').all(shul.id);
  const flags = db.prepare(`SELECT * FROM duplicate_flags WHERE entity_type='shul' AND (entity_id = ? OR matched_entity_id = ?) AND status='open'`).all(shul.id, shul.id);
  const shulOut = redact(shul, req.permission.hidden_fields);
  // Internal-only, not a configurable hidden field — a shul should never
  // even know this column exists, same boundary as shul_notes' contents
  // being an admin-facing thing (the shul just never has a UI for this one).
  if (req.user.role === 'shul') { delete shulOut.permanent_comments; delete shulOut.min_contribution_default; delete shulOut.match_rate_override; delete shulOut.match_cap_override; }
  // What the live shul application form would still consider missing on
  // this exact row — same schema-driven check the public apply form and
  // admin approval already use (see #147: a shul carried into a new season
  // needs to fill in anything genuinely missing before submitting
  // applicants, e.g. a field that wasn't required last season but is now).
  const missingInfo = shulInfoErrors(shul);
  res.json({ shul: shulOut, notes, contract, applicants, flags, missingInfo });
});

// Who edited this record and when — not shown to the shul viewing their own record.
router.get('/:id/history', requireAdmin, (req, res) => {
  const shul = db.prepare('SELECT id FROM shuls WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!shul) return res.status(404).json({ error: 'Not found' });
  res.json({ history: getEntityHistory(req.user.org_id, 'shul', shul.id) });
});

// Admin-only quick-contact: send a one-off SMS/email straight from a shul's
// detail view, and see the full history of both — matched by either
// related_entity_type/id tagging or the shul's own phone/email, so messages
// sent through the general SMS/Email Center compose flow still show up here.
router.get('/:id/messages', requireAdmin, (req, res) => {
  const shul = db.prepare('SELECT * FROM shuls WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!shul) return res.status(404).json({ error: 'Not found' });
  const phones = [shul.gabai_cell, shul.ruv_phone].filter(Boolean);
  const phonePlaceholders = phones.length ? phones.map(() => '?').join(',') : "''";
  const sms = db.prepare(`SELECT * FROM sms_messages WHERE org_id = ? AND ((related_entity_type='shul' AND related_entity_id=?) OR phone IN (${phonePlaceholders})) ORDER BY created_at DESC`)
    .all(req.user.org_id, shul.id, ...phones);
  const emails = shul.gabai_email
    ? db.prepare(`SELECT * FROM emails_sent WHERE org_id = ? AND ((related_entity_type='shul' AND related_entity_id=?) OR to_email=?) ORDER BY created_at DESC`).all(req.user.org_id, shul.id, shul.gabai_email)
    : db.prepare(`SELECT * FROM emails_sent WHERE org_id = ? AND related_entity_type='shul' AND related_entity_id=? ORDER BY created_at DESC`).all(req.user.org_id, shul.id);
  res.json({ sms, emails });
});

router.post('/:id/send-sms', requirePermission('shuls', 'can_edit'), async (req, res) => {
  // Admin-only quick-send feature — the shul-portal never calls this, and a
  // shul sending SMS "from the org" to any shul (not just itself) isn't a
  // capability it should have. Same fix applied to every admin-decision/
  // action route below that a shul-portal login could otherwise reach
  // across ANY shul, not just its own.
  if (req.user.role === 'shul') return res.status(403).json({ error: 'Not permitted' });
  const shul = db.prepare('SELECT * FROM shuls WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!shul) return res.status(404).json({ error: 'Not found' });
  const { to, body } = req.body || {};
  const phone = to || shul.gabai_cell || shul.ruv_phone;
  if (!phone) return res.status(400).json({ error: 'No phone number on file for this shul' });
  if (!body) return res.status(400).json({ error: 'Message body is required' });
  const { emailError } = await sendSmsChecked(req.user.org_id, phone, body, { relatedEntityType: 'shul', relatedEntityId: shul.id, sentBy: req.user.id });
  res.json({ ok: !emailError, emailError });
});

router.post('/:id/send-email', requirePermission('shuls', 'can_edit'), async (req, res) => {
  if (req.user.role === 'shul') return res.status(403).json({ error: 'Not permitted' });
  const shul = db.prepare('SELECT * FROM shuls WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!shul) return res.status(404).json({ error: 'Not found' });
  const { to, subject, body } = req.body || {};
  const email = to || shul.gabai_email;
  if (!email) return res.status(400).json({ error: 'No email on file for this shul' });
  if (!subject || !body) return res.status(400).json({ error: 'Subject and body are required' });
  const { emailError } = await sendMailChecked(req.user.org_id, email, subject, body, { relatedEntityType: 'shul', relatedEntityId: shul.id, sentBy: req.user.id });
  res.json({ ok: !emailError, emailError });
});

// Each season's application is its own independent shul record (spec: "treat
// every season as an entire new thing"), so there's no direct foreign key
// tying one year's record to the next. This finds likely matches for "the
// same shul" in other seasons by the identifying fields most likely to stay
// stable year over year (Gabai email, falling back to the shul's name).
router.get('/:id/other-seasons', requireAdmin, (req, res) => {
  const shul = db.prepare('SELECT * FROM shuls WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!shul) return res.status(404).json({ error: 'Not found' });
  const matches = shul.gabai_email
    ? db.prepare(`SELECT sh.id, sh.name_en, sh.status, sh.season_id, se.name AS season_name FROM shuls sh LEFT JOIN seasons se ON se.id = sh.season_id
        WHERE sh.org_id = ? AND sh.id != ? AND sh.gabai_email = ? ORDER BY se.created_at DESC`).all(req.user.org_id, shul.id, shul.gabai_email)
    : db.prepare(`SELECT sh.id, sh.name_en, sh.status, sh.season_id, se.name AS season_name FROM shuls sh LEFT JOIN seasons se ON se.id = sh.season_id
        WHERE sh.org_id = ? AND sh.id != ? AND sh.name_en = ? ORDER BY se.created_at DESC`).all(req.user.org_id, shul.id, shul.name_en);
  res.json({ matches });
});

// Carries a shul (and, optionally, some or all of its current applicants)
// forward into a different season — for a returning shul the admin already
// knows, rather than making them fill out a fresh application. `id` is the
// SOURCE shul (the season they're currently in); target_season_id is where
// they're going. Reuses an existing shul record in the target season if one
// already matches (same heuristic as GET /:id/other-seasons — gabai email,
// falling back to name) so this is safe to run more than once without
// creating duplicates; otherwise creates a new one, pre-approved (this is a
// deliberate admin action on a known shul, not a fresh review queue entry)
// with the same portal-account-creation logic as the normal approve route.
// Carried-over applicants land as approval_status='incomplete' — not a real
// submission yet — with whatever fields are already known copied over;
// nothing about them (card, disccardpromos account, etc.) carries forward,
// since that's all specific to last season. The shul completes each one via
// POST /applicants/:id/complete-reenrollment, which is where required-field
// validation against the *current* live form actually happens.
// Core of Carry Forward, shared by the single-shul route below and
// /mass-carry-forward: brings one shul (and some/all of its current-season
// applicants) into a different season without a fresh application. Returns
// { error, status } on a validation failure, otherwise the full result.
async function carryForwardShul(orgId, userId, source, targetSeason, { applicantIds, ip } = {}) {
  if (targetSeason.id === source.season_id) return { error: 'Target season must be different from the shul\'s current season', status: 400 };

  let target = source.gabai_email
    ? db.prepare('SELECT * FROM shuls WHERE org_id = ? AND season_id = ? AND gabai_email = ?').get(orgId, targetSeason.id, source.gabai_email)
    : db.prepare('SELECT * FROM shuls WHERE org_id = ? AND season_id = ? AND name_en = ?').get(orgId, targetSeason.id, source.name_en);
  let shulCreated = false;
  let flag = null;
  if (!target) {
    const id = uuid();
    // Carried forward into 'submitted' (the normal starting state), not
    // pre-approved — and no invite or contract email fires here at all.
    // The admin reviews carried-over shuls like any other pending batch and
    // explicitly mass-invites / mass-sends-contracts / approves them when
    // ready, rather than every carry-forward silently emailing the shul the
    // moment it's created.
    // shul_number is copied forward from the source, not regenerated — it's
    // the same real-world shul continuing into a new season (same as its
    // name/rav/gabai info, all copied unchanged too), and an admin's
    // applicant mass-upload sheet needs that ID to keep meaning "this shul"
    // across seasons, not go stale the moment a shul re-enrolls. See
    // generateShulNumber's own comment and the shul_number lookup in
    // routes/applicants.js POST /import for how the resulting one-ID/
    // multiple-season-rows case is disambiguated (prefers the active season).
    db.prepare(`INSERT INTO shuls (id, org_id, season_id, name_en, name_he, address, city, state, zip,
        ruv_first_name, ruv_last_name, ruv_phone, ruv_address, ruv_city, ruv_state, ruv_zip,
        gabai_first_name, gabai_last_name, gabai_cell, gabai_email, gabai_address, gabai_city, gabai_state, gabai_zip,
        status, source, permanent_comments, shul_number)
      VALUES (?,?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?, 'submitted','carried_forward', ?, ?)`)
      .run(id, orgId, targetSeason.id, source.name_en, source.name_he || '', source.address || '', source.city || '', source.state || '', source.zip || '',
        source.ruv_first_name || '', source.ruv_last_name || '', source.ruv_phone || '', source.ruv_address || '', source.ruv_city || '', source.ruv_state || '', source.ruv_zip || '',
        source.gabai_first_name || '', source.gabai_last_name || '', source.gabai_cell || '', source.gabai_email || '', source.gabai_address || '', source.gabai_city || '', source.gabai_state || '', source.gabai_zip || '',
        source.permanent_comments || null, source.shul_number || generateShulNumber(db));
    target = db.prepare('SELECT * FROM shuls WHERE id = ?').get(id);
    shulCreated = true;

    // Every other shul-creation path (public apply, admin create, import)
    // runs duplicate detection on the new row — carrying a shul forward into
    // a new season creates a real new row too and was missing this check, so
    // a shul that's actually a duplicate of some other shul went untracked
    // every season it re-enrolled. source.id is excluded from candidates:
    // it's not a genuine duplicate, it's the very row this one was cloned
    // from on purpose, and every field matches it by construction.
    flag = detectAndFlag(orgId, 'shul', target, [source.id]);
    if (flag) target = db.prepare('SELECT * FROM shuls WHERE id = ?').get(target.id);
  }

  // shul_id alone is enough to scope to "this shul's current-season
  // applicants" — every applicant under a given shul row already belongs to
  // that row's one season by construction, so an extra season_id filter
  // here is redundant and actively wrong whenever a shul's season_id is
  // NULL (an unmatched `= NULL` bind param never matches, even against
  // rows that are also NULL).
  const sourceApplicants = applicantIds === 'all'
    ? db.prepare('SELECT * FROM applicants WHERE shul_id = ?').all(source.id)
    : Array.isArray(applicantIds) && applicantIds.length
      ? db.prepare(`SELECT * FROM applicants WHERE shul_id = ? AND id IN (${applicantIds.map(() => '?').join(',')})`).all(source.id, ...applicantIds)
      : [];

  // `comments` is deliberately NOT carried over — it's this season's
  // submission-specific note and starts blank like every other season's
  // fresh application would; `permanent_comments` (internal-only, never
  // shown to the shul) is the field that's actually meant to persist
  // across seasons, so that's what gets copied here instead.
  const insertApplicant = db.prepare(`INSERT INTO applicants (id, org_id, shul_id, season_id, external_id, first_name, last_name, marital_status, home_phone, husband_cell, wife_cell, email,
      address, city, state, zip, preferred_contact_method, preferred_number, num_children, home_for_yomtov, permanent_comments, source, approval_status, carried_from_applicant_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?,?, 'carried_forward', 'incomplete', ?)`);
  // An applicant may only be carried into a given target season once —
  // re-running carry-forward for the same shul/season (or selecting the
  // same applicant again) must not pile up duplicate 'incomplete' rows for
  // the same person. carried_from_applicant_id is set on every row this
  // action creates, so "already carried into this season" is just "does a
  // row already point back at this exact source applicant, in this season".
  const alreadyCarried = db.prepare(`SELECT 1 FROM applicants WHERE season_id = ? AND carried_from_applicant_id = ?`);
  let applicantsCarried = 0, applicantsSkipped = 0;
  for (const a of sourceApplicants) {
    if (alreadyCarried.get(targetSeason.id, a.id)) { applicantsSkipped++; continue; }
    // #11: carrying an applicant forward reuses their existing external_id
    // instead of generating a fresh one. external_id is what disccardpromos
    // matches an existing customer by (see giftcard.js's
    // upsertAccountForApproval) — a new random id here would make this same
    // real person look brand new to disccardpromos every season, writing a
    // second, duplicate customer record instead of renewing the one that
    // already exists. Falls back to generating fresh only if the source
    // row somehow has none (shouldn't happen — every applicant gets one at
    // creation and a startup migration backfills any legacy row missing it).
    insertApplicant.run(uuid(), orgId, target.id, targetSeason.id, a.external_id || generateApplicantExternalId(db), a.first_name, a.last_name, a.marital_status || '',
      a.home_phone || '', a.husband_cell || '', a.wife_cell || '', a.email || '', a.address || '', a.city || '', a.state || '', a.zip || '',
      a.preferred_contact_method || '', a.preferred_number || '', a.num_children || 0, a.home_for_yomtov || 0, a.permanent_comments || null, a.id);
    applicantsCarried++;
  }
  logAudit(orgId, userId, 'carry-forward', 'shul', source.id, { season_id: source.season_id },
    { target_shul_id: target.id, target_season_id: targetSeason.id, applicants_carried: applicantsCarried, applicants_skipped: applicantsSkipped }, ip);
  return { shul: target, shulCreated, duplicate: !!flag, applicantsCarried, applicantsSkipped };
}

router.post('/:id/carry-forward', requirePermission('shuls', 'can_edit'), async (req, res) => {
  const source = db.prepare('SELECT * FROM shuls WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!source) return res.status(404).json({ error: 'Not found' });
  const targetSeason = db.prepare('SELECT * FROM seasons WHERE id = ? AND org_id = ?').get(req.body?.season_id, req.user.org_id);
  if (!targetSeason) return res.status(400).json({ error: 'Target season not found' });
  const result = await carryForwardShul(req.user.org_id, req.user.id, source, targetSeason,
    { applicantIds: req.body?.applicant_ids, ip: req.ip });
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json(result);
});

// Bulk carry-forward: every selected shul (and ALL of its current-season
// applicants — a per-shul applicant picker isn't practical in bulk) into one
// target season. Shuls whose current season already IS the target are
// skipped rather than failing the whole batch.
router.post('/mass-carry-forward', requirePermission('shuls', 'can_edit'), async (req, res) => {
  const { ids, season_id } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids array required' });
  const targetSeason = db.prepare('SELECT * FROM seasons WHERE id = ? AND org_id = ?').get(season_id, req.user.org_id);
  if (!targetSeason) return res.status(400).json({ error: 'Target season not found' });
  let carried = 0, skipped = 0, duplicatesFlagged = 0, applicantsCarried = 0, applicantsSkipped = 0;
  const affectedIds = [], names = [];
  for (const id of ids) {
    const source = db.prepare('SELECT * FROM shuls WHERE id = ? AND org_id = ?').get(id, req.user.org_id);
    if (!source) { skipped++; continue; }
    const result = await carryForwardShul(req.user.org_id, req.user.id, source, targetSeason,
      { applicantIds: 'all', ip: req.ip });
    if (result.error) { skipped++; continue; }
    if (result.duplicate) duplicatesFlagged++;
    applicantsCarried += result.applicantsCarried;
    applicantsSkipped += result.applicantsSkipped;
    affectedIds.push(result.shul.id); names.push(result.shul.name_en);
    carried++;
  }
  logMassAudit(req.user.org_id, req.user.id, 'mass-carry-forward', 'shul', affectedIds,
    { skipped, duplicatesFlagged, applicantsCarried, applicantsSkipped, target_season_id: targetSeason.id, names }, req.ip);
  res.json({ carried, skipped, duplicatesFlagged, applicantsCarried, applicantsSkipped });
});

router.post('/', requirePermission('shuls', 'can_edit'), (req, res) => {
  const b = req.body || {};
  if (b.ruv_phone !== undefined) b.ruv_phone = normalizePhone(b.ruv_phone);
  if (b.gabai_cell !== undefined) b.gabai_cell = normalizePhone(b.gabai_cell);
  if (!isValidPhone(b.ruv_phone)) return res.status(400).json({ error: 'Rav Phone Number must be a valid phone number (10 digits, or 11 digits starting with 1)' });
  if (!isValidPhone(b.gabai_cell)) return res.status(400).json({ error: 'Gabai Cell Number must be a valid phone number (10 digits, or 11 digits starting with 1)' });
  for (const f of REQUIRED_SHUL_FIELDS) if (!b[f]) return res.status(400).json({ error: `Missing required field: ${f}` });
  const id = uuid();
  const season = db.prepare('SELECT * FROM seasons WHERE org_id = ? AND is_active = 1 ORDER BY created_at DESC LIMIT 1').get(req.user.org_id);
  db.prepare(`INSERT INTO shuls (id, org_id, season_id, name_en, name_he, address, city, state, zip,
      ruv_first_name, ruv_last_name, ruv_phone, gabai_first_name, gabai_last_name, gabai_cell, gabai_email, status, source, shul_number)
    VALUES (?,?,?,?,?,?,?,?,?, ?,?,?, ?,?,?,?, 'submitted','admin', ?)`)
    .run(id, req.user.org_id, season?.id || null, b.name_en, b.name_he || '', b.address, b.city, b.state, b.zip,
      b.ruv_first_name, b.ruv_last_name, b.ruv_phone, b.gabai_first_name, b.gabai_last_name, b.gabai_cell, b.gabai_email, generateShulNumber(db));
  const shul = db.prepare('SELECT * FROM shuls WHERE id = ?').get(id);
  const flag = detectAndFlag(req.user.org_id, 'shul', shul);
  logAudit(req.user.org_id, req.user.id, 'create', 'shul', id, null, shul, req.ip);
  res.status(201).json({ shul, duplicate: !!flag });
});

// A shul-portal user may edit their OWN shul row here too (self-service —
// see #147: a shul carried into a new season with missing info has no
// other way to complete it, since a shul-role user never gets requireAdmin
// access). Restricted to the same contact/address fields the public apply
// form itself asks for — never permanent_comments or status, both of which
// stay strictly admin/internal.
const SHUL_SELF_EDITABLE_FIELDS = ['name_en','name_he','address','city','state','zip','lat','lng','ruv_first_name','ruv_last_name','ruv_phone','ruv_address','ruv_city','ruv_state','ruv_zip',
  'gabai_first_name','gabai_last_name','gabai_cell','gabai_email','gabai_address','gabai_city','gabai_state','gabai_zip'];
router.put('/:id', (req, res) => {
  const isSelf = req.user.role === 'shul' && req.params.id === req.user.shul_id;
  if (!isSelf && !['super_admin', 'org_admin', 'staff'].includes(req.user.role)) return res.status(403).json({ error: 'Admin access required' });
  const shul = db.prepare('SELECT * FROM shuls WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!shul) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  if (b.ruv_phone !== undefined) b.ruv_phone = normalizePhone(b.ruv_phone);
  if (b.gabai_cell !== undefined) b.gabai_cell = normalizePhone(b.gabai_cell);
  if (!isValidPhone(b.ruv_phone)) return res.status(400).json({ error: 'Rav Phone Number must be a valid phone number (10 digits, or 11 digits starting with 1)' });
  if (!isValidPhone(b.gabai_cell)) return res.status(400).json({ error: 'Gabai Cell Number must be a valid phone number (10 digits, or 11 digits starting with 1)' });
  const fields = isSelf ? SHUL_SELF_EDITABLE_FIELDS : [...SHUL_SELF_EDITABLE_FIELDS, 'permanent_comments', 'min_contribution_default', 'stripe_payments_enabled', 'match_rate_override', 'match_cap_override'];
  const sets = fields.filter(f => b[f] !== undefined);
  if (sets.length) {
    db.prepare(`UPDATE shuls SET ${sets.map(f => `${f}=?`).join(',')}, updated_at=datetime('now') WHERE id=?`).run(...sets.map(f => b[f]), shul.id);
  }
  const updated = db.prepare('SELECT * FROM shuls WHERE id = ?').get(shul.id);
  logAudit(req.user.org_id, req.user.id, 'update', 'shul', shul.id, shul, updated, req.ip);
  // ensureShulPortalUser only ever reads gabai_email at invite time — an
  // edit here otherwise had zero effect on an already-issued login, so
  // "removing" a shul's email in this form never actually revoked access:
  // the old login kept working with the old address indefinitely (same bug
  // as stores.js's PUT /:id, fixed there identically). Unlike stores, a
  // shul CAN reach this route on their own record (isSelf) — revoking here
  // would immediately kill the session of the very person mid-edit of their
  // own profile, which is a confusing self-lockout, not a security fix. So
  // self-edits sync the login's email to match instead (same account, same
  // session, just re-pointed to the address they just typed as themselves,
  // already authenticated); only an admin editing someone else's shul
  // revokes on mismatch, the same as the store fix.
  if (sets.includes('gabai_email') && updated.portal_user_id) {
    const portalUser = db.prepare('SELECT * FROM users WHERE id = ?').get(updated.portal_user_id);
    const newEmail = normalizeEmail(updated.gabai_email);
    if (portalUser && portalUser.is_active && normalizeEmail(portalUser.email) !== newEmail) {
      // Sync only for a self-edit to a real, non-colliding address — the
      // login stays the same account/session, just re-pointed. Everything
      // else (an admin's edit, a blanked email, or one that collides with
      // another account) revokes instead: users.email is NOT NULL/UNIQUE so
      // a blank or colliding value can't be synced to anyway, and an
      // admin's edit is exactly the "cut off the old address" case this
      // whole fix exists for.
      const clash = newEmail ? db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(newEmail, portalUser.id) : null;
      if (isSelf && newEmail && !clash) {
        db.prepare('UPDATE users SET email = ? WHERE id = ?').run(newEmail, portalUser.id);
      } else {
        db.prepare('UPDATE users SET is_active = 0, token_version = token_version + 1 WHERE id = ?').run(portalUser.id);
        logAudit(req.user.org_id, req.user.id, 'update', 'user', portalUser.id, { is_active: 1 }, { is_active: 0 }, req.ip);
      }
    }
  }
  const shulOut = { ...updated };
  if (isSelf) delete shulOut.permanent_comments;
  const missingInfo = shulInfoErrors(updated);
  res.json({ shul: shulOut, missingInfo });
});

// Approve: creates the shul portal login, emails the set-up link.
router.post('/:id/approve', requirePermission('shuls', 'can_edit'), async (req, res) => {
  if (req.user.role === 'shul') return res.status(403).json({ error: 'Not permitted' });
  const shul = db.prepare('SELECT * FROM shuls WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!shul) return res.status(404).json({ error: 'Not found' });
  if (shul.is_paused) return res.status(423).json({ error: 'This shul has an unresolved duplicate flag and cannot be approved yet' });
  if (!req.body?.bypass_contract && shulNeedsContractBeforeApproval(req.user.org_id, shul)) {
    return res.status(400).json({ error: "This shul's contract isn't required at signup and hasn't been sent yet. Send it from the Contract tab before approving, or bypass to skip the requirement.", code: 'CONTRACT_NOT_SENT' });
  }

  let user = ensureShulPortalUser(req.user.org_id, shul, req.body.portal_email);
  db.prepare(`UPDATE shuls SET status='approved', portal_user_id=?, updated_at=datetime('now') WHERE id=?`)
    .run(user.id, shul.id);
  const loginUrl = shulLoginUrl(user);
  const tmpl = renderSystemTemplate(req.user.org_id, 'accountApproved', { shulName: shul.name_en, loginUrl });
  const { emailError } = await sendMailChecked(req.user.org_id, user.email, tmpl.subject, tmpl.body, { replyTo: tmpl.replyTo, sentBy: req.user.id });
  if (emailError) console.error('[mail] shul approval email failed:', emailError);
  logAudit(req.user.org_id, req.user.id, 'approve', 'shul', shul.id, shul, { status: 'approved' }, req.ip);
  res.json({ ok: true, shul: db.prepare('SELECT * FROM shuls WHERE id = ?').get(shul.id), emailError });
});

// Re-send the "you're approved, set up your account" email — for when the
// first send silently failed (e.g. no email provider configured at the
// time) and there's no "unapprove" action to redo the approve step with.
// Refreshes the invite token/expiry in case the original one already expired.
router.post('/:id/resend-welcome', requirePermission('shuls', 'can_edit'), async (req, res) => {
  const shul = db.prepare('SELECT * FROM shuls WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!shul) return res.status(404).json({ error: 'Not found' });
  if (shul.status !== 'approved' || !shul.portal_user_id) return res.status(400).json({ error: 'This shul has not been approved yet' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(shul.portal_user_id);
  if (!user) return res.status(404).json({ error: 'Portal account not found' });
  if (user.is_active) return res.status(400).json({ error: 'This shul has already set up their account and signed in. Nothing to resend.' });
  const token = uuid();
  const expires = new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString();
  db.prepare('UPDATE users SET invite_token = ?, invite_expires = ? WHERE id = ?').run(token, expires, user.id);
  const loginUrl = `${process.env.APP_URL || ''}/accept-invite?token=${token}`;
  const tmpl = renderSystemTemplate(req.user.org_id, 'accountApproved', { shulName: shul.name_en, loginUrl });
  const { emailError } = await sendMailChecked(req.user.org_id, user.email, tmpl.subject, tmpl.body, { replyTo: tmpl.replyTo, sentBy: req.user.id });
  if (emailError) console.error('[mail] shul welcome resend failed:', emailError);
  res.json({ ok: true, emailError });
});

router.post('/:id/reject', requirePermission('shuls', 'can_edit'), (req, res) => {
  if (req.user.role === 'shul') return res.status(403).json({ error: 'Not permitted' });
  const shul = db.prepare('SELECT * FROM shuls WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!shul) return res.status(404).json({ error: 'Not found' });
  db.prepare(`UPDATE shuls SET status='rejected', updated_at=datetime('now') WHERE id=?`).run(shul.id);
  logAudit(req.user.org_id, req.user.id, 'reject', 'shul', shul.id, shul, null, req.ip);
  res.json({ ok: true });
});

router.post('/mass-reject', requirePermission('shuls', 'can_edit'), (req, res) => {
  if (req.user.role === 'shul') return res.status(403).json({ error: 'Not permitted' });
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids array required' });
  let rejected = 0, skipped = 0; const affectedIds = [], names = [];
  for (const id of ids) {
    const shul = db.prepare('SELECT * FROM shuls WHERE id = ? AND org_id = ?').get(id, req.user.org_id);
    if (!shul) { skipped++; continue; }
    db.prepare(`UPDATE shuls SET status='rejected', updated_at=datetime('now') WHERE id=?`).run(shul.id);
    affectedIds.push(shul.id); names.push(shul.name_en);
    rejected++;
  }
  logMassAudit(req.user.org_id, req.user.id, 'mass-reject', 'shul', affectedIds, { skipped, names }, req.ip);
  res.json({ rejected, skipped });
});

// Bulk approve. Paused shuls (unresolved duplicate flag, same rule as the
// single-shul approve route) are skipped, not blocked.
router.post('/mass-approve', requirePermission('shuls', 'can_edit'), async (req, res) => {
  if (req.user.role === 'shul') return res.status(403).json({ error: 'Not permitted' });
  const { ids, bypass_contract } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids array required' });
  let approved = 0, skipped = 0, emailErrors = 0; const affectedIds = [], names = [];
  for (const id of ids) {
    const shul = db.prepare('SELECT * FROM shuls WHERE id = ? AND org_id = ?').get(id, req.user.org_id);
    if (!shul || shul.is_paused) { skipped++; continue; }
    if (!bypass_contract && shulNeedsContractBeforeApproval(req.user.org_id, shul)) { skipped++; continue; }
    let user = ensureShulPortalUser(req.user.org_id, shul, null);
    db.prepare(`UPDATE shuls SET status='approved', portal_user_id=?, updated_at=datetime('now') WHERE id=?`)
      .run(user.id, shul.id);
    const loginUrl = shulLoginUrl(user);
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    const tmpl = renderSystemTemplate(req.user.org_id, 'accountApproved', { shulName: shul.name_en, loginUrl });
    const { emailError } = await sendMailChecked(req.user.org_id, user.email, tmpl.subject, tmpl.body, { replyTo: tmpl.replyTo, sentBy: req.user.id });
    if (emailError) { emailErrors++; console.error('[mail] mass-approve shul email failed:', emailError); }
    affectedIds.push(shul.id); names.push(shul.name_en);
    approved++;
  }
  logMassAudit(req.user.org_id, req.user.id, 'mass-approve', 'shul', affectedIds, { skipped, emailErrors, names }, req.ip);
  res.json({ approved, skipped, emailErrors });
});

// Invite-only: creates (if needed) the shul's portal login and emails the
// password-setup link — the standalone version of what approve/mass-approve
// already bundle in as part of approving. Exists mainly for a carried-
// forward shul, which now starts back at 'submitted' rather than
// pre-approved (see carryForwardShul) and needs to be invited as its own
// explicit step.
router.post('/:id/invite', requirePermission('shuls', 'can_edit'), async (req, res) => {
  if (req.user.role === 'shul') return res.status(403).json({ error: 'Not permitted' });
  const shul = db.prepare('SELECT * FROM shuls WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!shul) return res.status(404).json({ error: 'Not found' });
  const user = ensureShulPortalUser(req.user.org_id, shul, req.body?.portal_email);
  if (shul.portal_user_id !== user.id) db.prepare('UPDATE shuls SET portal_user_id = ? WHERE id = ?').run(user.id, shul.id);
  const loginUrl = shulLoginUrl(user);
  const tmpl = renderSystemTemplate(req.user.org_id, 'accountApproved', { shulName: shul.name_en, loginUrl });
  const { emailError } = await sendMailChecked(req.user.org_id, user.email, tmpl.subject, tmpl.body, { replyTo: tmpl.replyTo, sentBy: req.user.id });
  if (emailError) console.error('[mail] shul invite email failed:', emailError);
  logAudit(req.user.org_id, req.user.id, 'update', 'shul', shul.id, { portal_user_id: shul.portal_user_id }, { portal_user_id: user.id }, req.ip);
  res.json({ ok: true, shul: db.prepare('SELECT * FROM shuls WHERE id = ?').get(shul.id), emailError });
});

router.post('/mass-invite', requirePermission('shuls', 'can_edit'), async (req, res) => {
  if (req.user.role === 'shul') return res.status(403).json({ error: 'Not permitted' });
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids array required' });
  let invited = 0, skipped = 0, emailErrors = 0; const affectedIds = [], names = [];
  for (const id of ids) {
    const shul = db.prepare('SELECT * FROM shuls WHERE id = ? AND org_id = ?').get(id, req.user.org_id);
    if (!shul) { skipped++; continue; }
    const user = ensureShulPortalUser(req.user.org_id, shul, null);
    if (shul.portal_user_id !== user.id) db.prepare('UPDATE shuls SET portal_user_id = ? WHERE id = ?').run(user.id, shul.id);
    const loginUrl = shulLoginUrl(user);
    const tmpl = renderSystemTemplate(req.user.org_id, 'accountApproved', { shulName: shul.name_en, loginUrl });
    const { emailError } = await sendMailChecked(req.user.org_id, user.email, tmpl.subject, tmpl.body, { replyTo: tmpl.replyTo, sentBy: req.user.id });
    if (emailError) { emailErrors++; console.error('[mail] mass-invite shul email failed:', emailError); }
    affectedIds.push(shul.id); names.push(shul.name_en);
    invited++;
  }
  logMassAudit(req.user.org_id, req.user.id, 'mass-invite', 'shul', affectedIds, { skipped, emailErrors, names }, req.ip);
  res.json({ invited, skipped, emailErrors });
});

// Mass version of POST /:id/send-contract — same per-shul contract
// generation/email, just looped. Skips (not fails) shuls with no gabai
// email on file or an already-signed contract, same as the single route
// would 400/409 on.
router.post('/mass-send-contract', requirePermission('shuls', 'can_edit'), async (req, res) => {
  if (req.user.role === 'shul') return res.status(403).json({ error: 'Not permitted' });
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids array required' });
  let sent = 0, skipped = 0, emailErrors = 0; const affectedIds = [], names = [];
  for (const id of ids) {
    const shul = db.prepare('SELECT * FROM shuls WHERE id = ? AND org_id = ?').get(id, req.user.org_id);
    if (!shul || !shul.gabai_email) { skipped++; continue; }
    const result = await sendContractForShul(req.user.org_id, shul, shul.gabai_email, { sentBy: req.user.id });
    if (result.error) { skipped++; continue; }
    if (result.emailError) { emailErrors++; console.error('[mail] mass-send-contract shul email failed:', result.emailError); }
    affectedIds.push(shul.id); names.push(shul.name_en);
    sent++;
  }
  logMassAudit(req.user.org_id, req.user.id, 'mass-send-contract', 'shul', affectedIds, { skipped, emailErrors, names }, req.ip);
  res.json({ sent, skipped, emailErrors });
});

// Overrides every already-sent-but-not-yet-signed contract's PDF in place
// with whatever the contract template (uploaded PDF or generated text)
// currently is — for "I just fixed a typo in the template, get it onto the
// links that are already out" without re-sending anything. Deliberately
// does NOT touch sign_token, sent_at, or create a new contract row — the
// shul's existing email link keeps working and now serves the updated
// file, since generateContractPdf always writes to the same shul-id-keyed
// path a 'sent' contract's pdf_path already points to. Signed contracts are
// never selected here at all (same protection sendContractForShul already
// gives them) — this can't touch an executed agreement.
router.post('/contracts/regenerate-unsigned', requirePermission('shuls', 'can_edit'), async (req, res) => {
  if (req.user.role === 'shul') return res.status(403).json({ error: 'Not permitted' });
  const shulIds = db.prepare(`SELECT DISTINCT c.shul_id FROM contracts c JOIN shuls s ON s.id = c.shul_id WHERE c.status = 'sent' AND s.org_id = ?`).all(req.user.org_id).map(r => r.shul_id);
  if (!shulIds.length) return res.json({ updated: 0 });
  const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(req.user.org_id);
  const templateSetting = db.prepare(`SELECT value FROM settings WHERE org_id = ? AND key = 'contract_template_text'`).get(req.user.org_id);
  let updated = 0; const affectedIds = [], names = [];
  for (const shulId of shulIds) {
    const shul = db.prepare('SELECT * FROM shuls WHERE id = ?').get(shulId);
    if (!shul) continue;
    const season = db.prepare('SELECT * FROM seasons WHERE id = ?').get(shul.season_id);
    await generateContractPdf({ shul, season, templateText: templateSetting?.value, orgName: org.name });
    affectedIds.push(shul.id); names.push(shul.name_en);
    updated++;
  }
  logMassAudit(req.user.org_id, req.user.id, 'regenerate-unsigned-contracts', 'shul', affectedIds, { names }, req.ip);
  res.json({ updated });
});

// Manually move a shul back to 'submitted' (the pending-review state before
// approve/reject) — for un-rejecting or un-approving one to reconsider it.
router.post('/:id/set-pending', requirePermission('shuls', 'can_edit'), (req, res) => {
  if (req.user.role === 'shul') return res.status(403).json({ error: 'Not permitted' });
  const shul = db.prepare('SELECT * FROM shuls WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!shul) return res.status(404).json({ error: 'Not found' });
  db.prepare(`UPDATE shuls SET status='submitted', updated_at=datetime('now') WHERE id=?`).run(shul.id);
  logAudit(req.user.org_id, req.user.id, 'set-pending', 'shul', shul.id, { status: shul.status }, { status: 'submitted' }, req.ip);
  res.json({ ok: true, shul: db.prepare('SELECT * FROM shuls WHERE id = ?').get(shul.id) });
});

router.post('/mass-set-pending', requirePermission('shuls', 'can_edit'), (req, res) => {
  if (req.user.role === 'shul') return res.status(403).json({ error: 'Not permitted' });
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids array required' });
  let updated = 0, skipped = 0; const affectedIds = [], names = [];
  for (const id of ids) {
    const shul = db.prepare('SELECT * FROM shuls WHERE id = ? AND org_id = ?').get(id, req.user.org_id);
    if (!shul) { skipped++; continue; }
    db.prepare(`UPDATE shuls SET status='submitted', updated_at=datetime('now') WHERE id=?`).run(shul.id);
    affectedIds.push(shul.id); names.push(shul.name_en);
    updated++;
  }
  logMassAudit(req.user.org_id, req.user.id, 'mass-set-pending', 'shul', affectedIds, { skipped, names }, req.ip);
  res.json({ updated, skipped });
});

// Permanent deletion — full removal, not the reject/pause soft-states
// elsewhere in this file. Applicants belonging to this shul are NOT
// deleted — that's a separate, deliberate action (DELETE
// /applicants/:id/permanent) — they're just unlinked (shul_id set to null)
// so an admin can reassign them rather than silently losing their records.
// A linked portal login is deactivated (not deleted) since that's the
// user-management flow's job, not this one's. FK enforcement is ON, so
// every hard reference is cleaned up first, wrapped in a transaction.
router.delete('/:id/permanent', requirePermission('shuls', 'can_edit'), (req, res) => {
  if (req.user.role === 'shul') return res.status(403).json({ error: 'Not permitted' });
  const shul = db.prepare('SELECT * FROM shuls WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!shul) return res.status(404).json({ error: 'Not found' });
  // Snapshot every related row before the cascade removes/unlinks it, so a
  // super_admin can fully undo this from Recent Actions — "Delete
  // Permanently" still reads and behaves as a real permanent delete, this
  // is purely a safety net (see utils/entityDelete.js's snapshot/restore
  // comment block).
  const snapshot = captureShulSnapshot(shul);
  const del = db.transaction(() => hardDeleteShul(shul));
  del();
  logAudit(req.user.org_id, req.user.id, 'delete', 'shul', shul.id, snapshot, null, req.ip);
  res.json({ ok: true });
});

router.post('/mass-delete-permanent', requirePermission('shuls', 'can_edit'), (req, res) => {
  if (req.user.role === 'shul') return res.status(403).json({ error: 'Not permitted' });
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids array required' });
  let deleted = 0, skipped = 0; const affectedIds = [], names = [], snapshots = [];
  for (const id of ids) {
    const shul = db.prepare('SELECT * FROM shuls WHERE id = ? AND org_id = ?').get(id, req.user.org_id);
    if (!shul) { skipped++; continue; }
    const snapshot = captureShulSnapshot(shul);
    const del = db.transaction(() => hardDeleteShul(shul));
    del();
    snapshots.push(snapshot);
    affectedIds.push(shul.id); names.push(shul.name_en);
    deleted++;
  }
  // The deleted rows' own ids aren't useful to a reviewer any more (nothing
  // left to look up by them), but logMassAudit still needs a non-empty list
  // to know a mass-delete entry is worth logging at all — names is what
  // actually matters here, ids is just the "how many / which ones" record.
  // snapshots carries the full undo data for this click (undoMassDeleteEntry).
  logMassAudit(req.user.org_id, req.user.id, 'mass-delete', 'shul', affectedIds, { skipped, names, snapshots }, req.ip);
  res.json({ deleted, skipped });
});

// Generate + email the contract (spec #3: "always email them when there's a doc to sign").
// Generates a fresh unsigned contract for a shul and emails the signing
// link. Refuses to overwrite an already-signed contract (see below) —
// returns { error } instead in that case, never throws for that case.
// setStatus controls whether the shul's status flips to 'contract_sent' —
// the manual "Generate & Email Contract" route wants that (it's the normal
// submitted -> contract_sent -> approved lifecycle), but carry-forward
// creates its shul row pre-approved on purpose and calls this with
// setStatus:false so sending the contract doesn't quietly undo that.
async function sendContractForShul(orgId, shul, toEmail, { setStatus = true, sentBy = null } = {}) {
  // The shul detail view always shows the *latest* contract row for this
  // shul (ORDER BY created_at DESC LIMIT 1) — creating a new one here
  // unconditionally would shadow an already-executed, legally-signed
  // agreement behind a fresh unsigned one. This is exactly the scenario
  // triggered by "I uploaded a new template PDF, let me resend the
  // contract" for a shul that's already signed: nothing was actually
  // deleted (the old row and its signed_pdf_path both still exist), but it
  // would become unreachable through the normal admin UI, which reads as
  // "the signed one got lost." Block it; retracting the signature first
  // (a separate, explicit, audited action) is the real way to redo one.
  const existingContract = db.prepare('SELECT * FROM contracts WHERE shul_id = ? ORDER BY created_at DESC LIMIT 1').get(shul.id);
  if (existingContract?.status === 'signed') {
    return { error: 'This shul already has a signed contract on file. Retract the existing signature first if you need to send a new one.' };
  }
  const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(orgId);
  const season = db.prepare('SELECT * FROM seasons WHERE id = ?').get(shul.season_id);
  const templateSetting = db.prepare(`SELECT value FROM settings WHERE org_id = ? AND key = 'contract_template_text'`).get(orgId);
  const pdfPath = await generateContractPdf({ shul, season, templateText: templateSetting?.value, orgName: org.name });
  const token = uuid();
  const expires = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
  const id = uuid();
  db.prepare(`INSERT INTO contracts (id, shul_id, season_id, pdf_path, status, sign_token, sign_token_expires, sent_at)
    VALUES (?,?,?,?,'sent',?,?,datetime('now'))`).run(id, shul.id, shul.season_id, pdfPath, token, expires);
  if (setStatus) db.prepare(`UPDATE shuls SET status='contract_sent', updated_at=datetime('now') WHERE id=?`).run(shul.id);
  const signUrl = `${process.env.APP_URL || ''}/sign-contract?token=${token}`;
  const tmpl = renderSystemTemplate(orgId, 'contractReady', { shulName: shul.name_en, signUrl });
  const { emailError } = await sendMailChecked(orgId, toEmail, tmpl.subject, tmpl.body, { replyTo: tmpl.replyTo, sentBy });
  if (emailError) console.error('[mail] contract email failed:', emailError);
  return { contract: db.prepare('SELECT * FROM contracts WHERE id = ?').get(id), emailError };
}

router.post('/:id/send-contract', requirePermission('shuls', 'can_edit'), async (req, res) => {
  if (req.user.role === 'shul') return res.status(403).json({ error: 'Not permitted' });
  const shul = db.prepare('SELECT * FROM shuls WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!shul) return res.status(404).json({ error: 'Not found' });
  const to = req.body.email || shul.gabai_email;
  const result = await sendContractForShul(req.user.org_id, shul, to, { sentBy: req.user.id });
  if (result.error) return res.status(409).json({ error: result.error });
  logAudit(req.user.org_id, req.user.id, 'send_contract', 'shul', shul.id, null, { to }, req.ip);
  res.json({ ok: true, contract: result.contract, emailError: result.emailError });
});

// Undo a signature — for a signed-in-error or outdated signature, not a
// rejection. Resets the shul's latest contract back to 'sent' with a fresh
// signing link so it can be signed again; doesn't email anyone
// automatically, and deliberately leaves the shul's own status alone (an
// already-approved shul stays approved) since that's a separate decision.
router.post('/:id/contract/retract', requirePermission('shuls', 'can_edit'), (req, res) => {
  if (req.user.role === 'shul') return res.status(403).json({ error: 'Not permitted' });
  const shul = db.prepare('SELECT * FROM shuls WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!shul) return res.status(404).json({ error: 'Not found' });
  const contract = db.prepare('SELECT * FROM contracts WHERE shul_id = ? ORDER BY created_at DESC LIMIT 1').get(shul.id);
  if (!contract || contract.status !== 'signed') return res.status(400).json({ error: 'Only a signed contract can have its signature retracted' });
  const token = uuid();
  const expires = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
  db.prepare(`UPDATE contracts SET status='sent', signature_data=NULL, signer_name=NULL, signer_title=NULL, signed_at=NULL, ip_address=NULL, signed_pdf_path=NULL, esign_consent_at=NULL, sign_token=?, sign_token_expires=? WHERE id=?`)
    .run(token, expires, contract.id);
  logAudit(req.user.org_id, req.user.id, 'retract_signature', 'shul', shul.id, contract, null, req.ip);
  res.json({ ok: true, contract: db.prepare('SELECT * FROM contracts WHERE id = ?').get(contract.id) });
});

router.get('/:id/contract/pdf', (req, res) => {
  const contract = db.prepare(`SELECT c.* FROM contracts c JOIN shuls s ON s.id=c.shul_id WHERE c.shul_id = ? AND s.org_id = ? ORDER BY c.created_at DESC LIMIT 1`).get(req.params.id, req.user.org_id);
  if (!contract) return res.status(404).json({ error: 'No contract on file' });
  const path = contract.signed_pdf_path || contract.pdf_path;
  if (!path) return res.status(404).json({ error: 'PDF not available' });
  res.sendFile(path);
});

// Internal-only, never shown to the shul viewing its own record (same
// boundary as applicant_notes) — a shul-portal login has no reason to add one.
router.post('/:id/notes', (req, res) => {
  if (req.user.role === 'shul') return res.status(403).json({ error: 'Not permitted' });
  const { note } = req.body || {};
  if (!note) return res.status(400).json({ error: 'Note text required' });
  const shul = db.prepare('SELECT * FROM shuls WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!shul) return res.status(404).json({ error: 'Not found' });
  const id = uuid();
  db.prepare('INSERT INTO shul_notes (id, shul_id, user_id, note) VALUES (?,?,?,?)').run(id, shul.id, req.user.id, note);
  res.status(201).json({ note: db.prepare('SELECT * FROM shul_notes WHERE id = ?').get(id) });
});

router.post('/:id/pause', requirePermission('shuls', 'can_edit'), (req, res) => {
  if (req.user.role === 'shul') return res.status(403).json({ error: 'Not permitted' });
  db.prepare('UPDATE shuls SET is_paused = 1 WHERE id = ? AND org_id = ?').run(req.params.id, req.user.org_id);
  db.prepare('UPDATE users SET is_paused = 1 WHERE shul_id = ?').run(req.params.id);
  res.json({ ok: true });
});
router.post('/:id/unpause', requirePermission('shuls', 'can_edit'), (req, res) => {
  if (req.user.role === 'shul') return res.status(403).json({ error: 'Not permitted' });
  db.prepare('UPDATE shuls SET is_paused = 0 WHERE id = ? AND org_id = ?').run(req.params.id, req.user.org_id);
  db.prepare('UPDATE users SET is_paused = 0 WHERE shul_id = ?').run(req.params.id);
  res.json({ ok: true });
});
router.post('/mass-pause', requirePermission('shuls', 'can_edit'), (req, res) => {
  if (req.user.role === 'shul') return res.status(403).json({ error: 'Not permitted' });
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids array required' });
  let paused = 0, skipped = 0;
  for (const id of ids) {
    const shul = db.prepare('SELECT id FROM shuls WHERE id = ? AND org_id = ?').get(id, req.user.org_id);
    if (!shul) { skipped++; continue; }
    db.prepare('UPDATE shuls SET is_paused = 1 WHERE id = ?').run(shul.id);
    db.prepare('UPDATE users SET is_paused = 1 WHERE shul_id = ?').run(shul.id);
    paused++;
  }
  res.json({ paused, skipped });
});
router.post('/mass-unpause', requirePermission('shuls', 'can_edit'), (req, res) => {
  if (req.user.role === 'shul') return res.status(403).json({ error: 'Not permitted' });
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids array required' });
  let unpaused = 0, skipped = 0;
  for (const id of ids) {
    const shul = db.prepare('SELECT id FROM shuls WHERE id = ? AND org_id = ?').get(id, req.user.org_id);
    if (!shul) { skipped++; continue; }
    db.prepare('UPDATE shuls SET is_paused = 0 WHERE id = ?').run(shul.id);
    db.prepare('UPDATE users SET is_paused = 0 WHERE shul_id = ?').run(shul.id);
    unpaused++;
  }
  res.json({ unpaused, skipped });
});

// Duplicate flags involving shuls. season_id (optional) scopes this to
// flags whose FLAGGED shul (entity_id) belongs to that season — matching
// stays cross-season (checkShulDuplicate looks at every season on
// purpose), so the matched-against shul can legitimately be from an older
// season; this only filters out flags for a *different* season's shul
// entirely, unrelated to whatever season the admin is currently working in.
router.get('/duplicates/open', requireAdmin, (req, res) => {
  const { season_id } = req.query;
  const rows = season_id
    ? db.prepare(`SELECT df.* FROM duplicate_flags df JOIN shuls s ON s.id = df.entity_id
        WHERE df.org_id = ? AND df.entity_type='shul' AND df.status='open' AND s.season_id = ? ORDER BY df.created_at DESC`).all(req.user.org_id, season_id)
    : db.prepare(`SELECT * FROM duplicate_flags WHERE org_id = ? AND entity_type='shul' AND status='open' ORDER BY created_at DESC`).all(req.user.org_id);
  const withEntities = rows.map(r => ({
    ...r,
    entity: db.prepare('SELECT * FROM shuls WHERE id = ?').get(r.entity_id),
    matched: db.prepare('SELECT * FROM shuls WHERE id = ?').get(r.matched_entity_id),
  }));
  res.json({ flags: withEntities });
});

router.post('/duplicates/:flagId/resolve', requirePermission('shuls', 'can_edit'), (req, res) => {
  const { action } = req.body || {}; // 'bypass' | 'resolve'
  try {
    const flag = resolveFlag(req.params.flagId, req.user.id, action);
    if (!flag) return res.status(404).json({ error: 'Not found' });
    logAudit(req.user.org_id, req.user.id, 'resolve_duplicate', 'duplicate_flag', flag.id, null, flag, req.ip);
    res.json({ flag });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Full merge group for a flag — usually just the pair, but can chain
// further if one of them was already merged into a third shul earlier (see
// getShulMergeGroupIds) — so the compare view always shows every connected
// record, not just the two the flag itself names.
router.get('/duplicates/:flagId/group', requireAdmin, (req, res) => {
  const flag = db.prepare(`SELECT * FROM duplicate_flags WHERE id = ? AND org_id = ? AND entity_type='shul'`).get(req.params.flagId, req.user.org_id);
  if (!flag) return res.status(404).json({ error: 'Not found' });
  const ids = getShulMergeGroupIds(req.user.org_id, [flag.entity_id, flag.matched_entity_id]);
  const placeholders = ids.map(() => '?').join(',');
  const members = db.prepare(`SELECT * FROM shuls WHERE id IN (${placeholders})`).all(...ids)
    .map(s => ({ ...s, applicant_count: db.prepare(`SELECT COUNT(*) c FROM applicants WHERE shul_id = ? AND approval_status != 'incomplete'`).get(s.id).c }));
  res.json({ flag, members });
});

// Forces this flag's whole merge group to be resolved as one confirmed
// duplicate. `primaryId` picks which shul record survives going forward;
// `values` is the admin's field-by-field chosen composite. Every other
// member's applicants (in the primary's season) move onto the primary — see
// mergeShuls in services/duplicates.js for the full behavior.
router.post('/duplicates/:flagId/merge', requirePermission('shuls', 'can_edit'), (req, res) => {
  const flag = db.prepare(`SELECT * FROM duplicate_flags WHERE id = ? AND org_id = ? AND entity_type='shul'`).get(req.params.flagId, req.user.org_id);
  if (!flag) return res.status(404).json({ error: 'Not found' });
  const { primaryId, values, memberIds } = req.body || {};
  try {
    const result = mergeShuls(req.user.org_id, req.user.id, { primaryId, values, memberIds });
    logAudit(req.user.org_id, req.user.id, 'merge', 'shul', primaryId, null, result, req.ip);
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Mass upload template + import — spec #3: shuls uploaded from the back end
// should be able to receive the contract if signed up, always email when
// there's a doc to sign (handled by calling /send-contract per row, or in bulk below).
router.get('/import/template', requireAdmin, (req, res) => {
  const excluded = getTemplateExclusions('shul_application');
  const columns = SHUL_IMPORT_COLUMNS.filter(c => !excluded.has(c));
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="shul_import_template.xlsx"');
  res.send(buildXlsxTemplate(['id', ...columns]));
});

// Every column this route will write on an UPDATE row, and how to read it
// off a parsed sheet row — shared between the required-field bypass check
// and the actual UPDATE below so the two can never drift apart on which
// columns count as "filled in". Phone columns get normalized; everything
// else is used as-is. A blank cell (parseSpreadsheet's defval) means
// "leave this column alone", not "clear it" — that's the whole point of
// editing an exported sheet and re-uploading only the cells that changed.
const SHUL_UPDATABLE_FIELDS = {
  name_en: r => r.name_en, name_he: r => r.name_he, address: r => r.address, city: r => r.city, state: r => r.state, zip: r => r.zip,
  ruv_first_name: r => r.ruv_first_name, ruv_last_name: r => r.ruv_last_name, ruv_phone: r => r.ruv_phone && normalizePhone(r.ruv_phone),
  ruv_address: r => r.ruv_address, ruv_city: r => r.ruv_city, ruv_state: r => r.ruv_state, ruv_zip: r => r.ruv_zip,
  gabai_first_name: r => r.gabai_first_name, gabai_last_name: r => r.gabai_last_name, gabai_cell: r => r.gabai_cell && normalizePhone(r.gabai_cell),
  gabai_email: r => r.gabai_email, gabai_address: r => r.gabai_address, gabai_city: r => r.gabai_city, gabai_state: r => r.gabai_state, gabai_zip: r => r.gabai_zip,
};

router.post('/import', requirePermission('shuls', 'can_edit'), upload.single('file'), async (req, res) => {
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
  const sendContracts = req.body.send_contracts === 'true' || req.body.send_contracts === true;

  // A row with a non-blank `id` column that matches an existing shul in
  // this org is an edit, not a new application — same file you get from
  // Export Excel, edited in place and re-uploaded. Everything below keys
  // off this lookup: update rows skip required-field validation (they're
  // patching specific cells, not submitting a fresh application) and skip
  // creation entirely, only touching the columns that actually have a
  // value in the sheet.
  const rowExisting = rows.map(r => {
    const id = r.id ? String(r.id).trim() : '';
    if (!id) return null;
    return db.prepare('SELECT * FROM shuls WHERE id = ? AND org_id = ?').get(id, req.user.org_id) || null;
  });

  // All-or-nothing: every true-create row must have every field the fixed
  // Shul Registration question set requires, or nothing in the sheet is
  // imported — no partial imports. An admin uploading a sheet gets the
  // per-field "Admin can override" leniency the public form never does;
  // bypass_required skips this whole check for the entire sheet (e.g. a
  // backfill import where most fields genuinely aren't known) — name_en
  // and gabai_email stay hard-required per new row below regardless, since a
  // shul record is meaningless without at least those.
  const bypassRequired = req.body.bypass_required === 'true' || req.body.bypass_required === true;
  const requiredErrors = bypassRequired ? [] : rows
    .map((r, i) => (rowExisting[i] ? null : { row: i + 2, errors: validateBySchema(getEffectiveImportSchema('shul_application'), r, { isAdmin: true }) }))
    .filter(x => x && x.errors.length)
    .map(x => ({ row: x.row, error: x.errors.join('; ') }));
  // A row that named an id but it didn't match anything is a mistake worth
  // surfacing, not a silent fall-through to creating a brand new shul under
  // a random id the sheet never asked for.
  const idNotFoundErrors = rows
    .map((r, i) => (r.id && String(r.id).trim() && !rowExisting[i]) ? { row: i + 2, error: `No existing shul found with id "${r.id}"` } : null)
    .filter(Boolean);
  // Update rows skip validateBySchema entirely (see rowExisting above) — a
  // blank cell there means "leave alone," not "missing" — but a non-blank
  // phone cell still has to be a real phone number.
  const updatePhoneErrors = rows.map((r, i) => {
    if (!rowExisting[i]) return null;
    const bad = [['ruv_phone', 'Rav Phone Number'], ['gabai_cell', 'Gabai Cell Number']].find(([f]) => r[f] && !isValidPhone(r[f]));
    return bad ? { row: i + 2, error: `${bad[1]} must be a valid phone number (10 digits, or 11 digits starting with 1)` } : null;
  }).filter(Boolean);
  const allErrors = [...requiredErrors, ...idNotFoundErrors, ...updatePhoneErrors].sort((a, b) => a.row - b.row);
  if (allErrors.length) {
    return res.status(400).json({ error: 'Some rows have errors. Nothing was imported — fix the sheet and re-upload.', errors: allErrors });
  }

  let success = 0, dupes = 0, updated = 0; const errors = [];
  const createdIds = [], createdNames = [], updatedIds = [], updatedNames = [];
  // Per-row "what did this column used to say" snapshot, captured right
  // before each UPDATE — this is what makes mass-import undo (see
  // services/audit.js undoMassImportEntry) able to actually restore an
  // edited row instead of just deleting the newly-created ones.
  const updatedDiffs = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const existing = rowExisting[i];
    if (existing) {
      try {
        const sets = Object.keys(SHUL_UPDATABLE_FIELDS).filter(f => { const v = SHUL_UPDATABLE_FIELDS[f](r); return v !== undefined && v !== ''; });
        if (sets.length) {
          const vals = sets.map(f => SHUL_UPDATABLE_FIELDS[f](r));
          db.prepare(`UPDATE shuls SET ${sets.map(f => `${f}=?`).join(',')}, updated_at=datetime('now') WHERE id=?`).run(...vals, existing.id);
          updatedIds.push(existing.id); updatedNames.push(existing.name_en);
          updatedDiffs.push({ id: existing.id, before: Object.fromEntries(sets.map(f => [f, existing[f]])) });
        }
        updated++;
      } catch (e) {
        errors.push({ row: i + 2, error: e.message });
      }
      continue;
    }
    if (!r.name_en || !r.gabai_email) { errors.push({ row: i + 2, error: 'Missing name_en or gabai_email' }); continue; }
    try {
      const id = uuid();
      db.prepare(`INSERT INTO shuls (id, org_id, season_id, name_en, name_he, address, city, state, zip,
          ruv_first_name, ruv_last_name, ruv_phone, ruv_address, ruv_city, ruv_state, ruv_zip,
          gabai_first_name, gabai_last_name, gabai_cell, gabai_email, gabai_address, gabai_city, gabai_state, gabai_zip,
          status, source, shul_number)
        VALUES (?,?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?, 'submitted','mass_upload', ?)`)
        .run(id, req.user.org_id, season?.id || null, r.name_en, r.name_he || '', r.address || '', r.city || '', r.state || '', r.zip || '',
          r.ruv_first_name || '', r.ruv_last_name || '', normalizePhone(r.ruv_phone || ''), r.ruv_address || '', r.ruv_city || '', r.ruv_state || '', r.ruv_zip || '',
          r.gabai_first_name || '', r.gabai_last_name || '', normalizePhone(r.gabai_cell || ''), r.gabai_email, r.gabai_address || '', r.gabai_city || '', r.gabai_state || '', r.gabai_zip || '',
          generateShulNumber(db));
      const shul = db.prepare('SELECT * FROM shuls WHERE id = ?').get(id);
      const flag = detectAndFlag(req.user.org_id, 'shul', shul);
      createdIds.push(id); createdNames.push(shul.name_en);
      if (flag) dupes++; else success++;
      if (sendContracts && !flag) {
        const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(req.user.org_id);
        const pdfPath = await generateContractPdf({ shul, season, orgName: org.name });
        const token = uuid();
        const expires = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
        db.prepare(`INSERT INTO contracts (id, shul_id, season_id, pdf_path, status, sign_token, sign_token_expires, sent_at) VALUES (?,?,?,?,'sent',?,?,datetime('now'))`)
          .run(uuid(), shul.id, shul.season_id, pdfPath, token, expires);
        db.prepare(`UPDATE shuls SET status='contract_sent' WHERE id=?`).run(shul.id);
        const signUrl = `${process.env.APP_URL || ''}/sign-contract?token=${token}`;
        const tmpl = renderSystemTemplate(req.user.org_id, 'contractReady', { shulName: shul.name_en, signUrl });
        const { emailError } = await sendMailChecked(req.user.org_id, shul.gabai_email, tmpl.subject, tmpl.body, { replyTo: tmpl.replyTo, sentBy: req.user.id });
        if (emailError) { console.error('[mail] mass-upload contract email failed for', shul.gabai_email, emailError); errors.push({ row: i + 2, error: `Shul created but contract email failed: ${emailError}` }); }
      }
    } catch (e) {
      errors.push({ row: i + 2, error: e.message });
    }
  }
  db.prepare(`INSERT INTO import_jobs (id, org_id, entity_type, file_name, status, total_rows, success_count, error_count, duplicate_count, error_log, created_by)
    VALUES (?,?,?,?,'completed',?,?,?,?,?,?)`)
    .run(jobId, req.user.org_id, 'shuls', req.file.originalname, rows.length, success, errors.length, dupes, JSON.stringify(errors), req.user.id);
  logMassAudit(req.user.org_id, req.user.id, 'mass-import', 'shul', [...createdIds, ...updatedIds],
    { created: createdIds.length, updated: updatedIds.length, duplicates: dupes, errors: errors.length, names: [...createdNames, ...updatedNames], createdIds, updatedIds, updatedDiffs }, req.ip);
  res.json({ jobId, total: rows.length, success, updated, duplicates: dupes, errors });
});

function checkScope(req, res, shulId) {
  if (req.permission.scope !== 'assigned') return;
  const ok = db.prepare(`SELECT 1 FROM user_assignments WHERE user_id = ? AND entity_type='shul' AND entity_id = ?`).get(req.user.id, shulId);
  if (!ok) res.status(403).json({ error: 'Not assigned to you' });
}

export default router;
