import { db, uuid, DEFAULT_ORG_ID } from '../db.js';

// ---------------------------------------------------------------------------
// Email — Brevo (https://api.brevo.com) transactional email API.
//
// Single-org platform: one Brevo sending account for everything, set via
// BREVO_API_KEY / EMAIL_DEFAULT_SENDER / EMAIL_DEFAULT_SENDER_NAME env vars.
// (This app previously supported per-org Brevo accounts; that was reverted —
// the whole platform now runs as one organization, one sending identity.)
//
// IMPORTANT — most common cause of "emails aren't sending": Brevo requires
// the sender email (EMAIL_DEFAULT_SENDER) to be a verified sender identity
// (or verified domain) in your Brevo account. If it isn't, every send fails
// with an auth/sender error — which now surfaces as `emailError` in the API
// response and a `[mail] Brevo send failed` log line, instead of failing
// silently. Verify your sender at app.brevo.com > Senders & IP.
// ---------------------------------------------------------------------------

const CONFIG = {
  apiKey: process.env.BREVO_API_KEY || '',
  senderEmail: process.env.EMAIL_DEFAULT_SENDER || 'noreply@example.com',
  senderName: process.env.EMAIL_DEFAULT_SENDER_NAME || "Kupes Hair Williamsburg",
};

export function initMail() {
  if (!CONFIG.apiKey) {
    console.warn('[mail] BREVO_API_KEY not set — emails will be logged to console (dry-run) instead of sent.');
  }
}

function brandFor() {
  const org = db.prepare('SELECT name, primary_color, accent_color FROM organizations WHERE id = ?').get(DEFAULT_ORG_ID);
  return {
    name: org?.name || CONFIG.senderName,
    color: org?.primary_color || '#241a15',
    accent: org?.accent_color || '#c9a76a',
  };
}

// Absolute URLs only — email clients render this HTML with no origin of
// their own to resolve a relative /img/... path against, unlike the site
// itself. APP_URL is already required elsewhere for the same reason (sign
// links, invite links).
function assetUrl(path) { return `${process.env.APP_URL || ''}${path}`; }

function wrap(bodyHtml, brand) {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#ece3d3;font-family:Georgia,'Times New Roman',serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ece3d3;padding:40px 16px;">
    <tr><td align="center">
      <table width="580" cellpadding="0" cellspacing="0" style="max-width:580px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 2px 18px rgba(36,26,21,.10);">
        <tr><td style="background:${brand.color};padding:30px 36px;text-align:center;">
          <img src="${assetUrl('/img/org-logo.png')}" alt="${brand.name}" height="72" style="height:72px;width:auto;max-width:280px;">
        </td></tr>
        <tr><td style="height:3px;background:${brand.accent};line-height:0;font-size:0;">&nbsp;</td></tr>
        <tr><td dir="auto" style="padding:40px 40px 32px;color:#2a231d;font-size:15.5px;line-height:1.7;">${bodyHtml}</td></tr>
        <tr><td style="padding:0 40px;"><div style="border-top:1px solid #ece3d3;"></div></td></tr>
        <tr><td style="padding:22px 40px 28px;text-align:center;">
          <a href="https://everythingshul.com" style="text-decoration:none;color:#8a7c63;font-size:12px;">Powered By
            <img src="${assetUrl('/img/everythingshul-logo.png')}" alt="everythingshul" height="16" style="height:16px;width:auto;vertical-align:middle;margin-left:6px;">
          </a>
        </td></tr>
      </table>
    </td></tr>
  </table></body></html>`;
}

// Org-wide default Reply-To (Settings > Organization), used whenever a send
// doesn't pass its own replyTo explicitly. Per-template overrides in
// renderSystemTemplate() take priority over this by passing their own value.
function defaultReplyTo(orgId) {
  const row = db.prepare(`SELECT value FROM settings WHERE org_id = ? AND key = 'email_reply_to'`).get(orgId || DEFAULT_ORG_ID);
  return row?.value || null;
}

// orgId param kept for call-site compatibility but no longer used to look up
// per-org credentials — see note above. Every email uses the single platform account.
export async function sendMail(orgId, to, subject, bodyHtml, replyTo) {
  const cfg = CONFIG;
  const brand = brandFor();
  const html = wrap(bodyHtml, brand);
  const effectiveReplyTo = replyTo || defaultReplyTo(orgId);
  if (!cfg.apiKey) {
    console.log(`[mail:DRY-RUN org=${orgId || 'platform'}] To: ${to} | Subject: ${subject}\n${bodyHtml.replace(/<[^>]+>/g, ' ')}`);
    return { dryRun: true };
  }
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': cfg.apiKey, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({
      sender: { email: cfg.senderEmail, name: cfg.senderName },
      to: [{ email: to }],
      subject,
      htmlContent: html,
      ...(effectiveReplyTo ? { replyTo: { email: effectiveReplyTo } } : {}),
    }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    console.error('[mail] Brevo send failed', res.status, body);
    throw new Error(body?.message || `Email send failed (${res.status})`);
  }
  return res.json();
}

// Wraps sendMail() so every call site gets a single, consistent emailError
// string to show/return — including the "no provider configured" case.
// That case matters because dry-run mode (no BREVO_API_KEY) resolves
// successfully with { dryRun: true } rather than throwing, so without this
// wrapper it looks identical to a real send in the API response: nothing
// gets emailed, but no error surfaces anywhere, and the recipient just
// reports "I never got the email" with no clue why.
//
// Also the single choke point every email in the app passes through, so
// it's where every send gets logged to emails_sent for the Email Center's
// "view sent emails" list — `meta` is optional and lets callers attach
// which record this email was about (Email Center's own compose flow uses
// it; automatic system emails don't bother).
export async function sendMailChecked(orgId, to, subject, bodyHtml, meta = {}) {
  let status = 'sent', emailError = null;
  try {
    const result = await sendMail(orgId, to, subject, bodyHtml, meta.replyTo);
    if (result?.dryRun) { status = 'dry_run'; emailError = 'Email provider not configured (BREVO_API_KEY missing). No email was actually sent.'; }
  } catch (e) {
    status = 'failed'; emailError = e.message;
  }
  try {
    db.prepare(`INSERT INTO emails_sent (id, org_id, to_email, subject, body_html, status, error_message, related_entity_type, related_entity_id, sent_by)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(uuid(), orgId || DEFAULT_ORG_ID, to, subject, bodyHtml, status, emailError, meta.relatedEntityType || null, meta.relatedEntityId || null, meta.sentBy || null);
  } catch (e) { console.error('[mail] failed to log sent email:', e.message); }
  return { emailError };
}

// Every system-triggered email (as opposed to Email Center's manually
// composed ones) has an editable text here — admins can override subject/body
// per key from Settings > Auto Emails (system_email_templates table); this
// object is both the fallback when no override exists AND the starting point
// shown in that editor. {{var}} placeholders get substituted at send time by
// renderSystemTemplate() below — `vars` lists exactly which ones are
// available for a given key so the editor UI can show/validate them.
export const SYSTEM_EMAIL_TEMPLATES = {
  contractReady: {
    label: 'Contract Ready to Sign', vars: ['shulName', 'signUrl'],
    subject: 'Contract ready to sign: {{shulName}}',
    body: `<p>Shalom,</p><p>Thank you for registering <strong>{{shulName}}</strong>. Please review and sign your contract to complete onboarding:</p>
      <p style="text-align:center;margin:28px 0;"><a href="{{signUrl}}" style="background:#c9a76a;color:#241a15;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:bold;">Review &amp; Sign Contract</a></p>
      <p>If the button doesn't work, copy this link: {{signUrl}}</p>`,
  },
  accountApproved: {
    label: 'Shul Approved / Account Setup', vars: ['shulName', 'loginUrl', 'slots'],
    subject: "You're approved! Set up your account: {{shulName}}",
    body: `<p>Mazal tov. <strong>{{shulName}}</strong> has been approved with <strong>{{slots}} slot(s)</strong> for this season.</p>
      <p>Create your account password to begin submitting applicants:</p>
      <p style="text-align:center;margin:28px 0;"><a href="{{loginUrl}}" style="background:#c9a76a;color:#241a15;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:bold;">Set Up Account</a></p>`,
  },
  applicantApproved: {
    label: 'Applicant Approved', vars: ['name'],
    subject: 'Applicant approved: {{name}}',
    body: '<p><strong>{{name}}</strong> has been approved and a gift card will be issued.</p>',
  },
  documentReady: {
    label: 'Document Ready to Sign', vars: ['docTitle', 'entityName', 'signUrl'],
    subject: '{{docTitle}} ready to sign: {{entityName}}',
    body: `<p>Shalom,</p><p>Please review and sign the following document: <strong>{{docTitle}}</strong>.</p>
      <p style="text-align:center;margin:28px 0;"><a href="{{signUrl}}" style="background:#c9a76a;color:#241a15;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:bold;">Review &amp; Sign</a></p>
      <p>If the button doesn't work, copy this link: {{signUrl}}</p>`,
  },
  documentSigned: {
    label: 'Document Signed (copy for signer)', vars: ['docTitle', 'entityName', 'signedUrl'],
    subject: 'Signed: {{docTitle}}',
    body: `<p>Shalom,</p><p>This confirms <strong>{{docTitle}}</strong> has been signed. You can view or download your copy here:</p>
      <p style="text-align:center;margin:28px 0;"><a href="{{signedUrl}}" style="background:#c9a76a;color:#241a15;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:bold;">View Signed Document</a></p>
      <p>If the button doesn't work, copy this link: {{signedUrl}}</p>`,
  },
  applicationReceived: {
    label: 'Application Received (no contract yet)', vars: ['entityName'],
    subject: 'Application received: {{entityName}}',
    body: `<p>Shalom,</p><p>Thank you, <strong>{{entityName}}</strong> — we've received your application. A member of our team will review it and be in touch soon.</p>`,
  },
  storeSetup: {
    label: 'Store Welcome', vars: ['storeName', 'portalUrl'],
    subject: 'Welcome, {{storeName}}',
    body: `<p>Your store <strong>{{storeName}}</strong> has been added as a participating location.</p>
      <p style="text-align:center;margin:28px 0;"><a href="{{portalUrl}}" style="background:#c9a76a;color:#241a15;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:bold;">Go to Store Portal</a></p>
      <p>If the button doesn't work, copy this link: {{portalUrl}}</p>`,
  },
  userInvite: {
    label: 'Internal User Invite', vars: ['role', 'inviteUrl'],
    subject: "You've been invited",
    body: `<p>You've been invited as <strong>{{role}}</strong>. Set your password to get started:</p><p><a href="{{inviteUrl}}">{{inviteUrl}}</a></p>`,
  },
  passwordReset: {
    label: 'Password Reset', vars: ['resetUrl'],
    subject: 'Reset your password',
    body: `<p>Click below to reset your password. This link expires in 24 hours.</p><p><a href="{{resetUrl}}">{{resetUrl}}</a></p>`,
  },
  // Internal notice, not sent to the shul/store itself — see
  // notifyNewSignup() below. Only ever fires when Settings > Organization's
  // "Notify on New Signups" email is set.
  newShulSignup: {
    label: 'Internal Notice: New Shul Signup', vars: ['shulName', 'contactName', 'contactEmail', 'contactPhone', 'details'],
    subject: 'New shul application: {{shulName}}',
    body: `<p>A new shul application was just submitted.</p>
      <p><strong>Shul:</strong> {{shulName}}<br><strong>Contact:</strong> {{contactName}}<br><strong>Email:</strong> {{contactEmail}}<br><strong>Phone:</strong> {{contactPhone}}</p>
      {{details}}`,
  },
  newStoreSignup: {
    label: 'Internal Notice: New Store Signup', vars: ['storeName', 'contactName', 'contactEmail', 'contactPhone', 'details'],
    subject: 'New store application: {{storeName}}',
    body: `<p>A new store application was just submitted.</p>
      <p><strong>Store:</strong> {{storeName}}<br><strong>Contact:</strong> {{contactName}}<br><strong>Email:</strong> {{contactEmail}}<br><strong>Phone:</strong> {{contactPhone}}</p>
      {{details}}`,
  },
  docSigned: {
    label: 'Internal Notice: Document Signed', vars: ['docTitle', 'entityName', 'signerName', 'signedAt', 'entityUrl'],
    subject: 'Signed: {{docTitle}} ({{entityName}})',
    body: `<p><strong>{{entityName}}</strong> just signed <strong>{{docTitle}}</strong>.</p>
      <p><strong>Signed by:</strong> {{signerName}}<br><strong>Signed at:</strong> {{signedAt}}</p>
      <p><a href="{{entityUrl}}">View in the admin portal</a></p>`,
  },
  paymentMethodRequest: {
    label: 'Internal Notice: Payment Method Request', vars: ['shulName', 'requestedMethod', 'message'],
    subject: 'Payment method request from {{shulName}}',
    body: `<p><strong>{{shulName}}</strong> requested a different payment method: <strong>{{requestedMethod}}</strong>.</p>{{message}}<p>Please follow up with them directly.</p>`,
  },
};

// Renders every field the shul/store just submitted as a plain label/value
// table for the internal new-signup notice's {{details}} var — the
// top-of-email summary previously had room for only name/contact/phone, so
// admins had to open the record itself to see the rest of what was
// submitted. Skips technical/internal columns (ids, lat/lng/place_id,
// status, timestamps, ...) since those aren't part of what the applicant
// actually typed into the form.
const DETAILS_SKIP_KEYS = new Set([
  'id', 'org_id', 'season_id', 'lat', 'lng', 'place_id', 'ruv_place_id', 'gabai_place_id',
  'status', 'is_paused', 'is_locked', 'duplicate_of_shul_id', 'duplicate_status', 'portal_user_id', 'source',
  'created_at', 'updated_at', 'same_person', 'setup_status', 'has_provider_account', 'provider_store_id',
  'onboarding_step', 'onboarding_completed_at', 'agreed_terms_at',
]);
function fieldLabelFallback(key) {
  return key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}
// This table is built from raw shul/store submission data (address,
// comments, names, ...) — escape it before dropping it into an HTML email
// body, since an applicant could type anything into a free-text field.
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
export function renderSignupDetails(row) {
  const rowsHtml = Object.keys(row)
    .filter(k => !DETAILS_SKIP_KEYS.has(k) && row[k] !== null && row[k] !== '' && row[k] !== undefined)
    .map(k => `<tr><td style="padding:3px 12px 3px 0;color:#6b6b6b;white-space:nowrap">${escapeHtml(fieldLabelFallback(k))}</td><td style="padding:3px 0">${escapeHtml(row[k])}</td></tr>`)
    .join('');
  return rowsHtml ? `<table style="border-collapse:collapse;margin-top:10px">${rowsHtml}</table>` : '';
}

function substitute(text, vars) {
  return String(text).replace(/\{\{(\w+)\}\}/g, (m, k) => (vars[k] != null ? vars[k] : m));
}

// Renders a system-triggered email: an admin-editable override if one
// exists for this org+key (Settings > Auto Emails), else the built-in
// default above. Both paths share the same {{var}} substitution, so an
// override uses the exact same placeholder vocabulary the default shows.
export function renderSystemTemplate(orgId, key, vars) {
  const def = SYSTEM_EMAIL_TEMPLATES[key];
  if (!def) throw new Error(`Unknown system email template: ${key}`);
  const override = db.prepare('SELECT subject, body, reply_to FROM system_email_templates WHERE org_id = ? AND key = ?').get(orgId || DEFAULT_ORG_ID, key);
  const source = override || def;
  // Per-template Reply-To, if this template has its own override; sendMail()
  // falls back to the org-wide default itself when this comes back null, so
  // there's no need to resolve that fallback here too.
  return { subject: substitute(source.subject, vars), body: substitute(source.body, vars), replyTo: override?.reply_to || null };
}

// Optional internal alert (Settings > Organization > "Notify on New Shul/
// Store Signups") — when one or more comma-separated addresses are set for
// settingKey, every brand-new shul/store public application sends each of
// them a heads-up using the newShulSignup/newStoreSignup templates above.
// Shuls and stores use separate setting keys (see the two call sites in
// routes/shuls.js and routes/stores.js) so either can be configured, or
// left off, independently. No-op if the setting is blank (the default),
// and — like every other automatic email in this file — best-effort: a
// failure on one (or all) recipients never blocks or undoes the signup
// that triggered it, just logs.
export async function notifyNewSignup(orgId, settingKey, templateKey, vars) {
  const raw = db.prepare(`SELECT value FROM settings WHERE org_id = ? AND key = ?`).get(orgId || DEFAULT_ORG_ID, settingKey)?.value;
  const recipients = (raw || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!recipients.length) return;
  const tmpl = renderSystemTemplate(orgId, templateKey, vars);
  for (const to of recipients) {
    const { emailError } = await sendMailChecked(orgId, to, tmpl.subject, tmpl.body, { replyTo: tmpl.replyTo });
    if (emailError) console.error(`[mail] new-signup notification (${templateKey}) to ${to} failed:`, emailError);
  }
}
