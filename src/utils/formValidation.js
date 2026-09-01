import { db, uuid, DEFAULT_ORG_ID } from '../db.js';
import { BUILTIN_SCHEMAS, applyRequiredOverrides } from './builtinSchemas.js';
import { isValidPhone } from './phone.js';

// Settings > Required Fields (Admin > Settings) stores, per built-in form
// type, which fields have been marked not-required — a single JSON blob
// under settings key 'required_field_overrides':
// { shul_application: ['ruv_phone', ...], store_application: [...], applicant_application: [...] }
// This is the one place that reads it, so every caller — the public apply
// pages (via routes/forms.js GET /builtin/:type), every validateBySchema()
// call against a built-in schema, and bulk-import validation — sees the
// same effective required-ness.
export function getEffectiveSchema(type) {
  const schema = BUILTIN_SCHEMAS[type];
  if (!schema) return null;
  const row = db.prepare(`SELECT value FROM settings WHERE org_id = ? AND key = 'required_field_overrides'`).get(DEFAULT_ORG_ID);
  let overrides = {};
  try { overrides = JSON.parse(row?.value || '{}') || {}; } catch { overrides = {}; }
  return applyRequiredOverrides(schema, overrides[type]);
}

// 'header'/'image' are presentational blocks in a form's schema, not real
// inputs — never required, never validated.
const BLOCK_TYPES = ['header', 'image'];
function realFields(schema) { return schema.filter(f => !BLOCK_TYPES.includes(f.type)); }

// Checks one submission's values against a form's schema. `isAdmin` lets a
// field marked admin_override skip both its required-ness and its number
// min/max bounds (Form Builder: "Admin can override") — a public applicant
// or shul-portal submitter never gets this leniency, only an admin filling
// something in or importing a sheet on someone's behalf. Returns an array
// of plain-English error strings; empty means everything's fine.
export function validateBySchema(schema, values, { isAdmin = false } = {}) {
  const errors = [];
  for (const f of realFields(schema)) {
    const raw = values[f.key];
    // A checkbox submits a real boolean (see app.js's fieldHtml + the
    // FormData-then-.checked-overwrite pattern every apply page uses) — an
    // unchecked box arrives as `false`, not blank/undefined. The generic
    // blank-string check below treats `false` as "present" (String(false)
    // isn't empty), so a required checkbox never actually blocked
    // submission. Required only means something for a checkbox if it means
    // "must be checked".
    const empty = f.type === 'checkbox' ? raw !== true : (raw === undefined || raw === null || String(raw).trim() === '');
    const overridable = isAdmin && f.admin_override;
    // requiredUnless: { key, equals } lets one field's required-ness depend
    // on another field's value in the same submission — e.g. the store
    // application's "manager and owner are the same person" checkbox, which
    // exempts the manager fields from being required once checked (the
    // owner fields, always required, stand in for that one person).
    const exempted = f.requiredUnless && values[f.requiredUnless.key] === f.requiredUnless.equals;
    if (f.required && !exempted && empty) {
      if (!overridable) errors.push(`Missing required field: ${f.label || f.key}`);
      continue;
    }
    if (f.type === 'number' && !empty && !overridable) {
      const n = Number(raw);
      if (Number.isNaN(n)) errors.push(`${f.label || f.key} must be a number`);
      else {
        if (f.min !== undefined && f.min !== null && f.min !== '' && n < +f.min) errors.push(`${f.label || f.key} must be at least ${f.min}`);
        if (f.max !== undefined && f.max !== null && f.max !== '' && n > +f.max) errors.push(`${f.label || f.key} must be at most ${f.max}`);
      }
    }
    // Spaces/dashes/parens are still ignored (isValidPhone strips them
    // before counting) — this only rejects a number that isn't 10 digits,
    // or 11 digits with a leading country code 1.
    if (f.type === 'tel' && !empty && !overridable && !isValidPhone(raw)) {
      errors.push(`${f.label || f.key} must be a valid phone number (10 digits, or 11 digits starting with 1)`);
    }
  }
  return errors;
}

// Whatever the fixed shul application question set would still flag as
// missing on a given shul row — shared by the public apply form's own
// validation, the admin shul-edit response, and (see routes/applicants.js)
// the gate that blocks a shul-portal user from submitting/re-enrolling any
// applicant until their own shul record is complete (#147: a shul carried
// forward into a new season with missing info must fill it in first).
export function shulInfoErrors(shul) {
  return validateBySchema(getEffectiveSchema('shul_application'), shul, { isAdmin: false });
}

// Same check across every row of a bulk-upload sheet — one combined error
// message per failing row, same shape the old validateRequiredFields
// produced (row/error pairs), so the existing all-or-nothing "nothing
// imported, fix the sheet and re-upload" flow in shuls.js/applicants.js is
// unchanged. `skipKeys` drops schema fields that aren't real sheet columns
// for this particular import (e.g. shul-portal uploads never have a shul
// column since it's forced to their own shul).
export function validateRowsBySchema(schema, rows, { isAdmin = false, rowNumberOffset = 2, skipKeys = [] } = {}) {
  const errors = [];
  const effectiveSchema = schema.filter(f => !skipKeys.includes(f.key));
  rows.forEach((row, i) => {
    const rowErrors = validateBySchema(effectiveSchema, row, { isAdmin });
    if (rowErrors.length) errors.push({ row: i + rowNumberOffset, error: rowErrors.join('; ') });
  });
  return errors;
}

// Every real DB column a shul/applicant/store form is allowed to write
// directly — anything a builder-added field's key doesn't match gets
// appended as free text instead (splitKnown below) rather than lost, since
// the DB schema itself isn't dynamic. Shared by routes/forms.js's generic
// custom-form handler and the three dedicated /apply routes (shuls.js,
// stores.js, applicants.js) alike, so a builder-added field behaves
// identically whether it's on the fixed public page or a custom form.
export const APPLICANT_FIELDS = ['first_name','last_name','marital_status','home_phone','husband_cell','wife_cell','email','address','city','state','zip','shul_id','preferred_contact_method','preferred_number','num_children','home_for_yomtov','comments'];
export const SHUL_FIELDS = ['name_en','name_he','address','city','state','zip','ruv_first_name','ruv_last_name','ruv_phone','ruv_address','ruv_city','ruv_state','ruv_zip','gabai_first_name','gabai_last_name','gabai_cell','gabai_email','gabai_address','gabai_city','gabai_state','gabai_zip'];
export const STORE_FIELDS = ['name','address','city','state','zip','phone','pos_system','manager_name','manager_phone','manager_email','owner_name','owner_phone','owner_email','comments','has_provider_account','same_person'];

// Splits submitted fields into whatever matches a known column for this
// entity type vs. everything else (appended to comments/notes so no data is
// ever lost just because the builder let someone add an arbitrary field).
export function splitKnown(schema, body, known) {
  const known_ = {}; const extra = [];
  for (const f of schema) {
    if (known.includes(f.key)) known_[f.key] = body[f.key];
    else if (body[f.key]) extra.push(`${f.label || f.key}: ${body[f.key]}`);
  }
  return { known: known_, extra: extra.join(' | ') };
}

// Logs a raw submission to the exportable response table — every form
// submission gets one of these, whether or not the form is currently the
// "default" that also creates a real shul/applicant/store row (see
// routes/forms.js and the entity-specific /apply routes). form_name/type
// are denormalized so a response stays meaningful even if the form itself
// is later edited or deleted.
export function recordFormResponse(orgId, form, data, entity = {}) {
  db.prepare(`INSERT INTO form_responses (id, org_id, form_id, form_name, form_type, data_json, entity_type, entity_id)
    VALUES (?,?,?,?,?,?,?,?)`).run(uuid(), orgId, form?.id || null, form?.name || null, form?.type || null, JSON.stringify(data || {}), entity.type || null, entity.id || null);
}
