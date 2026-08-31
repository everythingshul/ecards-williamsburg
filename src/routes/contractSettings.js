import { Router } from 'express';
import multer from 'multer';
import { unlinkSync, writeFileSync, readFileSync } from 'fs';
import { PDFDocument } from 'pdf-lib';
import { db } from '../db.js';
import { auth } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import { CUSTOM_TEMPLATE_PATH, hasCustomTemplate, docTemplatePath, hasCustomDocTemplate, getSignatureFields, generatePreviewPdfBytes, getDataFields, getDataFieldDefs } from '../services/pdf.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

// Everything here — the shul contract / applicant agreement / store
// agreement PDF-or-generated-text templates, signature placement, contract
// data-field placement, and the "require signing during signup" toggles —
// used to live inside the generic /settings key-value store and the
// Settings > Documents tab. Split out into its own gated resource
// ('contract_settings' in PERMISSION_RESOURCES) for the same reason as the
// Seasons/Site Content splits: it's only ever called from
// frontend/admin/document-settings.html (and app.js's shared signature-box/
// contract-field editor helpers), never a shul/store portal or public page,
// so a blanket gate here is safe and lets an admin be independently
// locked out of or made read-only on just this section.
const CONTRACT_SETTING_KEYS = ['shul_contract_at_signup', 'store_contract_at_signup', 'contract_template_text', 'document_template_text_applicant', 'document_template_text_store'];

router.use(auth, requirePermission('contract_settings'));

router.get('/', (req, res) => {
  const rows = db.prepare(`SELECT key, value FROM settings WHERE org_id = ? AND key IN (${CONTRACT_SETTING_KEYS.map(() => '?').join(',')})`)
    .all(req.user.org_id, ...CONTRACT_SETTING_KEYS);
  res.json({ settings: Object.fromEntries(rows.map(r => [r.key, r.value])) });
});

router.put('/', requirePermission('contract_settings', 'can_edit'), (req, res) => {
  const upsert = db.prepare(`INSERT INTO settings (org_id, key, value) VALUES (?,?,?)
    ON CONFLICT(org_id, key) DO UPDATE SET value = excluded.value`);
  for (const [key, value] of Object.entries(req.body || {})) {
    if (!CONTRACT_SETTING_KEYS.includes(key)) continue;
    upsert.run(req.user.org_id, key, String(value ?? ''));
  }
  res.json({ ok: true });
});

// Custom contract PDF — uploaded once, used as the base document for every
// shul's contract from then on (the shul/season details are no longer
// auto-typed onto the page; the uploaded PDF is used verbatim). A signature
// block is still stamped onto its last page at sign time.
router.get('/contract-pdf', (req, res) => {
  res.json({ hasCustomTemplate: hasCustomTemplate() });
});

router.post('/contract-pdf', requirePermission('contract_settings', 'can_edit'), upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  if (req.file.mimetype !== 'application/pdf') return res.status(400).json({ error: 'File must be a PDF' });
  writeFileSync(CUSTOM_TEMPLATE_PATH, req.file.buffer);
  res.json({ ok: true, hasCustomTemplate: true });
});

router.delete('/contract-pdf', requirePermission('contract_settings', 'can_edit'), (req, res) => {
  try { unlinkSync(CUSTOM_TEMPLATE_PATH); } catch { /* already gone */ }
  res.json({ ok: true, hasCustomTemplate: false });
});

// Custom document PDFs for applicants and stores — same idea as the shul
// contract above, generalized. entityType is 'applicant' or 'store'.
router.get('/document-pdf/:entityType', (req, res) => {
  if (!['applicant', 'store'].includes(req.params.entityType)) return res.status(400).json({ error: 'Invalid entity type' });
  res.json({ hasCustomTemplate: hasCustomDocTemplate(req.params.entityType) });
});

router.post('/document-pdf/:entityType', requirePermission('contract_settings', 'can_edit'), upload.single('file'), (req, res) => {
  const entityType = req.params.entityType;
  if (!['applicant', 'store'].includes(entityType)) return res.status(400).json({ error: 'Invalid entity type' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  if (req.file.mimetype !== 'application/pdf') return res.status(400).json({ error: 'File must be a PDF' });
  writeFileSync(docTemplatePath(entityType), req.file.buffer);
  res.json({ ok: true, hasCustomTemplate: true });
});

router.delete('/document-pdf/:entityType', requirePermission('contract_settings', 'can_edit'), (req, res) => {
  const entityType = req.params.entityType;
  if (!['applicant', 'store'].includes(entityType)) return res.status(400).json({ error: 'Invalid entity type' });
  try { unlinkSync(docTemplatePath(entityType)); } catch { /* already gone */ }
  res.json({ ok: true, hasCustomTemplate: false });
});

// Signature placement editor (Settings > Documents > drag/resize box) —
// 'kind' is 'shul' | 'applicant' | 'store'. Coordinates are stored as
// fractions (0-1) of the page's actual width/height, top-left origin,
// matching the drag UI; stampSignature() in services/pdf.js converts to PDF
// points/bottom-left-origin at sign time.
const SIG_TEMPLATE_PATH = { shul: () => (hasCustomTemplate() ? CUSTOM_TEMPLATE_PATH : null), applicant: () => (hasCustomDocTemplate('applicant') ? docTemplatePath('applicant') : null), store: () => (hasCustomDocTemplate('store') ? docTemplatePath('store') : null) };

async function templatePageSize(kind) {
  const path = SIG_TEMPLATE_PATH[kind]?.();
  if (path) {
    try {
      const doc = await PDFDocument.load(readFileSync(path));
      const pages = doc.getPages();
      const { width, height } = pages[pages.length - 1].getSize();
      return { width, height };
    } catch { /* fall through to the generated-doc default below */ }
  }
  return { width: 612, height: 792 }; // our generated Letter-size default (services/pdf.js buildSimplePdf)
}

const SIG_FIELD_TYPES = ['signature', 'initial', 'date', 'text'];

router.get('/signature-box/:kind', async (req, res) => {
  const kind = req.params.kind;
  if (!['shul', 'applicant', 'store'].includes(kind)) return res.status(400).json({ error: 'Invalid kind' });
  const fields = getSignatureFields(req.user.org_id, kind);
  const pageSize = await templatePageSize(kind);
  res.json({ fields, pageSize });
});

// Streams the actual PDF the signature-box editor renders as its
// background: the org's uploaded custom template if one exists for this
// kind, otherwise a sample of our own generated document — same
// heading/fieldLines/body layout the real thing uses, filled with
// placeholder values since there's no specific entity behind this editor.
// Either way, an admin dragging the box around is looking at the real page,
// not a blank proportioned rectangle.
router.get('/signature-box/:kind/preview-pdf', async (req, res) => {
  const kind = req.params.kind;
  if (!['shul', 'applicant', 'store'].includes(kind)) return res.status(400).json({ error: 'Invalid kind' });
  const templatePath = SIG_TEMPLATE_PATH[kind]?.();
  res.type('application/pdf');
  if (templatePath) return res.send(readFileSync(templatePath));
  const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(req.user.org_id);
  const bytes = await generatePreviewPdfBytes(req.user.org_id, org.name, kind);
  res.send(Buffer.from(bytes));
});

// Body is the full fields array (replaces whatever was saved before) — the
// admin editor always sends its whole current set, since fields can be
// added/removed/reordered in the same edit session.
router.put('/signature-box/:kind', requirePermission('contract_settings', 'can_edit'), (req, res) => {
  const kind = req.params.kind;
  if (!['shul', 'applicant', 'store'].includes(kind)) return res.status(400).json({ error: 'Invalid kind' });
  const fields = req.body?.fields;
  if (!Array.isArray(fields) || !fields.length) return res.status(400).json({ error: 'At least one field is required' });
  for (const f of fields) {
    if (!f.id || !SIG_FIELD_TYPES.includes(f.type)) return res.status(400).json({ error: 'Each field needs a valid id and type' });
    if ([f.x, f.y, f.width, f.height].some(v => typeof v !== 'number' || v < 0 || v > 1)) return res.status(400).json({ error: 'x/y/width/height must be numbers between 0 and 1' });
  }
  const value = JSON.stringify(fields.map(f => ({ id: f.id, type: f.type, label: f.label || '', required: f.required !== false, x: f.x, y: f.y, width: f.width, height: f.height,
    align: ['center', 'right'].includes(f.align) ? f.align : null })));
  db.prepare(`INSERT INTO settings (org_id, key, value) VALUES (?,?,?)
    ON CONFLICT(org_id, key) DO UPDATE SET value = excluded.value`).run(req.user.org_id, `signature_box_${kind}`, value);
  res.json({ ok: true, fields: JSON.parse(value) });
});

// Contract data-field placement editor (Settings > Documents > "Edit
// Contract Field Placement") — distinct from the signature-box editor
// above: these fields get the entity's own record data stamped onto the
// uploaded template PDF at generation time, not whatever the signer types.
// Only meaningful once a custom template is uploaded (see
// generateContractPdf/generateGenericDocumentPdf in services/pdf.js) —
// hasTemplate tells the frontend whether to even offer this editor.
router.get('/contract-fields/:kind', async (req, res) => {
  const kind = req.params.kind;
  if (!['shul', 'applicant', 'store'].includes(kind)) return res.status(400).json({ error: 'Invalid kind' });
  const fields = getDataFields(req.user.org_id, kind);
  const pageSize = await templatePageSize(kind);
  res.json({ fields, pageSize, availableFields: getDataFieldDefs(kind), hasTemplate: !!SIG_TEMPLATE_PATH[kind]?.() });
});

router.put('/contract-fields/:kind', requirePermission('contract_settings', 'can_edit'), (req, res) => {
  const kind = req.params.kind;
  if (!['shul', 'applicant', 'store'].includes(kind)) return res.status(400).json({ error: 'Invalid kind' });
  const fields = req.body?.fields;
  if (!Array.isArray(fields)) return res.status(400).json({ error: 'fields array required' });
  const validKeys = new Set(getDataFieldDefs(kind).map(([key]) => key));
  for (const f of fields) {
    if (!f.id || !validKeys.has(f.dataField)) return res.status(400).json({ error: 'Each field needs a valid id and a recognized dataField' });
    if ([f.x, f.y, f.width, f.height].some(v => typeof v !== 'number' || v < 0 || v > 1)) return res.status(400).json({ error: 'x/y/width/height must be numbers between 0 and 1' });
  }
  const value = JSON.stringify(fields.map(f => ({ id: f.id, dataField: f.dataField, x: f.x, y: f.y, width: f.width, height: f.height, fontSize: f.fontSize || null,
    align: ['center', 'right'].includes(f.align) ? f.align : null })));
  db.prepare(`INSERT INTO settings (org_id, key, value) VALUES (?,?,?)
    ON CONFLICT(org_id, key) DO UPDATE SET value = excluded.value`).run(req.user.org_id, `contract_data_fields_${kind}`, value);
  res.json({ ok: true, fields: JSON.parse(value) });
});

export default router;
