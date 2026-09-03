import xlsx from 'xlsx';

// Parses an uploaded CSV or XLSX buffer into an array of plain row objects
// keyed by the header row. Used for shul mass-upload, applicant mass-upload,
// and shul-portal CSV/XLS applicant submission.
export function parseSpreadsheet(buffer, filename = '') {
  const wb = xlsx.read(buffer, { type: 'buffer' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  return xlsx.utils.sheet_to_json(sheet, { defval: '', raw: false });
}

// Downloadable blank import template — xlsx, not CSV, since CSV doesn't
// reliably round-trip Hebrew text (shul/applicant names) on re-upload.
export function buildXlsxTemplate(columns) {
  const wb = xlsx.utils.book_new();
  const sheet = xlsx.utils.aoa_to_sheet([columns]);
  xlsx.utils.book_append_sheet(wb, sheet, 'Sheet1');
  return xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

export const SHUL_IMPORT_COLUMNS = [
  'name_en', 'name_he', 'address', 'city', 'state', 'zip',
  'ruv_first_name', 'ruv_last_name', 'ruv_phone', 'ruv_address', 'ruv_city', 'ruv_state', 'ruv_zip',
  'gabai_first_name', 'gabai_last_name', 'gabai_cell', 'gabai_email', 'gabai_address', 'gabai_city', 'gabai_state', 'gabai_zip',
  'slots_allocated',
];

export const STORE_IMPORT_COLUMNS = [
  'name', 'address', 'city', 'state', 'zip', 'phone', 'pos_system', 'discount_details',
  'manager_name', 'manager_phone', 'manager_email', 'owner_name', 'owner_phone', 'owner_email', 'comments',
];

export const APPLICANT_IMPORT_COLUMNS = [
  'first_name', 'last_name', 'marital_status', 'home_phone', 'husband_cell', 'wife_cell', 'email',
  'address', 'city', 'state', 'zip', 'shul_id',
  'preferred_number', 'num_children', 'home_for_yomtov', 'card_amount', 'comments',
];
