import Database from 'better-sqlite3';
import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { randomUUID } from 'crypto';
import bcrypt from 'bcryptjs';
import { normalizePhone } from './utils/phone.js';
import { generateApplicantExternalId } from './utils/externalId.js';

export const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), 'data');
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
for (const sub of ['contracts', 'uploads', 'signatures', 'logos', 'updates', 'forms', 'store-bills', 'homepage']) {
  const p = join(DATA_DIR, sub);
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

export const db = new Database(join(DATA_DIR, 'ecards.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Never destructive — every migration is CREATE IF NOT EXISTS or a guarded ALTER TABLE.
db.exec(`
-- ===================== Core tenancy =====================
CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  subdomain TEXT UNIQUE,          -- e.g. "shul" -> shul.everythingshul.com (this deploy = ecards.everythingshul.com)
  custom_domain TEXT UNIQUE,      -- org connects their own domain
  logo_url TEXT,
  primary_color TEXT DEFAULT '#2b1f1a',
  accent_color TEXT DEFAULT '#c9a76a',
  support_email TEXT,
  support_phone TEXT,
  address TEXT,
  is_active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS seasons (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,               -- e.g. "5786 / 2025-26"
  start_date TEXT,
  end_date TEXT,
  is_active INTEGER DEFAULT 1,
  default_card_amount REAL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Single-org platform: one Brevo account, one disccardpromos account for the
-- whole system (see services/mail.js and services/giftcard.js). No per-org
-- credential tables — that was tried and explicitly reverted.

-- ===================== Users / RBAC =====================
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  org_id TEXT REFERENCES organizations(id),
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  first_name TEXT,
  last_name TEXT,
  role TEXT NOT NULL DEFAULT 'staff', -- super_admin | org_admin | staff | shul | store
  shul_id TEXT,                        -- set when role = shul (portal login)
  store_id TEXT,                       -- set when role = store (portal login)
  is_active INTEGER DEFAULT 1,
  is_paused INTEGER DEFAULT 0,         -- frozen due to duplicate-hold on linked shul/applicant
  token_version INTEGER DEFAULT 0,
  invite_token TEXT,
  invite_expires TEXT,
  last_login_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Field-level + page-level permission grants. A user with no rows for a resource
-- falls back to role defaults (see middleware/permissions.js).
CREATE TABLE IF NOT EXISTS permissions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  resource TEXT NOT NULL,      -- 'shuls' | 'applicants' | 'cards' | 'stores' | 'forms' | 'users' | 'settings' | 'dashboard'
  can_view INTEGER DEFAULT 1,
  can_edit INTEGER DEFAULT 0,
  can_export INTEGER DEFAULT 0,
  hidden_fields TEXT DEFAULT '[]',   -- JSON array of field keys hidden from this user (e.g. ["first_name","last_name"])
  scope TEXT DEFAULT 'all',          -- 'all' | 'assigned' (only shuls/applicants explicitly assigned)
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(user_id, resource)
);

CREATE TABLE IF NOT EXISTS user_assignments ( -- for scope='assigned'
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  entity_type TEXT NOT NULL, -- 'shul' | 'store'
  entity_id TEXT NOT NULL
);

-- ===================== Shuls =====================
CREATE TABLE IF NOT EXISTS shuls (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  season_id TEXT REFERENCES seasons(id),
  name_en TEXT NOT NULL,
  name_he TEXT,
  address TEXT, city TEXT, state TEXT, zip TEXT, lat REAL, lng REAL, place_id TEXT,
  ruv_first_name TEXT, ruv_last_name TEXT, ruv_phone TEXT,
  ruv_address TEXT, ruv_city TEXT, ruv_state TEXT, ruv_zip TEXT, ruv_place_id TEXT,
  gabai_first_name TEXT, gabai_last_name TEXT, gabai_cell TEXT, gabai_email TEXT,
  gabai_address TEXT, gabai_city TEXT, gabai_state TEXT, gabai_zip TEXT, gabai_place_id TEXT,
  status TEXT NOT NULL DEFAULT 'submitted', -- submitted | contract_sent | contract_signed | approved | rejected
  slots_allocated INTEGER DEFAULT 0,
  is_paused INTEGER DEFAULT 0,       -- duplicate hold freeze
  duplicate_of_shul_id TEXT REFERENCES shuls(id),
  duplicate_status TEXT,             -- NULL | 'flagged' | 'bypassed' | 'resolved'
  portal_user_id TEXT REFERENCES users(id),
  source TEXT DEFAULT 'form',        -- form | mass_upload | admin
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS shul_notes (
  id TEXT PRIMARY KEY,
  shul_id TEXT NOT NULL REFERENCES shuls(id),
  user_id TEXT REFERENCES users(id),
  note TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS season_notes (
  id TEXT PRIMARY KEY,
  season_id TEXT NOT NULL REFERENCES seasons(id),
  user_id TEXT REFERENCES users(id),
  note TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS contracts (
  id TEXT PRIMARY KEY,
  shul_id TEXT NOT NULL REFERENCES shuls(id),
  season_id TEXT REFERENCES seasons(id),
  template_id TEXT,
  pdf_path TEXT,               -- unsigned generated PDF
  signed_pdf_path TEXT,        -- final PDF w/ signature stamped
  signature_data TEXT,         -- base64 PNG of signature or typed name
  signer_name TEXT,
  signer_title TEXT,
  signed_at TEXT,
  ip_address TEXT,
  status TEXT DEFAULT 'pending', -- pending | sent | signed | void
  sign_token TEXT UNIQUE,
  sign_token_expires TEXT,
  sent_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Generic e-signable documents for applicants and stores (shuls keep using
-- the 'contracts' table above -- that flow is older, well-tested, and left
-- alone; this table is the same idea generalized to the other two entity
-- types so "customize docs for applicants/shuls/stores" covers all three).
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  entity_type TEXT NOT NULL,   -- applicant | store
  entity_id TEXT NOT NULL,
  title TEXT DEFAULT 'Agreement',
  pdf_path TEXT,
  signed_pdf_path TEXT,
  signature_data TEXT,
  signer_name TEXT,
  signer_title TEXT,
  signed_at TEXT,
  ip_address TEXT,
  status TEXT DEFAULT 'pending', -- pending | sent | signed | void
  sign_token TEXT UNIQUE,
  sign_token_expires TEXT,
  sent_at TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_documents_entity ON documents(entity_type, entity_id);

-- ===================== Email Center =====================
-- Every email this platform sends (system notifications and admin-composed
-- ones alike) is logged here so admins have somewhere to actually see what
-- went out, whether it really sent, and why it didn't when it failed.
CREATE TABLE IF NOT EXISTS emails_sent (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  to_email TEXT NOT NULL,
  subject TEXT,
  body_html TEXT,
  status TEXT NOT NULL,          -- sent | failed | dry_run
  error_message TEXT,
  related_entity_type TEXT,      -- shul | applicant | store | task | user | null (admin-composed)
  related_entity_id TEXT,
  sent_by TEXT REFERENCES users(id), -- null for automatic system emails
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_emails_sent_org ON emails_sent(org_id, created_at);

-- Per-user account preferences (e.g. which list columns to show and in what
-- order) — follows the admin across devices/browsers, unlike localStorage.
CREATE TABLE IF NOT EXISTS user_preferences (
  user_id TEXT NOT NULL REFERENCES users(id),
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, key)
);

-- Admin overrides for system-triggered emails (services/mail.js's
-- SYSTEM_EMAIL_TEMPLATES). A missing row for a given key means "use the
-- built-in default" — this table only ever holds the customized ones.
CREATE TABLE IF NOT EXISTS system_email_templates (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  key TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(org_id, key)
);

-- Reusable subject/body templates for the admin-composed "Email Builder"
-- (Email Center > Templates). Body supports {{variable}} placeholders,
-- substituted at send time.
CREATE TABLE IF NOT EXISTS email_templates (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  category TEXT,
  subject TEXT NOT NULL,
  body_html TEXT NOT NULL,
  created_by TEXT REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_email_templates_org ON email_templates(org_id);

-- ===================== SMS Center =====================
-- Every SMS this platform sends or receives, provider-agnostic — see
-- services/sms.js (mirrors the disccardpromos mock-mode pattern: runs in
-- mock mode, logging only, until SMS_API_BASE/SMS_API_KEY are set).
CREATE TABLE IF NOT EXISTS sms_messages (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  direction TEXT NOT NULL,       -- outbound | inbound
  phone TEXT NOT NULL,
  body TEXT,
  status TEXT NOT NULL,          -- sent | failed | mock | received
  error_message TEXT,
  related_entity_type TEXT,
  related_entity_id TEXT,
  season_id TEXT REFERENCES seasons(id), -- resolved from the related/matched shul or applicant; NULL for store/staff/unmatched messages (see services/sms.js)
  sent_by TEXT REFERENCES users(id), -- null for inbound or automatic sends
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sms_messages_org ON sms_messages(org_id, created_at);

-- Reusable SMS body templates, same idea as email_templates.
CREATE TABLE IF NOT EXISTS sms_templates (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  category TEXT,
  body TEXT NOT NULL,
  created_by TEXT REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sms_templates_org ON sms_templates(org_id);

-- ===================== Updates =====================
-- Admin-broadcast updates to specific shuls/stores or whole groups — the
-- shul/store portal "Updates" section (formerly just a contract-status
-- viewer). Every recipient gets an email and a portal notification.
CREATE TABLE IF NOT EXISTS updates (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  attachments_json TEXT DEFAULT '[]', -- [{filename, path, mime_type}]
  created_by TEXT REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_updates_org ON updates(org_id);

CREATE TABLE IF NOT EXISTS update_recipients (
  id TEXT PRIMARY KEY,
  update_id TEXT NOT NULL REFERENCES updates(id),
  entity_type TEXT NOT NULL, -- shul | store
  entity_id TEXT NOT NULL,
  email_status TEXT,         -- sent | failed | dry_run
  email_error TEXT,
  read_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_update_recipients_update ON update_recipients(update_id);
CREATE INDEX IF NOT EXISTS idx_update_recipients_entity ON update_recipients(entity_type, entity_id);

-- ===================== Applicants =====================
CREATE TABLE IF NOT EXISTS applicants (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  shul_id TEXT REFERENCES shuls(id),
  season_id TEXT REFERENCES seasons(id),
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  marital_status TEXT,            -- single | married | widowed | divorced
  home_phone TEXT, husband_cell TEXT, wife_cell TEXT, email TEXT,
  address TEXT, city TEXT, state TEXT, zip TEXT, place_id TEXT,
  preferred_contact_method TEXT,  -- phone | text | email
  preferred_number TEXT,          -- home | husband | wife (when method is phone/text)
  num_children INTEGER DEFAULT 0,
  home_for_yomtov INTEGER,        -- 0/1
  approval_status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
  approved_by TEXT REFERENCES users(id),
  approved_at TEXT,
  card_amount REAL,
  comments TEXT,
  is_paused INTEGER DEFAULT 0,
  duplicate_of_applicant_id TEXT REFERENCES applicants(id),
  duplicate_status TEXT,
  source TEXT DEFAULT 'shul_upload', -- shul_upload | mass_upload | admin | public_form
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS applicant_notes (
  id TEXT PRIMARY KEY,
  applicant_id TEXT NOT NULL REFERENCES applicants(id),
  user_id TEXT REFERENCES users(id),
  note TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

-- ===================== Cards / gift card provider (disccardpromos.com) =====================
CREATE TABLE IF NOT EXISTS cards (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  applicant_id TEXT REFERENCES applicants(id),
  season_id TEXT REFERENCES seasons(id),
  card_number_masked TEXT,     -- last 4 only, ever displayed
  provider_card_id TEXT,       -- disccardpromos internal id/token
  status TEXT NOT NULL DEFAULT 'unassigned', -- unassigned | assigned | activated | deactivated | lost
  amount REAL DEFAULT 0,
  activation_phone TEXT,       -- phone used to activate, written to account
  activated_at TEXT,
  assigned_at TEXT,
  deactivated_at TEXT,
  last_synced_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS card_transactions (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES cards(id),
  provider_txn_id TEXT UNIQUE,
  type TEXT NOT NULL,          -- activation | purchase | refund | load | adjustment
  amount REAL NOT NULL,
  balance_after REAL,
  store_name TEXT,
  store_id TEXT REFERENCES stores(id),
  occurred_at TEXT,
  raw_payload TEXT,            -- full JSON response from provider, kept for audit
  created_at TEXT DEFAULT (datetime('now'))
);

-- ===================== Stores =====================
CREATE TABLE IF NOT EXISTS stores (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  season_id TEXT REFERENCES seasons(id), -- stores are season-scoped like shuls; see Carry Forward
  name TEXT NOT NULL,
  address TEXT, city TEXT, state TEXT, zip TEXT, place_id TEXT,
  phone TEXT,
  manager_name TEXT, manager_phone TEXT, manager_email TEXT,
  owner_name TEXT, owner_phone TEXT, owner_email TEXT,
  same_person INTEGER DEFAULT 0,      -- manager and owner are the same person (see builtinSchemas.js)
  pos_system TEXT,                    -- "Which POS system do you have?" (see builtinSchemas.js)
  comments TEXT,
  setup_status TEXT DEFAULT 'pending', -- pending | in_progress | active | inactive
  has_provider_account INTEGER DEFAULT 0, -- already had a disccardpromos account
  provider_store_id TEXT,
  portal_user_id TEXT REFERENCES users(id),
  source TEXT DEFAULT 'admin',        -- admin | application (self-submitted)
  onboarding_step INTEGER DEFAULT 0,  -- 0=not started .. 3=complete, driven by the store's own portal wizard
  onboarding_completed_at TEXT,
  agreed_terms_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS store_billing (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id),
  period TEXT NOT NULL,        -- e.g. "2026-08"
  amount_owed REAL DEFAULT 0,
  amount_paid REAL DEFAULT 0,
  status TEXT DEFAULT 'open',  -- open | invoiced | paid | disputed
  invoice_ref TEXT,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Bills a STORE submits TO the org (the opposite direction from
-- store_billing above, which is what a store owes the org toward the
-- participation program) — e.g. reimbursement for gift-card redemptions
-- the store has already honored. A store portal login creates these; an
-- admin reviews and marks them paid.
CREATE TABLE IF NOT EXISTS store_bill_submissions (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  store_id TEXT NOT NULL REFERENCES stores(id),
  period TEXT,
  amount REAL NOT NULL,
  description TEXT,
  file_path TEXT,
  file_name TEXT,
  status TEXT DEFAULT 'submitted', -- submitted | reviewed | paid
  admin_notes TEXT,
  submitted_at TEXT DEFAULT (datetime('now')),
  reviewed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_store_bill_submissions_store ON store_bill_submissions(store_id, submitted_at);

-- ===================== Forms (form builder) =====================
CREATE TABLE IF NOT EXISTS forms (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  type TEXT NOT NULL,           -- always 'general' (#9: custom forms are no longer categorized as shul/store/applicant application — those three live at fixed hardcoded URLs, see utils/builtinSchemas.js)
  visibility TEXT DEFAULT 'public', -- public | group | individual
  slug TEXT UNIQUE,
  schema_json TEXT NOT NULL,    -- ordered field list: [{key,label,type,required,admin_override,visible}]
  target_json TEXT DEFAULT '[]',-- shul ids / group tags this form is limited to, when visibility != public
  is_active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Superseded by per-field required/admin_override living directly on
-- forms.schema_json (see utils/formValidation.js) — kept only so an
-- upgrading deploy doesn't lose the table out from under any lingering
-- reference; nothing in the app writes or reads this anymore.
CREATE TABLE IF NOT EXISTS form_field_settings (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  form_type TEXT NOT NULL,      -- shul | applicant
  field_key TEXT NOT NULL,
  is_required INTEGER DEFAULT 0,
  is_admin_override INTEGER DEFAULT 0, -- admin can fill/edit even if normally locked
  is_visible INTEGER DEFAULT 1,
  UNIQUE(org_id, form_type, field_key)
);

-- Every form submission, whether or not the form is currently the "default"
-- one feeding the Shuls/Applicants/Stores lists — a raw, exportable record
-- of what was actually submitted, independent of whatever entity row it may
-- also have created. form_name/form_type are denormalized (not just a FK)
-- so a response stays meaningful even if the form itself is later edited or
-- deleted. entity_type/entity_id are set when the submission also created a
-- real shul/applicant/store record; null for a form that's just collecting
-- responses.
CREATE TABLE IF NOT EXISTS form_responses (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  form_id TEXT REFERENCES forms(id),
  form_name TEXT,
  form_type TEXT,
  data_json TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_form_responses_org ON form_responses(org_id, created_at);
CREATE INDEX IF NOT EXISTS idx_form_responses_form ON form_responses(form_id);

-- ===================== Imports / duplicate detection / audit =====================
CREATE TABLE IF NOT EXISTS import_jobs (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  entity_type TEXT NOT NULL,    -- shuls | applicants
  file_name TEXT,
  status TEXT DEFAULT 'processing', -- processing | completed | failed
  total_rows INTEGER DEFAULT 0,
  success_count INTEGER DEFAULT 0,
  error_count INTEGER DEFAULT 0,
  duplicate_count INTEGER DEFAULT 0,
  error_log TEXT DEFAULT '[]',
  created_by TEXT REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS duplicate_flags (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  entity_type TEXT NOT NULL,    -- shul | applicant
  entity_id TEXT NOT NULL,
  matched_entity_id TEXT NOT NULL,
  reason TEXT,                  -- e.g. "same name + zip", "same email"
  status TEXT DEFAULT 'open',   -- open | bypassed | resolved
  resolved_by TEXT REFERENCES users(id),
  resolved_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  org_id TEXT,
  user_id TEXT,
  action TEXT NOT NULL,         -- create | update | delete | approve | pause | login | esign | ...
  entity_type TEXT,
  entity_id TEXT,
  before_json TEXT,
  after_json TEXT,
  ip_address TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  org_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT,
  PRIMARY KEY (org_id, key)
);

-- Anonymous pageview log for the public-facing site (home, apply forms,
-- FAQ, contact, etc.) — powers the admin Analytics page. visitor_id is a
-- random id the browser generates and stores in localStorage (see app.js's
-- trackPageview()), not tied to any account, just enough to tell "one
-- visitor, several pageviews" apart from "several different visitors."
CREATE TABLE IF NOT EXISTS page_views (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  path TEXT NOT NULL,
  referrer TEXT,
  visitor_id TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_page_views_org ON page_views(org_id, created_at);
CREATE INDEX IF NOT EXISTS idx_page_views_path ON page_views(org_id, path);

-- Public "Contact Us" form submissions.
CREATE TABLE IF NOT EXISTS contact_submissions (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

-- ===================== To-Do / Tasks =====================
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  title TEXT NOT NULL,
  description TEXT,
  assigned_to TEXT REFERENCES users(id),
  created_by TEXT REFERENCES users(id),
  entity_type TEXT,          -- 'shul' | 'applicant' | 'store' | NULL (standalone task)
  entity_id TEXT,
  due_date TEXT,              -- ISO date, e.g. "2026-08-20"
  priority TEXT DEFAULT 'normal', -- low | normal | high
  status TEXT DEFAULT 'open',      -- open | in_progress | done
  completed_at TEXT,
  last_reminded_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tasks_org ON tasks(org_id);
CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON tasks(assigned_to);
CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_date);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

CREATE INDEX IF NOT EXISTS idx_shuls_org ON shuls(org_id);
CREATE INDEX IF NOT EXISTS idx_shuls_status ON shuls(status);
CREATE INDEX IF NOT EXISTS idx_applicants_org ON applicants(org_id);
CREATE INDEX IF NOT EXISTS idx_applicants_shul ON applicants(shul_id);
CREATE INDEX IF NOT EXISTS idx_applicants_status ON applicants(approval_status);
CREATE INDEX IF NOT EXISTS idx_cards_applicant ON cards(applicant_id);
CREATE INDEX IF NOT EXISTS idx_txn_card ON card_transactions(card_id);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_id);
`);

// Guarded additive migrations (safe to re-run; never destructive).
function safeAlter(sql) { try { db.exec(sql); } catch (e) { /* column already exists */ } }
safeAlter(`ALTER TABLE users ADD COLUMN phone TEXT`);
safeAlter(`ALTER TABLE stores ADD COLUMN source TEXT DEFAULT 'admin'`);
safeAlter(`ALTER TABLE stores ADD COLUMN onboarding_step INTEGER DEFAULT 0`);
safeAlter(`ALTER TABLE stores ADD COLUMN onboarding_completed_at TEXT`);
safeAlter(`ALTER TABLE stores ADD COLUMN agreed_terms_at TEXT`);
safeAlter(`ALTER TABLE stores ADD COLUMN same_person INTEGER DEFAULT 0`);
safeAlter(`ALTER TABLE stores ADD COLUMN pos_system TEXT`);
safeAlter(`ALTER TABLE stores ADD COLUMN season_id TEXT REFERENCES seasons(id)`);
// Admin-only note on the discount this store gives (e.g. "10% off" or a
// dollar policy) — never returned to the store's own portal login (see
// routes/stores.js GET / and GET /:id, which strip it for role==='store').
safeAlter(`ALTER TABLE stores ADD COLUMN discount TEXT`);
safeAlter(`ALTER TABLE seasons ADD COLUMN max_accepted_applicants INTEGER`);
safeAlter(`ALTER TABLE shuls ADD COLUMN is_locked INTEGER DEFAULT 0`);
safeAlter(`ALTER TABLE applicants ADD COLUMN external_id TEXT`);
// The disccardpromos account created for this applicant on approval (see
// services/giftcard.js's upsertAccountForApproval) — distinct from
// cards.provider_card_id, which is the actual gift card assigned later.
safeAlter(`ALTER TABLE applicants ADD COLUMN provider_account_id TEXT`);
safeAlter(`ALTER TABLE forms ADD COLUMN opens_at TEXT`);
safeAlter(`ALTER TABLE forms ADD COLUMN closes_at TEXT`);
safeAlter(`ALTER TABLE forms ADD COLUMN is_default INTEGER DEFAULT 0`);
// Legacy column, kept only so existing rows/deploys don't break — used to
// mark which form was the live one for a section's fixed public page
// (apply.html etc.). That whole mechanism (routes/forms.js PUT
// /:id/set-default, GET /public/default/:type) is gone: those pages render
// a fixed question set now (see utils/builtinSchemas.js) and never consult
// this column. Nothing sets or reads it anymore.
safeAlter(`ALTER TABLE forms ADD COLUMN is_current_default INTEGER DEFAULT 0`);
// Every form is pinned to one season, so which season a submission lands in
// is determined by the form the applicant/shul/store actually used — not by
// whichever season happens to be "active" at the moment they hit submit
// (which could change out from under a link someone already has open).
safeAlter(`ALTER TABLE forms ADD COLUMN season_id TEXT REFERENCES seasons(id)`);
// SimpleSender doesn't support inbound webhooks yet, so inbound SMS is
// pulled by polling GET /v1/messages instead (see services/sms.js
// syncInboundSms) — this is how re-polling the same messages is recognized
// as already-imported instead of creating duplicate rows every sweep.
safeAlter(`ALTER TABLE sms_messages ADD COLUMN provider_message_id TEXT`);
safeAlter(`ALTER TABLE sms_messages ADD COLUMN season_id TEXT REFERENCES seasons(id)`);
// Per-template Reply-To override — falls back to the org-wide default
// (settings key email_reply_to) when null, and to no Reply-To header at all
// when neither is set. See services/mail.js renderSystemTemplate().
safeAlter(`ALTER TABLE system_email_templates ADD COLUMN reply_to TEXT`);
safeAlter(`ALTER TABLE audit_log ADD COLUMN undone_at TEXT`);
// Points an undone entry at the fresh 'undo' entry that reversed it, so the
// UI can offer a one-click "Redo" right on that same row instead of making
// the admin go find the separate "Reversed a change to..." log entry.
safeAlter(`ALTER TABLE audit_log ADD COLUMN undo_entry_id TEXT`);
// Full multi-field signing payload ({fieldId: value/dataUrl}) for documents
// that use more than one fillable item (multiple signatures, initials, date,
// text fields). signature_data/signer_name etc. above still get populated
// from the primary signature field for backward compatibility with existing
// "already signed" displays; field_values is the complete record.
safeAlter(`ALTER TABLE contracts ADD COLUMN field_values TEXT`);
safeAlter(`ALTER TABLE documents ADD COLUMN field_values TEXT`);
// Marks an applicant as permanently exempt from every disccardpromos write
// (account create/update, add-funds, lock/unlock on reject/approve) — for a
// one-time bulk import of a past/other season's real-world data that must
// never touch the live gift-card provider, regardless of what happens to
// the record afterward (approved, rejected, re-approved, etc.). Set at
// import time (routes/applicants.js POST /import) and editable afterward by
// an admin as a safety net.
safeAlter(`ALTER TABLE applicants ADD COLUMN provider_exempt INTEGER DEFAULT 0`);
// Internal-only note that survives Carry Forward to a new season, unlike
// the regular `comments` field (submitted with the application, shown to
// the shul, and deliberately blank again on a carried-forward row — each
// season is its own fresh submission) or shul_notes (a dated log, tied to
// one specific shul row, never copied to the next season's row either).
// Never exposed to a shul/store/public view — admin-only, same boundary as
// notes. Set/edited from the admin detail modal; copied verbatim by
// routes/shuls.js POST /:id/carry-forward.
safeAlter(`ALTER TABLE applicants ADD COLUMN permanent_comments TEXT`);
safeAlter(`ALTER TABLE shuls ADD COLUMN permanent_comments TEXT`);
// Points a carried-forward applicant row at the specific source row it was
// cloned from (see routes/shuls.js POST /:id/carry-forward and
// /mass-carry-forward) — lets carry-forward recognize "this exact applicant
// was already carried into this exact target season" and skip re-inserting
// a duplicate row, rather than creating a new incomplete copy every time the
// action is re-run for the same shul/season pair.
safeAlter(`ALTER TABLE applicants ADD COLUMN carried_from_applicant_id TEXT REFERENCES applicants(id)`);
// Groups every applicant row confirmed to be the same real person across
// however many shuls submitted them (see services/duplicates.js's
// mergeApplicants) — set to the PRIMARY member's own id on every row in the
// group, including the primary itself, so "is this row the primary" is just
// `merge_group_id === id`. A duplicate can legitimately span more than two
// shuls, so this is a group key, not a single pairwise link (that's what the
// existing duplicate_of_applicant_id is for, and it's kept for the original
// flagged-against reference/audit trail).
safeAlter(`ALTER TABLE applicants ADD COLUMN merge_group_id TEXT`);

// "Minimum shul contribution" feature: a season can require the shul to
// report how much of their OWN money they already gave a family, and
// confirm it, before that applicant can be approved/carded — see
// routes/applicants.js's /:id/approve and /mass-approve. The minimum bar
// itself (per-applicant override, falling back to the shul's default) is
// admin-only and never sent to a shul-role request — see maskForShul.
safeAlter(`ALTER TABLE seasons ADD COLUMN require_shul_contribution INTEGER DEFAULT 0`);
safeAlter(`ALTER TABLE shuls ADD COLUMN min_contribution_default REAL`);
safeAlter(`ALTER TABLE applicants ADD COLUMN min_contribution_override REAL`);
safeAlter(`ALTER TABLE applicants ADD COLUMN shul_contribution_amount REAL`);
safeAlter(`ALTER TABLE applicants ADD COLUMN shul_contribution_confirmed INTEGER DEFAULT 0`);

// Per-season disccardpromos credentials (see services/giftcard.js) — for
// now, each season can hold its own API base/key, entered on the season's
// edit form. Empty on a season falls back to the org-wide
// DISCCARDPROMOS_API_BASE/KEY env vars, so existing seasons keep working
// unchanged until someone deliberately sets an override.
safeAlter(`ALTER TABLE seasons ADD COLUMN disccardpromos_api_base TEXT`);
safeAlter(`ALTER TABLE seasons ADD COLUMN disccardpromos_api_key TEXT`);

// Standalone e-signature requests: entity_type='standalone' rows in the same
// `documents` table, for a recipient who has no applicant/store/shul record
// at all (a vendor, board member, any outside party) — a totally separate
// use case from the entity-bound documents above and from shul `contracts`,
// which is why it gets its own recipient fields instead of resolving through
// resolveEntity(). entity_id stays '' (NOT NULL) for these rows; unused.
safeAlter(`ALTER TABLE documents ADD COLUMN recipient_name TEXT`);
safeAlter(`ALTER TABLE documents ADD COLUMN recipient_email TEXT`);

// ESIGN Act / NY ESRA-style affirmative consent record: every public sign
// endpoint (shul contract, generic document, standalone e-signature) now
// requires an explicit `consent: true` in the sign request and stamps the
// timestamp here — separate from signed_at so there's a distinct record that
// the signer affirmatively agreed to sign electronically, not just that a
// signature value was submitted.
safeAlter(`ALTER TABLE contracts ADD COLUMN esign_consent_at TEXT`);
safeAlter(`ALTER TABLE documents ADD COLUMN esign_consent_at TEXT`);
// Per-document field/signature placement for standalone e-signature
// requests (no linked shul/applicant/store record, so the shared per-kind
// signature_box_* setting doesn't apply — every standalone document can be
// a totally different PDF). Same {id,type,label,x,y,width,height,required}
// shape as signature_box_*, just stored on the row itself. NULL/empty means
// "use the single default signature box" (see GET/POST /documents/sign).
safeAlter(`ALTER TABLE documents ADD COLUMN fields_json TEXT`);

// Which shul a soft-rejected applicant (routes/applicants.js's
// POST /:id/soft-reject) was removed from — shul_id itself has to go to
// NULL for the soft-reject to actually work (that's what makes the record
// invisible to every shul-scoped query), so this is the only place that
// history survives. Cleared again the moment the record is given a real
// shul_id (PUT /:id's auto-revert back to 'pending') — only meaningful
// while the record is actually soft-rejected.
safeAlter(`ALTER TABLE applicants ADD COLUMN previous_shul_id TEXT REFERENCES shuls(id)`);

// One-time normalization of pre-existing phone numbers to the canonical
// 123-456-7890 display format (see utils/phone.js). Cheap and idempotent —
// re-running it on already-normalized numbers is a no-op — so it's safe to
// leave running on every boot rather than tracking a "have we run this" flag.
function normalizePhoneColumn(table, column) {
  const rows = db.prepare(`SELECT id, ${column} AS val FROM ${table} WHERE ${column} IS NOT NULL AND ${column} != ''`).all();
  const update = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE id = ?`);
  for (const row of rows) {
    const normalized = normalizePhone(row.val);
    if (normalized !== row.val) update.run(normalized, row.id);
  }
}
normalizePhoneColumn('shuls', 'ruv_phone');
normalizePhoneColumn('shuls', 'gabai_cell');
normalizePhoneColumn('applicants', 'home_phone');
normalizePhoneColumn('applicants', 'husband_cell');
normalizePhoneColumn('applicants', 'wife_cell');
normalizePhoneColumn('stores', 'phone');
normalizePhoneColumn('stores', 'manager_phone');
normalizePhoneColumn('stores', 'owner_phone');
normalizePhoneColumn('users', 'phone');
normalizePhoneColumn('organizations', 'support_phone');

// Backfill a 4-digit external_id for any applicant that predates this
// column (see routes/applicants.js, which assigns one on every new create).
{
  const missing = db.prepare(`SELECT id FROM applicants WHERE external_id IS NULL OR external_id = ''`).all();
  const setExternalId = db.prepare('UPDATE applicants SET external_id = ? WHERE id = ?');
  for (const row of missing) setExternalId.run(generateApplicantExternalId(db), row.id);
}

// ---------------------------------------------------------------------------
// Seed a default organization + super admin on first boot so the app is usable
// immediately. Idempotent.
// ---------------------------------------------------------------------------
const orgCount = db.prepare('SELECT COUNT(*) c FROM organizations').get().c;
let defaultOrgId;
if (orgCount === 0) {
  defaultOrgId = randomUUID();
  db.prepare(`INSERT INTO organizations (id, name, subdomain, primary_color, accent_color, support_email)
    VALUES (?, ?, ?, ?, ?, ?)`).run(
    defaultOrgId, 'Shmachas Rechag - Kupat Ha\'ir', 'ecards', '#241a15', '#c9a76a', process.env.SUPPORT_EMAIL || ''
  );
  const seasonId = randomUUID();
  db.prepare(`INSERT INTO seasons (id, org_id, name, is_active, default_card_amount) VALUES (?,?,?,1,0)`)
    .run(seasonId, defaultOrgId, 'Season ' + new Date().getFullYear());

  // Never fall back to a hardcoded password here — "ChangeMe123!" was a
  // fixed, publicly-known default (visible in this repo's history), so any
  // environment that unexpectedly re-seeds (e.g. a persistent disk that
  // failed to attach) would silently stand up a super-admin account anyone
  // could log into. A random one is only ever visible in this boot's server
  // log, which only whoever runs the deploy can see.
  const adminEmail = process.env.SEED_ADMIN_EMAIL || 'admin@everythingshul.com';
  const adminPass = process.env.SEED_ADMIN_PASSWORD || randomUUID();
  db.prepare(`INSERT INTO users (id, org_id, email, password_hash, first_name, last_name, role)
    VALUES (?,?,?,?,?,?,?)`).run(
    randomUUID(), defaultOrgId, adminEmail, bcrypt.hashSync(adminPass, 10), 'Super', 'Admin', 'super_admin'
  );
  console.log(`[db] Seeded default org + super admin (${adminEmail} / ${adminPass}) — CHANGE THIS PASSWORD IMMEDIATELY.`);
  if (!process.env.SEED_ADMIN_PASSWORD) {
    console.warn('[db] SEED_ADMIN_PASSWORD was not set — a random one-time password was generated above. Set SEED_ADMIN_PASSWORD (and SEED_ADMIN_EMAIL) in your deploy environment so re-seeding is intentional and predictable, not automatic.');
  }

} else {
  defaultOrgId = db.prepare('SELECT id FROM organizations ORDER BY created_at LIMIT 1').get().id;
}

// ---------------------------------------------------------------------------
// The three built-in public application pages (apply.html, apply-store.html,
// apply-ezras-habayis.html) used to be driven by an auto-seeded, editable
// `forms` row per type (is_default=1) — Form Builder could edit their fields,
// schedule them, or swap which form was "current." That's gone: these pages
// now render a fixed question set hardcoded in utils/builtinSchemas.js, and
// nothing seeds/depends on a forms-table row for them anymore. One-time
// cleanup on every boot: remove any of the three auto-seeded rows still
// lying around from before this change. Only rows this seeding itself ever
// created (is_default=1) are touched — any real custom form an admin built
// through Form Builder (is_default=0, even if it happens to share one of
// these three types) is left completely alone.
// form_responses.form_id is a real FK (foreign_keys=ON above) — detach any
// historical responses from the rows about to be deleted rather than losing
// them; form_name/form_type are already denormalized onto that row, so the
// response stays meaningful with form_id simply cleared.
db.prepare(`UPDATE form_responses SET form_id = NULL WHERE form_id IN (
    SELECT id FROM forms WHERE is_default = 1 AND type IN ('shul_application','store_application','applicant_application')
  )`).run();
db.prepare(`DELETE FROM forms WHERE is_default = 1 AND type IN ('shul_application','store_application','applicant_application')`).run();

// One-time-per-boot backfill: any custom form created before season_id
// existed that still has no season pinned gets its org's current active
// season. Runs every boot but is a no-op once every form has one, since new
// forms are required to set season_id going forward (see routes/forms.js).
db.prepare(`UPDATE forms SET season_id = (
    SELECT id FROM seasons WHERE seasons.org_id = forms.org_id AND seasons.is_active = 1 ORDER BY seasons.created_at DESC LIMIT 1
  ) WHERE season_id IS NULL`).run();

// Shul/store portal accounts used to store users.email exactly as typed on
// the application ("Moshe@Gmail.com") while login lowercases its lookup —
// and SQLite string comparison is case-sensitive, so every such account was
// impossible to sign into and never received a password-reset email (the
// forgot-password lookup misses the same way, then responds "ok" without
// sending, by design). Normalize every existing row; passwords are
// untouched, so whoever already set one just logs in normally afterward.
// The one guard: users.email is UNIQUE, so if two accounts differ only by
// case (shouldn't exist, but possible), the collision is skipped and
// logged for manual resolution instead of crashing the boot — login stays
// possible for those via the COLLATE NOCASE lookup in routes/auth.js.
let emailsNormalized = 0;
for (const u of db.prepare(`SELECT id, email FROM users WHERE email != lower(trim(email))`).all()) {
  const lower = u.email.trim().toLowerCase();
  const clash = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(lower, u.id);
  if (clash) { console.warn(`[db] NOT normalizing user email "${u.email}" — another account already uses "${lower}". Resolve manually.`); continue; }
  db.prepare('UPDATE users SET email = ? WHERE id = ?').run(lower, u.id);
  emailsNormalized++;
}
if (emailsNormalized) {
  console.log(`[db] Normalized ${emailsNormalized} user email(s) to lowercase — these accounts were un-loginable due to case-sensitive lookup.`);
}

// Applicants auto-rejected by the OLD, buggy isZipAllowed (raw string
// match — see routes/applicants.js) purely because their zip lost a
// leading zero somewhere upstream (e.g. an Excel cell formatted as a
// number: "07030" -> 7030) never should have been rejected at all — their
// zip genuinely is in the org's Allowed Zip Codes list once compared
// correctly. Re-checks every still-'rejected' applicant that an admin
// never actually clicked Reject on (no matching audit_log 'reject' or
// 'mass-reject' entry — those are real decisions and are left alone no
// matter what their zip looks like) against the corrected zip logic, and
// restores it to 'pending' if it now matches. Deliberately duplicates
// (rather than imports) isZipAllowed's normalize/compare logic — this
// runs at module load, before routes/applicants.js exists to import from,
// and importing this file from there would be circular. Runs every boot,
// no-op once a record leaves 'rejected' — the required-field backfill
// right below catches anything this restores to 'pending' that's also
// missing a required field.
function normalizeZipForMigration(z) {
  const s = String(z || '').trim();
  if (!s || !/^\d+(-\d+)?$/.test(s)) return s;
  return s.split('-')[0].padStart(5, '0');
}
const manuallyRejectedApplicantIds = new Set(
  db.prepare(`SELECT entity_id FROM audit_log WHERE action = 'reject' AND entity_type = 'applicant' AND entity_id IS NOT NULL`).all().map(r => r.entity_id)
);
for (const row of db.prepare(`SELECT after_json FROM audit_log WHERE action = 'mass-reject' AND entity_type = 'applicant'`).all()) {
  try { (JSON.parse(row.after_json || '{}').ids || []).forEach(id => manuallyRejectedApplicantIds.add(id)); } catch { /* malformed/old row */ }
}
const allowedZipsByOrg = new Map();
let zipRecheckRestored = 0;
for (const a of db.prepare(`SELECT id, org_id, zip FROM applicants WHERE approval_status = 'rejected'`).all()) {
  if (manuallyRejectedApplicantIds.has(a.id)) continue;
  if (!allowedZipsByOrg.has(a.org_id)) {
    const setting = db.prepare(`SELECT value FROM settings WHERE org_id = ? AND key = 'allowed_zip_codes'`).get(a.org_id);
    allowedZipsByOrg.set(a.org_id, setting && setting.value.trim() ? setting.value.split(',').map(normalizeZipForMigration).filter(Boolean) : null);
  }
  const allowed = allowedZipsByOrg.get(a.org_id);
  if (allowed && allowed.length && !allowed.includes(normalizeZipForMigration(a.zip))) continue; // genuinely out of area
  db.prepare(`UPDATE applicants SET approval_status = 'pending', updated_at = datetime('now') WHERE id = ?`).run(a.id);
  zipRecheckRestored++;
}
if (zipRecheckRestored) {
  console.log(`[db] Re-checked ${zipRecheckRestored} auto-rejected applicant(s) against the corrected zip-matching logic and restored to 'pending'.`);
}

// address/city/state/zip/husband_cell used to be optional on the Applicant
// Application question set (utils/builtinSchemas.js) — now required, same
// as first/last name. Anything still in the normal decision pipeline
// (pending or auto/manually rejected) that was let through under the old,
// laxer rules and is missing one of those fields never should have counted
// as a real submission. Put back as 'incomplete' — the exact same status/
// screen a carried-forward shul already uses to finish an applicant's
// info (shul-portal openReenrollment) — so the shul sees it and has to
// fill in what's missing before it counts again. Runs every boot but is a
// no-op once a record is fixed (or stays fixed): completing it moves it out
// of 'pending'/'rejected' and out of this WHERE clause for good, and if it
// comes back here it's because it's genuinely missing something again.
// Already-approved applicants are deliberately left untouched — a gift
// card may already be issued against one, and reversing that isn't safe to
// do blindly as part of an unattended migration.
const missingRequiredApplicantField = `(
    TRIM(COALESCE(first_name,'')) = '' OR TRIM(COALESCE(last_name,'')) = '' OR
    TRIM(COALESCE(address,'')) = '' OR TRIM(COALESCE(city,'')) = '' OR
    TRIM(COALESCE(state,'')) = '' OR TRIM(COALESCE(zip,'')) = '' OR
    TRIM(COALESCE(husband_cell,'')) = ''
  )`;
const incompleteBackfill = db.prepare(`UPDATE applicants SET approval_status = 'incomplete', updated_at = datetime('now')
    WHERE approval_status IN ('pending','rejected') AND ${missingRequiredApplicantField}`).run();
if (incompleteBackfill.changes) {
  console.log(`[db] Marked ${incompleteBackfill.changes} pending/rejected applicant(s) missing a now-required field (address/city/state/zip/husband cell) as 'incomplete' for the shul to complete.`);
}

export const DEFAULT_ORG_ID = defaultOrgId;
export function uuid() { return randomUUID(); }
