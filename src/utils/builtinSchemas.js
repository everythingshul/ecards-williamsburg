// The fixed question sets for the four built-in application flows (shul
// registration, store application, Ezras Habayis / regular applicant
// application, and — sharing the same schema — a shul-portal applicant
// add/re-enrollment). These used to live as editable rows in the `forms`
// table (Form Builder), auto-seeded on every boot. That's been removed:
// these pages and their admin-side validation/bulk-upload counterparts now
// read directly from these hardcoded arrays instead. Form Builder itself
// still exists for building genuinely new, separate custom forms (their own
// slug, their own /forms/public/:slug/submit) — it just no longer drives
// these four flows. Field content mirrors exactly what was live in the
// forms table at the time this was written (same fields, same
// required/optional split) — a deliberate mechanism change, not a
// behavior change.
export const SHUL_APPLICATION_SCHEMA = [
  { key: 'name_en', label: 'Shul Name (English)', type: 'text', required: true },
  { key: 'name_he', label: 'Shul Name (Hebrew)', type: 'text', required: false },
  { key: 'address', label: 'Shul Address', type: 'text', required: true },
  { key: 'city', label: 'City', type: 'text', required: true }, { key: 'state', label: 'State', type: 'text', required: true }, { key: 'zip', label: 'Zip', type: 'text', required: true },
  { key: 'ruv_first_name', label: 'Rav First Name', type: 'text', required: true }, { key: 'ruv_last_name', label: 'Rav Last Name', type: 'text', required: true },
  { key: 'ruv_phone', label: 'Rav Phone Number', type: 'tel', required: true },
  { key: 'ruv_address', label: 'Rav Address', type: 'text', required: true }, { key: 'ruv_city', label: 'Rav City', type: 'text', required: true },
  { key: 'ruv_state', label: 'Rav State', type: 'text', required: true }, { key: 'ruv_zip', label: 'Rav Zip', type: 'text', required: true },
  { key: 'gabai_first_name', label: 'Gabai First Name', type: 'text', required: true }, { key: 'gabai_last_name', label: 'Gabai Last Name', type: 'text', required: true },
  { key: 'gabai_cell', label: 'Gabai Cell Number', type: 'tel', required: true }, { key: 'gabai_email', label: 'Gabai Email', type: 'email', required: true },
  { key: 'gabai_address', label: 'Gabai Address', type: 'text', required: true }, { key: 'gabai_city', label: 'Gabai City', type: 'text', required: true },
  { key: 'gabai_state', label: 'Gabai State', type: 'text', required: true }, { key: 'gabai_zip', label: 'Gabai Zip', type: 'text', required: true },
];
export const STORE_APPLICATION_SCHEMA = [
  { key: 'name', label: 'Store Name', type: 'text', required: true },
  { key: 'address', label: 'Address', type: 'text', required: true }, { key: 'city', label: 'City', type: 'text', required: false },
  { key: 'state', label: 'State', type: 'text', required: false }, { key: 'zip', label: 'Zip', type: 'text', required: false },
  { key: 'phone', label: 'Store Phone', type: 'tel', required: true },
  { key: 'pos_system', label: 'Which POS system do you have?', type: 'text', required: true },
  { key: 'discount_details', label: 'Discount Details', type: 'textarea', required: true },
  { key: 'same_person', label: 'The manager and owner are the same person', type: 'checkbox', required: false },
  // Owner fields are always required — they double as "the one person"'s
  // info when same_person is checked. Manager fields are required too,
  // except when same_person is checked (requiredUnless — see
  // formValidation.js's validateBySchema), since they'd otherwise duplicate
  // the owner fields exactly.
  { key: 'manager_name', label: 'Manager Name', type: 'text', required: true, requiredUnless: { key: 'same_person', equals: true } },
  { key: 'manager_phone', label: 'Manager Phone', type: 'tel', required: true, requiredUnless: { key: 'same_person', equals: true } },
  { key: 'manager_email', label: 'Manager Email', type: 'email', required: true, requiredUnless: { key: 'same_person', equals: true } },
  { key: 'owner_name', label: 'Owner Name', type: 'text', required: true }, { key: 'owner_phone', label: 'Owner Phone', type: 'tel', required: true },
  { key: 'owner_email', label: 'Owner Email', type: 'email', required: true },
  { key: 'has_provider_account', label: 'We already have a disccardpromos.com account', type: 'checkbox', required: false },
  { key: 'comments', label: 'Comments', type: 'textarea', required: false },
];
export const APPLICANT_APPLICATION_SCHEMA = [
  { key: 'first_name', label: 'First Name', type: 'text', required: true }, { key: 'last_name', label: 'Last Name', type: 'text', required: true },
  { key: 'marital_status', label: 'Marital Status', type: 'select', required: false, options: [
    { value: 'single', label: 'Single' }, { value: 'married', label: 'Married' }, { value: 'widowed', label: 'Widowed' }, { value: 'divorced', label: 'Divorced' } ] },
  { key: 'home_phone', label: 'Home Phone', type: 'tel', required: false }, { key: 'email', label: 'Email', type: 'email', required: false },
  { key: 'husband_cell', label: 'Husband Cell', type: 'tel', required: true }, { key: 'wife_cell', label: 'Wife Cell', type: 'tel', required: false },
  { key: 'preferred_contact_method', label: 'Preferred Contact Method', type: 'select', required: false, options: [
    { value: 'phone', label: 'Phone' }, { value: 'text', label: 'Text' }, { value: 'email', label: 'Email' } ] },
  { key: 'preferred_number', label: 'Number To Use', type: 'select', required: false, options: [
    { value: 'home', label: 'Home' }, { value: 'husband', label: 'Husband' }, { value: 'wife', label: 'Wife' } ] },
  { key: 'address', label: 'Address', type: 'text', required: true }, { key: 'city', label: 'City', type: 'text', required: true },
  { key: 'state', label: 'State', type: 'text', required: true }, { key: 'zip', label: 'Zip', type: 'text', required: true },
  { key: 'num_children', label: 'Number of Children', type: 'number', required: false, min: 0 },
  { key: 'home_for_yomtov', label: 'Home for Yom Tov', type: 'select', required: false, options: [ { value: '1', label: 'Yes' }, { value: '0', label: 'No' } ] },
  { key: 'comments', label: 'Comments', type: 'textarea', required: false },
];

export const BUILTIN_SCHEMAS = {
  shul_application: SHUL_APPLICATION_SCHEMA,
  store_application: STORE_APPLICATION_SCHEMA,
  applicant_application: APPLICANT_APPLICATION_SCHEMA,
};

// Settings > Required Fields lets the admin mark specific built-in fields as
// not required, without removing them from the form — disabledKeys is that
// per-form-type list of field keys to force to required:false. Deliberately
// one-directional (only ever relaxes a field, never makes an optional one
// required) since a field's type/validation (email format, phone format,
// requiredUnless) was authored assuming the field it's attached to behaves
// as designed; only required-ness is meant to be admin-configurable here.
export function applyRequiredOverrides(schema, disabledKeys) {
  if (!disabledKeys || !disabledKeys.length) return schema;
  const disabled = new Set(disabledKeys);
  return schema.map(f => (disabled.has(f.key) ? { ...f, required: false } : f));
}
