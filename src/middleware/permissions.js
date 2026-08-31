import { db, uuid } from '../db.js';

// Role defaults used when a user has no explicit `permissions` row for a
// resource (the `permissions` table itself is only ever populated for
// internal team members — super_admin/org_admin/staff — via Users &
// Permissions; a shul/store portal login never has rows there, so it always
// falls back to ROLE_DEFAULTS below).
const ROLE_DEFAULTS = {
  super_admin: { can_view: 1, can_edit: 1, can_export: 1, hidden_fields: [], scope: 'all' },
  org_admin:   { can_view: 1, can_edit: 1, can_export: 1, hidden_fields: [], scope: 'all' },
  staff:       { can_view: 1, can_edit: 0, can_export: 0, hidden_fields: [], scope: 'all' },
  shul:        { can_view: 1, can_edit: 1, can_export: 0, hidden_fields: [], scope: 'assigned' },
  store:       { can_view: 1, can_edit: 0, can_export: 0, hidden_fields: [], scope: 'assigned' },
};
const PORTAL_DENIED = { can_view: 0, can_edit: 0, can_export: 0, hidden_fields: [], scope: 'assigned' };

// Every resource an internal-team nav item or page can be gated on — kept
// in sync with frontend/js/app.js's NAV_ITEMS (their `resource` keys) and
// frontend/admin/users.html's RESOURCES (which just re-exports this list, so
// every entry here automatically gets a row in Users & Permissions). Used
// by routes/auth.js to hand the client a full permission map at login/me,
// so the nav can hide a blocked section outright instead of showing it and
// only 403ing when clicked, AND by every route file below as the actual
// server-side gate — a resource missing from this list, or a route that
// only checks requireAdmin instead of requirePermission(), is a section no
// per-user permission can ever actually restrict, no matter what the UI shows.
export const PERMISSION_RESOURCES = ['dashboard', 'shuls', 'applicants', 'cards', 'stores', 'seasons', 'forms', 'tasks', 'emails', 'sms', 'updates', 'documents', 'site_content', 'contract_settings', 'users', 'settings', 'audit'];

// Per-resource overrides to ROLE_DEFAULTS, applied only when the user has no
// explicit permissions row for that resource. Recent Actions is a full
// cross-entity activity feed with undo power — materially more sensitive
// than the "everything" ROLE_DEFAULTS.org_admin normally gets by default —
// so unlike every other resource, it stays denied for org_admin/staff until
// a specific user is explicitly granted it via Users & Permissions. This
// preserves the original hardcoded "super_admin only" behavior as the
// default while still making it a real, grantable permission.
const RESOURCE_DEFAULT_OVERRIDES = {
  audit: { can_view: 0, can_edit: 0, can_export: 0, hidden_fields: [], scope: 'all' },
};

// One user's can_view/can_edit/can_export/scope for every resource above —
// this IS the client's permission map (see auth.js). super_admin/org_admin
// get full access on everything without needing individual rows; a portal
// login (shul/store) only ever gets PORTAL_ALLOWED_RESOURCES below.
export function computePermissionMap(user) {
  const map = {};
  for (const resource of PERMISSION_RESOURCES) map[resource] = getPermission(user, resource);
  return map;
}

// ROLE_DEFAULTS above is a single flat object per role, not resource-aware —
// on its own it would hand a shul/store portal login can_view:1 on EVERY
// resource passed to requirePermission(), including ones that were never
// built with portal-scoped filtering (e.g. cards.js has no shul_id/store_id
// scoping at all, unlike applicants.js/shuls.js/stores.js which explicitly
// force the query down to the caller's own record for these roles). This is
// the allowlist of resources a portal login may ever get a "yes" on; every
// route in that list independently re-scopes to the caller's own record —
// this is only the coarse can-they-even-ask-about-this-resource gate.
// Anything not listed (cards, users, settings, forms, dashboard, emails,
// sms, tasks, updates, orgs, ...) is internal-team-only and denied outright,
// so a portal account hitting one of those routes 403s before any query runs
// — the same protection dashboard.js gets from requireAdmin, generalized to
// every current and future resource that reuses this middleware.
const PORTAL_ALLOWED_RESOURCES = { shul: ['shuls', 'applicants'], store: ['stores'] };

export function getPermission(user, resource) {
  if (user.role === 'super_admin') return { can_view: 1, can_edit: 1, can_export: 1, hidden_fields: [], scope: 'all' };
  if (user.role === 'shul' || user.role === 'store') {
    if (!(PORTAL_ALLOWED_RESOURCES[user.role] || []).includes(resource)) return PORTAL_DENIED;
    return ROLE_DEFAULTS[user.role];
  }
  const row = db.prepare('SELECT * FROM permissions WHERE user_id = ? AND resource = ?').get(user.id, resource);
  if (!row) return RESOURCE_DEFAULT_OVERRIDES[resource] || ROLE_DEFAULTS[user.role] || { can_view: 0, can_edit: 0, can_export: 0, hidden_fields: [], scope: 'assigned' };
  return { ...row, hidden_fields: JSON.parse(row.hidden_fields || '[]') };
}

// Route guard: 403s unless the user can at least view the resource.
export function requirePermission(resource, action = 'can_view') {
  return (req, res, next) => {
    const perm = getPermission(req.user, resource);
    if (!perm[action]) return res.status(403).json({ error: `You do not have ${action.replace('can_', '')} access to ${resource}` });
    req.permission = perm;
    next();
  };
}

// Strip hidden fields from a record (or array of records) before sending to the client.
export function redact(records, hiddenFields) {
  if (!hiddenFields || !hiddenFields.length) return records;
  const strip = (rec) => {
    const copy = { ...rec };
    for (const f of hiddenFields) delete copy[f];
    return copy;
  };
  return Array.isArray(records) ? records.map(strip) : strip(records);
}

// True if a scope='assigned' user is allowed to touch this specific entity.
export function isAssigned(userId, entityType, entityId) {
  return !!db.prepare('SELECT 1 FROM user_assignments WHERE user_id = ? AND entity_type = ? AND entity_id = ?')
    .get(userId, entityType, entityId);
}

export function assign(userId, entityType, entityId) {
  const exists = isAssigned(userId, entityType, entityId);
  if (!exists) db.prepare('INSERT INTO user_assignments (id, user_id, entity_type, entity_id) VALUES (?,?,?,?)')
    .run(uuid(), userId, entityType, entityId);
}

export function unassign(userId, entityType, entityId) {
  db.prepare('DELETE FROM user_assignments WHERE user_id = ? AND entity_type = ? AND entity_id = ?').run(userId, entityType, entityId);
}
