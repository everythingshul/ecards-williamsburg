import { db } from '../db.js';

// Which season a submission through one of the built-in application pages
// (shul/store/applicant, Ezras Habayis included) should land in — whichever
// season is currently active for the org. These pages used to be able to
// pin a specific season via the forms table (a form row's own season_id);
// that mechanism was removed along with the forms-table-driven schema for
// these flows (see utils/builtinSchemas.js) — a fresh submission simply
// always lands in the current active season now.
export function getActiveSeasonId(orgId) {
  const active = db.prepare('SELECT id FROM seasons WHERE org_id = ? AND is_active = 1 ORDER BY created_at DESC LIMIT 1').get(orgId);
  return active?.id || null;
}

// Still used by genuinely custom forms built in Form Builder (routes/forms.js
// GET /public/:slug and POST /public/:slug/submit) — those keep their own
// opens_at/closes_at scheduling and is_active toggle, unlike the four
// built-in flows this no longer gates.
export function formWindowError(form) {
  if (!form) return null;
  if (!form.is_active) return 'This application is not currently being accepted.';
  const now = new Date();
  if (form.opens_at && now < new Date(form.opens_at)) return `Applications open ${new Date(form.opens_at).toLocaleDateString()}.`;
  if (form.closes_at && now > new Date(form.closes_at)) return 'Applications for this are now closed.';
  return null;
}
