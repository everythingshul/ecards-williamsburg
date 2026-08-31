import { Router } from 'express';
import multer from 'multer';
import { join } from 'path';
import { writeFileSync } from 'fs';
import { db, uuid, DEFAULT_ORG_ID, DATA_DIR } from '../db.js';
import { auth } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import { detectAndFlag } from '../services/duplicates.js';
import { normalizePhone } from '../utils/phone.js';
import { generateApplicantExternalId } from '../utils/externalId.js';
import { isZipAllowed } from './applicants.js';
import { formWindowError } from '../utils/formSchedule.js';
import { validateBySchema, recordFormResponse, splitKnown, APPLICANT_FIELDS, SHUL_FIELDS, STORE_FIELDS } from '../utils/formValidation.js';
import { BUILTIN_SCHEMAS } from '../utils/builtinSchemas.js';
import { sendXlsx } from '../services/xlsx.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });
const FORMS_DIR = join(DATA_DIR, 'forms');

const router = Router();

// Strips admin-only config off a schema before it ever reaches a public
// response — most importantly expectedAnswer (Form Builder: "Expected
// Answer"), which must never be visible to whoever is filling the form out
// (the whole point of the feature is that they can't see if they got it
// "right"). admin_override is stripped too since it's meaningless outside
// an admin submission context.
function sanitizeSchemaForPublic(schema) {
  return schema.map(({ expectedAnswer, admin_override, ...rest }) => rest);
}

// Public: fetch a form definition by slug to render (spec #12: form builder with
// ability to set it public, groups, or individuals). Returns the form even when
// its schedule window hasn't opened/has closed yet (as long as it's still
// active) — the caller uses windowError to show a friendly "opens on X" /
// "closed" message rather than a bare 404, since is_active alone doesn't
// tell that story.
router.get('/public/:slug', (req, res) => {
  const form = db.prepare('SELECT * FROM forms WHERE slug = ? AND is_active = 1').get(req.params.slug);
  if (!form) return res.status(404).json({ error: 'Form not found or no longer active' });
  res.json({ form: { ...form, schema_json: sanitizeSchemaForPublic(JSON.parse(form.schema_json)), target_json: JSON.parse(form.target_json || '[]') }, windowError: formWindowError(form) });
});

// Public: the fixed question set for one of the four built-in application
// flows (shul/store/applicant application — Ezras Habayis shares
// applicant_application). These used to be editable Form Builder rows
// looked up by is_current_default; that's gone (see utils/builtinSchemas.js)
// — these are just hardcoded arrays now, so there's no schedule/active
// state to report and no 404 case.
router.get('/builtin/:type', (req, res) => {
  const schema = BUILTIN_SCHEMAS[req.params.type];
  if (!schema) return res.status(404).json({ error: 'Unknown built-in form type' });
  res.json({ schema });
});

// Public: generic submission handler for custom forms built in the form
// builder — one of applicant_application, shul_application, or
// store_application. Each branch mirrors the equivalent purpose-built public
// endpoint (applicants.js POST /, shuls.js POST /apply, stores.js POST
// /apply) so a custom-built form behaves the same as the hand-built one once
// submitted, just with whatever field set the builder configured.
router.post('/public/:slug/submit', (req, res) => {
  const form = db.prepare('SELECT * FROM forms WHERE slug = ? AND is_active = 1').get(req.params.slug);
  if (!form) return res.status(404).json({ error: 'Form not found or no longer active' });
  const windowError = formWindowError(form);
  if (windowError) return res.status(423).json({ error: windowError });
  const schema = JSON.parse(form.schema_json);
  const b = req.body || {};
  const errors = validateBySchema(schema, b, { isAdmin: false });
  if (errors.length) return res.status(400).json({ error: errors[0] });

  if (form.type === 'applicant_application') {
    const { known: applicant, extra } = splitKnown(schema, b, APPLICANT_FIELDS);
    if (!applicant.first_name || !applicant.last_name || !applicant.shul_id) return res.status(400).json({ error: 'Form must include first_name, last_name, and shul_id fields' });
    const shul = db.prepare('SELECT * FROM shuls WHERE id = ? AND org_id = ?').get(applicant.shul_id, form.org_id);
    if (!shul) return res.status(400).json({ error: 'Invalid shul selection' });
    if (shul.is_paused) return res.status(423).json({ error: 'This shul is currently paused' });
    const id = uuid();
    const initialStatus = isZipAllowed(form.org_id, applicant.zip) ? 'pending' : 'rejected';
    const comments = [applicant.comments, extra].filter(Boolean).join(' | ');
    db.prepare(`INSERT INTO applicants (id, org_id, shul_id, season_id, external_id, first_name, last_name, marital_status, home_phone, husband_cell, wife_cell, email,
        address, city, state, zip, preferred_contact_method, preferred_number, num_children, home_for_yomtov, comments, source, approval_status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?,?, 'public_form', ?)`)
      .run(id, form.org_id, shul.id, shul.season_id, generateApplicantExternalId(db), applicant.first_name, applicant.last_name, applicant.marital_status || '',
        applicant.home_phone || '', applicant.husband_cell || '', applicant.wife_cell || '', applicant.email || '',
        applicant.address || '', applicant.city || '', applicant.state || '', applicant.zip || '',
        applicant.preferred_contact_method || '', applicant.preferred_number || '', +applicant.num_children || 0,
        applicant.home_for_yomtov ? 1 : 0, comments, initialStatus);
    recordFormResponse(form.org_id, form, b, { type: 'applicant', id });
    return res.status(201).json({ ok: true, id });
  }

  if (form.type === 'shul_application') {
    const { known: shul, extra } = splitKnown(schema, b, SHUL_FIELDS);
    for (const f of ['name_en', 'address', 'city', 'state', 'zip', 'ruv_first_name', 'ruv_last_name', 'ruv_phone', 'gabai_first_name', 'gabai_last_name', 'gabai_cell', 'gabai_email']) {
      if (!shul[f]) return res.status(400).json({ error: `Missing required field: ${f}` });
    }
    // The form's own pinned season, not whichever season is "active" right
    // now — a link someone already has open shouldn't silently start
    // landing in a different season if the active one changes underneath it.
    const id = uuid();
    db.prepare(`INSERT INTO shuls (id, org_id, season_id, name_en, name_he, address, city, state, zip,
        ruv_first_name, ruv_last_name, ruv_phone, gabai_first_name, gabai_last_name, gabai_cell, gabai_email, status, source)
      VALUES (?,?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?, 'submitted', 'form')`)
      .run(id, form.org_id, form.season_id, shul.name_en, shul.name_he || '', shul.address, shul.city, shul.state, shul.zip,
        shul.ruv_first_name, shul.ruv_last_name, normalizePhone(shul.ruv_phone), shul.gabai_first_name, shul.gabai_last_name, normalizePhone(shul.gabai_cell), shul.gabai_email);
    const created = db.prepare('SELECT * FROM shuls WHERE id = ?').get(id);
    if (extra) db.prepare('INSERT INTO shul_notes (id, shul_id, note) VALUES (?,?,?)').run(uuid(), id, extra);
    const flag = detectAndFlag(form.org_id, 'shul', created);
    recordFormResponse(form.org_id, form, b, { type: 'shul', id });
    return res.status(201).json({ ok: true, id, duplicate: !!flag });
  }

  if (form.type === 'store_application') {
    const { known: store, extra } = splitKnown(schema, b, STORE_FIELDS);
    if (!store.name || !store.owner_email) return res.status(400).json({ error: 'Form must include name and owner_email fields' });
    const id = uuid();
    const comments = [store.comments, extra].filter(Boolean).join(' | ');
    db.prepare(`INSERT INTO stores (id, org_id, name, address, city, state, zip, phone, manager_name, manager_phone, manager_email,
        owner_name, owner_phone, owner_email, comments, setup_status, has_provider_account, source)
      VALUES (?,?,?,?,?,?,?,?,?,?,?, ?,?,?,?,'pending',?, 'application')`)
      .run(id, form.org_id, store.name, store.address || '', store.city || '', store.state || '', store.zip || '', normalizePhone(store.phone || ''),
        store.manager_name || '', normalizePhone(store.manager_phone || ''), store.manager_email || '', store.owner_name || '', normalizePhone(store.owner_phone || ''), store.owner_email, comments, store.has_provider_account ? 1 : 0);
    recordFormResponse(form.org_id, form, b, { type: 'store', id });
    return res.status(201).json({ ok: true, id });
  }

  // Every other form (the only kind an admin can still build — see POST /
  // below; #9: custom forms are no longer categorized as one of the three
  // fixed application types, which now live at permanent hardcoded URLs
  // instead) is a general form: it just records the response, with no
  // shul/store/applicant record created from it.
  recordFormResponse(form.org_id, form, b, {});
  res.status(201).json({ ok: true });
});

router.use(auth, requirePermission('forms'));

// Uploads an image for an 'image' block in a form's schema (see
// frontend/admin/forms.html's field editor) — returns the URL to store on
// that field. Same memory-storage-then-write-to-disk pattern as
// routes/updates.js's inline-image attachments.
router.post('/upload-image', requirePermission('forms', 'can_edit'), upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
  if (!req.file.mimetype.startsWith('image/')) return res.status(400).json({ error: 'File must be an image' });
  const safeName = `${uuid()}-${req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  writeFileSync(join(FORMS_DIR, safeName), req.file.buffer);
  res.json({ url: `/uploads/forms/${safeName}` });
});

router.get('/', (req, res) => {
  const forms = db.prepare('SELECT * FROM forms WHERE org_id = ? ORDER BY created_at DESC').all(req.user.org_id);
  res.json({ forms: forms.map(f => ({ ...f, schema_json: JSON.parse(f.schema_json), target_json: JSON.parse(f.target_json || '[]') })) });
});

// #9: a form built here is never one of the three fixed application types
// again (shul/store/applicant application now live at permanent hardcoded
// URLs, not as rows in this table — see utils/builtinSchemas.js and the
// Built-In Application Forms links on the admin Forms page) — every form
// created through this route is just a general form, type is not even
// accepted from the client.
router.post('/', requirePermission('forms', 'can_edit'), (req, res) => {
  const { name, visibility = 'public', slug, schema, target = [], season_id } = req.body || {};
  if (!name || !slug) return res.status(400).json({ error: 'name and slug are required' });
  if (!season_id) return res.status(400).json({ error: 'Every form must be linked to a season' });
  if (!db.prepare('SELECT 1 FROM seasons WHERE id = ? AND org_id = ?').get(season_id, req.user.org_id)) return res.status(400).json({ error: 'Season not found' });
  if (db.prepare('SELECT 1 FROM forms WHERE slug = ?').get(slug)) return res.status(409).json({ error: 'That slug is already in use' });
  const id = uuid();
  db.prepare(`INSERT INTO forms (id, org_id, name, type, visibility, slug, schema_json, target_json, season_id, is_active)
    VALUES (?,?,?,'general',?,?,?,?,?,1)`).run(id, req.user.org_id, name, visibility, slug, JSON.stringify(schema || []), JSON.stringify(target), season_id);
  res.status(201).json({ form: db.prepare('SELECT * FROM forms WHERE id = ?').get(id) });
});

router.put('/:id', requirePermission('forms', 'can_edit'), (req, res) => {
  const form = db.prepare('SELECT * FROM forms WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!form) return res.status(404).json({ error: 'Not found' });
  const { name, visibility, schema, target, is_active, opens_at, closes_at, season_id, slug } = req.body || {};
  if (season_id !== undefined) {
    if (!season_id) return res.status(400).json({ error: 'Every form must be linked to a season' });
    if (!db.prepare('SELECT 1 FROM seasons WHERE id = ? AND org_id = ?').get(season_id, req.user.org_id)) return res.status(400).json({ error: 'Season not found' });
  }
  if (slug !== undefined) {
    if (!slug) return res.status(400).json({ error: 'URL Slug is required' });
    const conflict = db.prepare('SELECT 1 FROM forms WHERE slug = ? AND id != ?').get(slug, form.id);
    if (conflict) return res.status(409).json({ error: 'That slug is already in use' });
  }
  // opens_at/closes_at: undefined leaves it as-is; explicit null/'' clears
  // the date (open-ended) — same pattern as seasons.js's max_accepted_applicants.
  const opensAt = opens_at === undefined ? undefined : (opens_at || null);
  const closesAt = closes_at === undefined ? undefined : (closes_at || null);
  db.prepare(`UPDATE forms SET name=COALESCE(?,name), visibility=COALESCE(?,visibility), slug=COALESCE(?,slug),
    schema_json=COALESCE(?,schema_json), target_json=COALESCE(?,target_json), is_active=COALESCE(?,is_active), season_id=COALESCE(?,season_id),
    opens_at=CASE WHEN ? THEN ? ELSE opens_at END, closes_at=CASE WHEN ? THEN ? ELSE closes_at END, updated_at=datetime('now') WHERE id=?`)
    .run(name, visibility, slug, schema ? JSON.stringify(schema) : null, target ? JSON.stringify(target) : null, is_active === undefined ? undefined : (is_active ? 1 : 0), season_id || null,
      opensAt !== undefined ? 1 : 0, opensAt, closesAt !== undefined ? 1 : 0, closesAt, form.id);
  res.json({ form: db.prepare('SELECT * FROM forms WHERE id = ?').get(form.id) });
});

router.delete('/:id', requirePermission('forms', 'can_edit'), (req, res) => {
  const form = db.prepare('SELECT * FROM forms WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!form) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE forms SET is_active = 0 WHERE id = ?').run(form.id);
  res.json({ ok: true });
});

// Every submission to this form, raw — including ones that also created a
// real shul/applicant/store row (see recordFormResponse() calls above and
// in shuls.js/stores.js/applicants.js's dedicated /apply routes). This is
// the exportable "response table" independent of whatever entity a
// submission may or may not have created.
router.get('/:id/responses', (req, res) => {
  const form = db.prepare('SELECT * FROM forms WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!form) return res.status(404).json({ error: 'Not found' });
  const rows = db.prepare('SELECT * FROM form_responses WHERE form_id = ? ORDER BY created_at DESC').all(form.id);
  res.json({ responses: rows.map(r => ({ ...r, data: JSON.parse(r.data_json || '{}') })) });
});

router.get('/:id/responses/export', requirePermission('forms', 'can_export'), (req, res) => {
  const form = db.prepare('SELECT * FROM forms WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!form) return res.status(404).json({ error: 'Not found' });
  const rows = db.prepare('SELECT * FROM form_responses WHERE form_id = ? ORDER BY created_at DESC').all(form.id);
  const schema = JSON.parse(form.schema_json || '[]').filter(f => !['header', 'image'].includes(f.type));
  const columns = ['created_at', 'entity_type', 'entity_id', ...schema.map(f => f.key)];
  const flat = rows.map(r => {
    const data = JSON.parse(r.data_json || '{}');
    const out = { created_at: r.created_at, entity_type: r.entity_type || '', entity_id: r.entity_id || '' };
    for (const f of schema) out[f.key] = data[f.key] ?? '';
    return out;
  });
  sendXlsx(res, `${form.slug || 'form'}-responses-${Date.now()}.xlsx`, flat, columns);
});

// Deletes one raw response row from the response table (e.g. a test
// submission, spam, or a duplicate) — this only removes the logged
// response, never the real shul/applicant/store record a submission may
// have also created (entity_type/entity_id, if set, are just left as they
// were; delete that record from its own list page instead).
router.delete('/:id/responses/:responseId', requirePermission('forms', 'can_edit'), (req, res) => {
  const form = db.prepare('SELECT * FROM forms WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!form) return res.status(404).json({ error: 'Not found' });
  const response = db.prepare('SELECT * FROM form_responses WHERE id = ? AND form_id = ?').get(req.params.responseId, form.id);
  if (!response) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM form_responses WHERE id = ?').run(response.id);
  res.json({ ok: true });
});

export default router;
