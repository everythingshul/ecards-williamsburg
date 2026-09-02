// Shared frontend helpers: auth/session, api() fetch wrapper, toast, sidebar, modal.
const API_BASE = '/api';

const Auth = {
  token() { return localStorage.getItem('ec_token'); },
  user() { try { return JSON.parse(localStorage.getItem('ec_user') || 'null'); } catch { return null; } },
  // permissions is the resource->{can_view,can_edit,can_export,scope} map
  // computed server-side at login/me (see routes/auth.js) — cached onto the
  // user object so Auth.can() below can check it synchronously, no per-page
  // fetch needed. Optional so existing call sites that don't have it yet
  // (or a stale cached user from before this existed) don't break.
  set(token, user, permissions) { localStorage.setItem('ec_token', token); localStorage.setItem('ec_user', JSON.stringify(permissions ? { ...user, permissions } : user)); },
  // Refreshes the cached user's permissions from the server in the
  // background — picks up a permission change an admin just made without
  // requiring the affected user to log out/in. Fire-and-forget; the CURRENT
  // page's nav already rendered from whatever was cached, so this only
  // affects the NEXT page load's nav.
  refreshPermissions() {
    if (!this.token()) return;
    fetch(API_BASE + '/auth/me', { headers: { Authorization: `Bearer ${this.token()}` } })
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data?.user) this.set(this.token(), data.user, data.permissions); })
      .catch(() => {});
  },
  logout() { localStorage.removeItem('ec_token'); localStorage.removeItem('ec_user'); location.href = '/login'; },
  requireAuth() { if (!this.token()) location.href = '/login'; },
  // Bounces away immediately if the signed-in role isn't one of `roles` —
  // e.g. a shul-portal login typing /admin/dashboard into the address
  // bar. This is a UX guard only: the role read here comes from localStorage
  // and every real data endpoint independently re-checks the actual role
  // server-side from the JWT on every request (see middleware/auth.js), so
  // there's nothing to gain by tampering with it client-side.
  requireRole(...roles) {
    this.requireAuth();
    if (!this.token()) return;
    const user = this.user();
    if (!user) return this.logout();
    if (!roles.includes(user.role)) {
      if (user.role === 'shul') location.href = '/shul-portal/dashboard';
      else if (user.role === 'store') location.href = '/store-portal/dashboard';
      else location.href = '/admin/dashboard';
    }
  },
  requireAdmin() { this.requireRole('staff', 'org_admin', 'super_admin'); },
  // Real check now (was a permanent-true stub) — drives which nav items even
  // render (see renderShell below), so a blocked section isn't just
  // unusable, it's not shown to exist at all. Every real data endpoint
  // still independently re-checks server-side (middleware/permissions.js's
  // requirePermission), so this is a UI-affordance layer on top of that,
  // not a replacement for it. No cached permissions yet (e.g. a stale
  // logged-in session from before this existed, or the split-second before
  // the first refreshPermissions() lands) fails OPEN — better than hiding
  // every admin page for someone who was already using them.
  can(resource, action = 'can_view') {
    const u = this.user();
    if (!u) return false;
    if (u.role === 'super_admin') return true;
    if (!u.permissions) return true;
    const perm = u.permissions[resource];
    return perm ? !!perm[action] : true;
  },
  // True if the user can(action) on ANY of the given resources — for a nav
  // item/page whose content spans more than one gated resource (e.g. the
  // Settings page's Seasons tab is its own 'seasons' resource, but the page
  // itself should still show up in nav for someone who only has 'settings').
  canAny(resources, action = 'can_view') {
    return resources.some(r => this.can(r, action));
  },
};

async function api(path, { method = 'GET', body, isForm = false } = {}) {
  const headers = {};
  const hadToken = !!Auth.token();
  if (Auth.token()) headers['Authorization'] = `Bearer ${Auth.token()}`;
  if (!isForm) headers['Content-Type'] = 'application/json';
  const res = await fetch(API_BASE + path, { method, headers, body: isForm ? body : (body ? JSON.stringify(body) : undefined) });
  let data = {};
  try { data = await res.json(); } catch {}
  // A 401 with no token attached (e.g. a failed /auth/login) is a real
  // credentials/permission error, not a stale session — surface the actual
  // server message instead of forcing a confusing "session expired" logout.
  if (res.status === 401) {
    if (hadToken) { Auth.logout(); throw new Error('Session expired'); }
    throw new Error(data.error || 'Not authenticated');
  }
  if (res.status === 423) { toast(data.error || 'Account paused', true); throw new Error(data.error); }
  if (!res.ok) { const err = new Error(data.error || `Request failed (${res.status})`); err.data = data; throw err; }
  return data;
}

// Authenticated file download — plain `location.href = '/api/...'` never
// sends the Authorization header (this app has no cookie session), so every
// protected download (CSV/XLSX exports, import templates) must go through
// this instead: fetch with the auth header, then save the blob.
async function downloadAuthed(path, fallbackFilename) {
  const headers = {};
  if (Auth.token()) headers['Authorization'] = `Bearer ${Auth.token()}`;
  const res = await fetch(API_BASE + path, { headers });
  if (res.status === 401) { Auth.logout(); return; }
  if (!res.ok) { let msg = `Download failed (${res.status})`; try { msg = (await res.json()).error || msg; } catch {} toast(msg, true); return; }
  const disposition = res.headers.get('Content-Disposition') || '';
  const match = disposition.match(/filename="([^"]+)"/);
  const filename = match ? match[1] : fallbackFilename;
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Fire-and-forget pageview beacon for the public site (home, apply forms,
// FAQ, contact, etc.) — powers the admin Analytics page. visitor_id is a
// random id kept in localStorage purely to tell "one visitor, several
// pageviews" apart from "several different visitors"; never sent anywhere
// but our own /api/analytics/pageview, and carries no other identifying
// information. Best-effort: never blocks or errors the page it's called from.
function trackPageview() {
  try {
    let vid = localStorage.getItem('ec_visitor_id');
    if (!vid) { vid = crypto.randomUUID(); localStorage.setItem('ec_visitor_id', vid); }
    api('/analytics/pageview', { method: 'POST', body: { path: location.pathname + location.search, referrer: document.referrer, visitor_id: vid } }).catch(() => {});
  } catch { /* analytics is best-effort, never block the page */ }
}

function toast(msg, isError = false) {
  let el = document.getElementById('toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; el.className = 'toast'; document.body.appendChild(el); }
  el.textContent = msg;
  el.className = 'toast show' + (isError ? ' error' : '');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 3500);
}

// Display label for a role — "staff" shows as "Admin" everywhere in the UI
// (the org's preferred term for that tier); the underlying value and every
// permission check stay exactly "staff" — nothing about what a staff
// account can or can't do changes, only what it's called.
function roleLabel(role) { return { staff: 'Admin', org_admin: 'Org Admin', super_admin: 'Super Admin', shul: 'Shul', store: 'Store' }[role] || role; }

// ESIGN Act / NY ESRA-style affirmative consent disclosure, shown before
// every e-signature submit button sitewide (sign-contract.html,
// sign-document.html, apply.html, apply-store.html,
// store-portal/onboarding.html) — one shared copy of the wording/markup so
// it only needs updating in one place, plus a matching required checkbox the
// signer must check before the sign endpoint (which independently rejects
// an unset `consent` server-side) will accept the request.
function esignConsentHtml(idPrefix) {
  return `<div class="small-muted" style="margin:14px 0;padding:10px;border:1px solid #ccc;border-radius:4px">
    <label class="checkbox-row" style="align-items:flex-start">
      <input type="checkbox" id="${idPrefix}-consent">
      <span>I consent to sign this document electronically and to conduct this transaction by electronic means. I understand my typed/drawn signature is legally binding, that I may request a paper copy of the signed document at any time by contacting the organization, and that I may withdraw this consent for future transactions by notifying the organization before signing.</span>
    </label>
  </div>`;
}
function esignConsentChecked(idPrefix) {
  const box = qs(`#${idPrefix}-consent`);
  if (box && !box.checked) { toast('Please check the box to consent to sign electronically', true); return false; }
  return true;
}
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function fmtMoney(n) { return '$' + (Number(n) || 0).toFixed(2); }
function fmtDate(d) { if (!d) return ''; return new Date(d.replace(' ', 'T') + (d.includes('Z') ? '' : 'Z')).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); }
function fmtDateTime(d) { if (!d) return ''; return new Date(d.replace(' ', 'T') + (d.includes('Z') ? '' : 'Z')).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }
function badge(text, cls) { return `<span class="badge badge-${esc(cls || text)}">${esc((text || '').replace(/_/g, ' '))}</span>`; }
function qs(sel) { return document.querySelector(sel); }
function qsa(sel) { return Array.from(document.querySelectorAll(sel)); }

// Settings > Organization's Primary/Accent Color pickers used to only reach
// outbound emails (services/mail.js's brandFor()) — the public site itself
// (theme.css) never read them, so changing them there visibly did nothing.
// Called on every public page (theme.css only — the logged-in portal keeps
// its own fixed navy/cyan palette from portal-theme.css on purpose, see
// CLAUDE.md's "two-palette theming") after fetching org from
// /orgs/resolve. Derives light/dark shades from the two picked colors the
// same way theme.css's own defaults relate (--brand-gold-light/-dark
// against --brand-gold, --brand-bg-2 against --brand-bg) so the whole page
// reads as one consistent palette instead of just the two literal swatches
// changing while every border/hover color stays the old default.
function hexToHsl(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return null;
  const r = parseInt(m[1].slice(0, 2), 16) / 255, g = parseInt(m[1].slice(2, 4), 16) / 255, b = parseInt(m[1].slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0; const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return [h * 360, s * 100, l * 100];
}
function hslToHex(h, s, l) {
  h /= 360; s /= 100; l /= 100;
  let r, g, b;
  if (s === 0) { r = g = b = l; }
  else {
    const hue2rgb = (p, q, t) => { if (t < 0) t += 1; if (t > 1) t -= 1; if (t < 1 / 6) return p + (q - p) * 6 * t; if (t < 1 / 2) return q; if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6; return p; };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3); g = hue2rgb(p, q, h); b = hue2rgb(p, q, h - 1 / 3);
  }
  const toHex = x => Math.round(Math.max(0, Math.min(1, x)) * 255).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}
function shadeHex(hex, deltaLightness) {
  const hsl = hexToHsl(hex);
  if (!hsl) return hex;
  return hslToHex(hsl[0], hsl[1], Math.max(0, Math.min(100, hsl[2] + deltaLightness)));
}
function applyOrgTheme(org) {
  if (!org) return;
  const root = document.documentElement.style;
  if (org.primary_color) {
    root.setProperty('--brand-bg', org.primary_color);
    root.setProperty('--brand-bg-2', shadeHex(org.primary_color, 4));
  }
  if (org.accent_color) {
    root.setProperty('--brand-gold', org.accent_color);
    root.setProperty('--brand-gold-light', shadeHex(org.accent_color, 15));
    root.setProperty('--brand-gold-dark', shadeHex(org.accent_color, -13));
  }
}

const NAV_ITEMS = [
  { href: '/admin/dashboard', label: 'Dashboard', icon: '&#9670;', resource: 'dashboard' },
  { href: '/admin/analytics', label: 'Analytics', icon: '&#9670;', resource: 'dashboard' },
  { href: '/admin/shuls', label: 'Shuls', icon: '&#9670;', resource: 'shuls' },
  { href: '/admin/applicants', label: 'Applicants', icon: '&#9670;', resource: 'applicants' },
  { href: '/admin/cards', label: 'Cards & Transactions', icon: '&#9670;', resource: 'cards' },
  { href: '/admin/stores', label: 'Stores', icon: '&#9670;', resource: 'stores' },
  { href: '/admin/tasks', label: 'Tasks', icon: '&#9670;', resource: 'tasks' },
  { href: '/admin/forms', label: 'Form Builder', icon: '&#9670;', resource: 'forms' },
  { href: '/admin/emails', label: 'Email Center', icon: '&#9670;', resource: 'emails' },
  { href: '/admin/sms', label: 'SMS Center', icon: '&#9670;', resource: 'sms' },
  { href: '/admin/updates', label: 'Updates', icon: '&#9670;', resource: 'updates' },
  { href: '/admin/esignatures', label: 'E-Signatures', icon: '&#9670;', resource: 'documents' },
  { href: '/admin/users', label: 'Users & Permissions', icon: '&#9670;', resource: 'users' },
  // Its own standalone page/nav item, not a Settings tab — a single link
  // shared between two independently-gated resources meant blocking just
  // 'settings' (or just 'seasons') never actually hid the link, since the
  // other permission alone kept it visible. Two separate resources, two
  // separate links.
  { href: '/admin/seasons', label: 'Seasons', icon: '&#9670;', resource: 'seasons' },
  { href: '/admin/site-content', label: 'Site Content', icon: '&#9670;', resource: 'site_content' },
  { href: '/admin/document-settings', label: 'Documents', icon: '&#9670;', resource: 'contract_settings' },
  { href: '/admin/settings', label: 'Settings', icon: '&#9670;', resource: 'settings' },
  // 'audit' has no ROLE_DEFAULTS entry of its own (see RESOURCE_DEFAULT_OVERRIDES
  // in middleware/permissions.js) — it's denied by default for everyone but
  // super_admin until an admin explicitly grants it to a specific user via
  // Users & Permissions, so no hardcoded role check is needed here anymore.
  { href: '/admin/audit', label: 'Recent Actions', icon: '&#9670;', resource: 'audit' },
];
const SHUL_NAV = [
  { href: '/shul-portal/dashboard', label: 'My Applicants' },
  { href: '/shul-portal/upload', label: 'Bulk Upload' },
  { href: '/shul-portal/shul-info', label: 'Shul Information' },
  { href: '/shul-portal/updates', label: 'Updates' },
];
const STORE_NAV = [
  { href: '/store-portal/dashboard', label: 'Overview' },
  { href: '/store-portal/billing', label: 'Billing' },
  { href: '/store-portal/updates', label: 'Updates' },
];

function renderShell(activeHref, contentHtml) {
  const user = Auth.user();
  const role = user?.role;
  let items = NAV_ITEMS.filter(i => (!i.roles || i.roles.includes(role)) && Auth.canAny(i.resources || [i.resource], 'can_view'));
  if (role === 'shul') items = SHUL_NAV;
  else if (role === 'store') items = STORE_NAV;
  else if (['staff', 'org_admin'].includes(role)) Auth.refreshPermissions(); // super_admin always has full access; skip the round-trip
  const navHtml = items.map(i => `<a href="${i.href}" class="${activeHref === i.href ? 'active' : ''}" title="${esc(i.label)}" data-href="${i.href}"><span class="nav-label">${esc(i.label)}</span></a>`).join('');
  document.body.innerHTML = `
    <div class="app-shell">
      <header class="app-header" id="app-header">
        <div class="brand"><img src="/img/org-logo.png" alt="Organization logo"><div class="brand-name">Kupes Hair Williamsburg<span>Platform</span></div></div>
        <button class="header-menu-btn" id="header-menu-btn" aria-label="Toggle menu">&#9776;</button>
        <nav id="header-nav">${navHtml}<div class="nav-more" id="nav-more"><button class="nav-more-btn" id="nav-more-btn" type="button">More &#9662;</button><div class="nav-more-dropdown" id="nav-more-dropdown"></div></div></nav>
        <div class="header-user">
          <span class="header-user-email">${esc(user?.email || '')}</span>
          <button onclick="Auth.logout()">Sign out</button>
        </div>
      </header>
      <div class="content" id="content">${contentHtml}</div>
    </div>`;
  qs('#header-menu-btn').addEventListener('click', () => qs('#header-nav').classList.toggle('open'));
  qs('#nav-more-btn').addEventListener('click', (e) => { e.stopPropagation(); qs('#nav-more-dropdown').classList.toggle('open'); });
  document.addEventListener('click', (e) => { const dd = qs('#nav-more-dropdown'); if (dd && dd.classList.contains('open') && !qs('#nav-more').contains(e.target)) dd.classList.remove('open'); });
  layoutNavOverflow();
  window.addEventListener('resize', debounce(layoutNavOverflow, 150));
  if (role === 'shul' || role === 'store') {
    api('/updates/inbox/unread-count').then(({ count }) => {
      if (!count) return;
      const link = document.querySelector('nav a[data-href$="/updates"]');
      if (link) link.querySelector('.nav-label').innerHTML += ` ${badge(String(count), 'active')}`;
      layoutNavOverflow();
    }).catch(() => {});
  }
  // Flags "Shul Information" in the nav whenever this shul's own record is
  // missing something the live shul application form now requires — the
  // same check that blocks applicant submission server-side (#147) — so a
  // shul carried into a new season notices before they even try to submit.
  if (role === 'shul') {
    api(`/shuls/${user.shul_id}`).then(({ missingInfo }) => {
      if (!missingInfo || !missingInfo.length) return;
      const link = document.querySelector('nav a[data-href$="/shul-info"]');
      if (link) link.querySelector('.nav-label').innerHTML += ` ${badge('!', 'rejected')}`;
      layoutNavOverflow();
    }).catch(() => {});
  }
  if (['staff', 'org_admin', 'super_admin'].includes(role)) {
    api('/dashboard/pending-counts').then(({ counts }) => {
      // A bare dot never told you HOW MANY were waiting — now the nav shows
      // the real count (#10). Counts are already scoped server-side to the
      // current season, so a dot here always means something actually
      // needs attention right now, not a record left over from a past,
      // long-closed season.
      const tally = (n) => `<span class="nav-tally">${n > 999 ? '999+' : n}</span>`;
      const pages = { shuls: 'shuls', applicants: 'applicants', stores: 'stores' };
      let changed = false;
      for (const [key, path] of Object.entries(pages)) {
        if (!counts[key]) continue;
        const link = document.querySelector(`nav a[data-href$="/${path}"]`);
        if (!link) continue;
        link.title = `${link.title} — ${counts[key]} pending`;
        link.querySelector('.nav-label').insertAdjacentHTML('beforeend', tally(counts[key]));
        changed = true;
      }
      if (changed) layoutNavOverflow();
    }).catch(() => {});
  }
}

// On the wide (non-hamburger) header layout, the nav row hides links that
// don't fit and collects them into a "More" dropdown instead of letting the
// nav scroll horizontally. Below the mobile breakpoint (see theme.css) the
// whole nav becomes a full-width vertical dropdown behind the hamburger
// button instead, so this is a no-op there — reset to "everything visible,
// no More button" so a resize back up to desktop width starts clean.
function layoutNavOverflow() {
  const nav = qs('#header-nav'); const moreWrap = qs('#nav-more'); const moreBtn = qs('#nav-more-btn'); const moreDropdown = qs('#nav-more-dropdown');
  if (!nav || !moreWrap) return;
  const links = qsa('#header-nav > a');
  links.forEach(a => { a.style.display = ''; });
  moreDropdown.classList.remove('open');
  moreDropdown.innerHTML = '';
  if (window.innerWidth <= 780) { moreWrap.style.display = 'none'; return; }
  moreWrap.style.display = 'inline-flex';
  const available = nav.clientWidth;
  const moreWidth = moreWrap.getBoundingClientRect().width;
  let usedWidth = 0;
  const overflowLinks = [];
  for (const a of links) {
    const w = a.getBoundingClientRect().width;
    if (usedWidth + w > available - moreWidth) overflowLinks.push(a);
    else usedWidth += w;
  }
  if (!overflowLinks.length) { moreWrap.style.display = 'none'; return; }
  moreDropdown.innerHTML = overflowLinks.map(a => a.outerHTML).join('');
  overflowLinks.forEach(a => { a.style.display = 'none'; });
  moreBtn.classList.toggle('active', overflowLinks.some(a => a.classList.contains('active')));
}
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

// Mirrors ROLE_RANK in routes/users.js — used client-side only to decide
// whether to show the "Set Password" button at all; the server independently
// re-checks the same ordering on every PUT /users/:id/set-password call.
const ROLE_RANK = { super_admin: 4, org_admin: 3, staff: 2, shul: 1, store: 1 };

// Opens a small "Set Password" modal for directly setting someone's login
// password (PUT /users/:id/set-password) instead of emailing them a reset
// link — only ever shown to callers whose own role outranks the target's
// (server re-checks this too; see ROLE_RANK in routes/users.js). Used from
// both Users & Permissions (internal staff) and the Shuls/Stores detail
// modals (portal accounts).
window.openSetPasswordModal = (userId, label) => {
  const body = `<p class="small-muted">Sets a new password for <strong>${esc(label)}</strong> immediately — they can sign in with it right away. This does not require them to click an email link.</p>
    <label>New Password <span class="req">*</span> <span class="small-muted">(at least 8 characters)</span></label>
    <input id="sp-password" type="password" autocomplete="new-password">`;
  openModal('Set Password', body, `<button class="btn btn-primary btn-sm" onclick="submitSetPassword('${userId}')">Set Password</button>`);
};
window.submitSetPassword = async (userId) => {
  const newPassword = qs('#sp-password').value;
  if (!newPassword || newPassword.length < 8) return toast('Password must be at least 8 characters', true);
  try {
    await api(`/users/${userId}/set-password`, { method: 'PUT', body: { newPassword } });
    toast('Password set');
    closeModal();
  } catch (err) { toast(err.message, true); }
};

// wide:true widens the modal (e.g. a table with a lot of columns, like the
// Form Builder responses view) instead of the default 900px cap.
function openModal(title, bodyHtml, footerHtml = '', { wide = false } = {}) {
  const el = document.createElement('div');
  el.className = 'modal-backdrop';
  el.id = 'ec-modal';
  el.innerHTML = `<div class="modal"${wide ? ' style="max-width:1400px"' : ''}>
    <div class="modal-header" style="cursor:move"><h3 style="margin:0" dir="auto">${esc(title)}</h3><button onclick="closeModal()">&times;</button></div>
    <div class="modal-body" dir="auto"${wide ? ' style="max-height:82vh"' : ''}>${bodyHtml}</div>
    ${footerHtml ? `<div class="modal-footer">${footerHtml}</div>` : ''}
  </div>`;
  el.addEventListener('click', (e) => { if (e.target === el) closeModal(); });
  document.body.appendChild(el);
  attachModalDrag(el.querySelector('.modal-header'), el.querySelector('.modal'));
}

// Drags the modal box by its header. The backdrop centers the box with flex,
// so a drag switches it to fixed positioning at its current on-screen spot
// (rather than fighting the centering) and moves it from there. The
// mousemove/mouseup listeners live only for the duration of one drag
// gesture (added on mousedown, removed on mouseup) so closing the modal
// mid-drag can't leave a stray document-level listener behind.
function attachModalDrag(header, box) {
  let startX, startY, startLeft, startTop;
  function onMove(e) {
    box.style.left = (startLeft + e.clientX - startX) + 'px';
    box.style.top = (startTop + e.clientY - startY) + 'px';
  }
  function onUp() {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  }
  header.addEventListener('mousedown', (e) => {
    if (e.target.closest('button')) return;
    const rect = box.getBoundingClientRect();
    box.style.position = 'fixed';
    box.style.margin = '0';
    box.style.left = rect.left + 'px';
    box.style.top = rect.top + 'px';
    startX = e.clientX; startY = e.clientY; startLeft = rect.left; startTop = rect.top;
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    e.preventDefault();
  });
}
function closeModal() { document.getElementById('ec-modal')?.remove(); }

// Minimal dependency-free rich text editor for composing HTML email/update
// bodies — a toolbar of execCommand actions over a contenteditable div, so
// admins don't have to hand-write HTML tags. Renders into `#${containerId}`
// and returns { getHtml, setHtml }. Images are inlined as base64 data URIs
// (no separate upload step needed for something this small).
function createRichTextEditor(containerId, initialHtml = '') {
  const container = document.getElementById(containerId);
  const editorId = containerId + '-surface';
  container.innerHTML = `
    <div class="rte-toolbar">
      <button type="button" data-cmd="bold" title="Bold"><strong>B</strong></button>
      <button type="button" data-cmd="italic" title="Italic"><em>I</em></button>
      <button type="button" data-cmd="underline" title="Underline"><u>U</u></button>
      <button type="button" data-cmd="formatBlock" data-arg="H3" title="Heading">H</button>
      <button type="button" data-cmd="insertUnorderedList" title="Bullet list">&bull; List</button>
      <button type="button" data-cmd="insertOrderedList" title="Numbered list">1. List</button>
      <button type="button" data-cmd="createLink" title="Link">Link</button>
      <button type="button" data-action="image" title="Insert image">Image</button>
      <button type="button" data-cmd="justifyLeft" title="Align left">&#8676;</button>
      <button type="button" data-cmd="justifyCenter" title="Align center">&#8596;</button>
      <button type="button" data-cmd="justifyRight" title="Align right">&#8677;</button>
      <button type="button" data-action="rtl" title="Right-to-left paragraph direction">RTL</button>
      <button type="button" data-cmd="removeFormat" title="Clear formatting">Clear</button>
      <input type="file" accept="image/*" class="rte-file-input" style="display:none">
    </div>
    <div id="${editorId}" class="rte-surface" contenteditable="true" dir="auto">${initialHtml || ''}</div>
  `;
  const surface = document.getElementById(editorId);
  container.querySelectorAll('.rte-toolbar button[data-cmd]').forEach(btn => {
    btn.addEventListener('click', () => {
      surface.focus();
      const cmd = btn.dataset.cmd;
      if (cmd === 'createLink') {
        const url = prompt('Link URL:', 'https://');
        if (url) document.execCommand(cmd, false, url);
      } else {
        document.execCommand(cmd, false, btn.dataset.arg || null);
      }
    });
  });
  // No execCommand exists for paragraph direction (unlike alignment above),
  // so this walks up from the selection to its nearest block-level element
  // and flips its dir attribute — ltr/unset -> rtl -> ltr on repeated
  // clicks. Falls back to the whole surface if the selection isn't inside
  // a recognized block (e.g. everything is still one bare text run).
  container.querySelector('button[data-action="rtl"]').addEventListener('click', () => {
    surface.focus();
    const sel = window.getSelection();
    let node = sel.rangeCount ? sel.getRangeAt(0).commonAncestorContainer : surface;
    if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
    while (node && node !== surface && !/^(P|DIV|H1|H2|H3|H4|H5|H6|LI|BLOCKQUOTE)$/.test(node.tagName || '')) node = node.parentElement;
    if (!node) node = surface;
    node.dir = node.dir === 'rtl' ? 'ltr' : 'rtl';
  });
  const fileInput = container.querySelector('.rte-file-input');
  container.querySelector('button[data-action="image"]').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => { surface.focus(); document.execCommand('insertImage', false, reader.result); };
    reader.readAsDataURL(file);
    fileInput.value = '';
  });
  return {
    getHtml: () => surface.innerHTML,
    setHtml: (html) => { surface.innerHTML = html || ''; },
  };
}

// Shared body renderer for an Update record — used by the portal inbox
// detail modal and the admin "View" modal alike. Images render inline as
// their own paragraph; non-image attachments (PDFs etc.) stay as links.
function renderUpdateBody(u) {
  const images = (u.attachments || []).filter(a => a.mime_type.startsWith('image/'));
  const files = (u.attachments || []).filter(a => !a.mime_type.startsWith('image/'));
  return `
    <p style="white-space:pre-wrap" dir="auto">${esc(u.body)}</p>
    ${images.map(a => `<p><img src="/uploads/updates/${esc(a.path)}" alt="${esc(a.filename)}" style="max-width:100%;height:auto;"></p>`).join('')}
    ${files.length ? `<p><strong>Attachments:</strong></p><ul>${files.map(a => `<li><a href="/uploads/updates/${esc(a.path)}" target="_blank">${esc(a.filename)}</a></li>`).join('')}</ul>` : ''}
  `;
}

// Shared "Updates" inbox renderer for the shul/store portal — both call this
// with their own container id. Unread updates are marked read as soon as
// they're opened in the detail modal.
async function loadUpdatesInbox(containerId) {
  const el = qs('#' + containerId);
  el.innerHTML = '<p class="small-muted">Loading…</p>';
  try {
    const { updates } = await api('/updates/inbox/mine');
    el.innerHTML = updates.length ? updates.map(u => `<div class="card" style="margin-bottom:10px;cursor:pointer" onclick="openInboxUpdate('${u.recipient_id}')">
        <div class="flex-between" dir="auto"><strong>${esc(u.title)}</strong>${u.read_at ? '' : badge('new','active')}</div>
        <p class="small-muted">${fmtDateTime(u.created_at)}</p>
      </div>`).join('') : '<p class="small-muted">No updates yet.</p>';
    window._inboxUpdates = updates;
  } catch (err) { el.innerHTML = `<p class="small-muted">${esc(err.message)}</p>`; }
}
window.openInboxUpdate = async (recipientId) => {
  const u = (window._inboxUpdates || []).find(x => x.recipient_id === recipientId);
  if (!u) return;
  openModal(u.title, renderUpdateBody(u));
  if (!u.read_at) { try { await api(`/updates/inbox/${recipientId}/read`, { method: 'POST' }); } catch {} }
};

// Fills a <select id="selectId"> with every season plus an "All Seasons"
// option, selects the currently active season by default, and returns its
// id (or '' if there is no active season yet) so the caller can seed its
// list-page filter state before the first load().
async function populateSeasonFilter(selectId) {
  try {
    const [{ seasons }, { season: active }] = await Promise.all([api('/seasons'), api('/seasons/active')]);
    const el = qs('#' + selectId);
    if (!el) return active?.id || '';
    el.innerHTML = `<option value="">All Seasons</option>` + seasons.map(s => `<option value="${s.id}" ${active && s.id === active.id ? 'selected' : ''}>${esc(s.name)}${active && s.id === active.id ? ' (active)' : ''}</option>`).join('');
    return active?.id || '';
  } catch { return ''; }
}

// Same idea as populateSeasonFilter above, for a "filter by shul" dropdown —
// unlike attachShulSelect (a single-select form field with a placeholder),
// this always leads with an "All Shuls" option since it's a list filter.
// seasonId scopes the list to that season's shuls (a shul is a fresh row
// every season) — pass it whenever the caller's own season filter has
// resolved, otherwise every shul that ever existed shows up in one flat,
// unscoped list. Re-callable: pass the same selectId again with a new
// seasonId (e.g. on a season-filter change) to repopulate in place, keeping
// whichever value is still valid in the new list selected.
async function populateShulFilter(selectId, seasonId = '') {
  try {
    const { shuls } = await api('/shuls/all-list' + (seasonId ? `?season_id=${encodeURIComponent(seasonId)}` : ''));
    const el = qs('#' + selectId);
    if (!el) return;
    const current = el.value;
    el.innerHTML = `<option value="">All Shuls</option>` + shuls.map(s => `<option value="${s.id}" ${s.id === current ? 'selected' : ''}>${esc(s.name_en)}</option>`).join('');
  } catch { /* leave the dropdown with just "All Shuls" if the list fails to load */ }
}

// Shared "View Other Seasons" popup for shul/applicant/store detail views.
// Shuls and applicants get a fresh record each season, so `endpoint` returns
// likely matches in other seasons by identifying field; stores are one
// persistent record, so their endpoint returns real per-season activity
// instead. Either shape renders fine here since both return a small array.
async function showOtherSeasons(entityLabel, endpoint, reopen) {
  try {
    const data = await api(endpoint);
    const rows = data.matches || data.seasons || [];
    const body = rows.length ? `<table><thead><tr><th>Season</th><th>${data.matches ? 'Status' : 'Activity'}</th><th></th></tr></thead><tbody>
      ${rows.map(r => data.matches
        ? `<tr><td>${esc(r.season_name || 'Unknown season')}</td><td>${badge(r.status || r.approval_status || '', r.status || r.approval_status || '')}</td>
             <td><button class="btn btn-sm btn-outline" onclick="closeModal(); ${reopen}('${r.id}')">Open</button></td></tr>`
        : `<tr><td>${esc(r.season_name || 'Unknown season')}</td><td>${r.txn_count} transaction(s), $${(+r.total_purchases).toFixed(2)} in purchases</td><td></td></tr>`
      ).join('')}</tbody></table>` : `<p class="small-muted">No other seasons found for this ${entityLabel} yet.</p>`;
    openModal(`${entityLabel}: Other Seasons`, body, `<button class="btn btn-outline btn-sm" onclick="closeModal()">Close</button>`);
  } catch (err) { toast(err.message, true); }
}

// Real <select> dropdown for picking a shul by name instead of pasting a
// raw ID or typing into a search box. `selectId` is the <select> element;
// its own value ends up being the selected shul's id — no separate hidden
// field needed. Pulls from the admin all-list endpoint so every shul (any
// status) is selectable, not just approved/public ones.
// seasonId, when passed, restricts the options to shuls in that season —
// an applicant's season is fixed at creation and the backend (PUT
// /applicants/:id) refuses a cross-season reassignment, so a caller editing
// an existing applicant should pass their current season_id here rather
// than let the admin pick a shul the save will just reject.
async function attachShulSelect(selectId, initialShulId = '', seasonId = '') {
  const select = document.getElementById(selectId);
  if (!select) return;
  try {
    const { shuls } = await api(`/shuls/all-list${seasonId ? `?season_id=${encodeURIComponent(seasonId)}` : ''}`);
    select.innerHTML = '<option value="">Select a shul…</option>' +
      shuls.map(s => `<option value="${s.id}">${esc(s.name_en)}${s.city ? ` (${esc(s.city)}, ${esc(s.state||'')})` : ''}</option>`).join('');
    if (initialShulId) select.value = initialShulId;
  } catch { /* leave the dropdown with just its placeholder if the list fails to load */ }
}

// Google Places address autocomplete — built on the new Places API's
// AutocompleteSuggestion/Place classes (google.maps.places.Autocomplete, the
// old widget, needs the legacy "Places API" enabled in addition to "Places
// API (New)"; this path only needs the latter). Implemented as a plain
// fetch-and-render dropdown rather than Google's PlaceAutocompleteElement
// custom element so the existing <input> stays a normal form field (name
// attribute, FormData collection, styling) instead of being replaced by a
// web component. Degrades gracefully — the input remains fully usable for
// manual entry if Places isn't available.
async function attachPlacesAutocomplete(inputId, fields) {
  const input = document.getElementById(inputId);
  if (!input) return;
  if (!window.google?.maps?.places?.AutocompleteSuggestion) { console.warn(`[places] Skipping autocomplete for #${inputId} — Google Places was not loaded (see earlier [places] warning for why).`); return; }
  const { AutocompleteSuggestion, AutocompleteSessionToken } = google.maps.places;
  let sessionToken = new AutocompleteSessionToken();
  let dropdown = null, debounceTimer = null, requestId = 0;

  // Wrap the input in a dedicated, tightly-fitting positioning context so
  // the dropdown always anchors directly under it — existing markup doesn't
  // consistently wrap inputs in their own div, so relying on some ancestor
  // element (e.g. the whole <form>) would misplace the dropdown.
  const wrap = document.createElement('div');
  wrap.style.position = 'relative';
  input.parentNode.insertBefore(wrap, input);
  wrap.appendChild(input);

  function closeDropdown() { dropdown?.remove(); dropdown = null; }

  function renderDropdown(suggestions) {
    closeDropdown();
    if (!suggestions.length) return;
    dropdown = document.createElement('div');
    dropdown.className = 'places-dropdown';
    for (const s of suggestions) {
      const pred = s.placePrediction;
      if (!pred) continue;
      const item = document.createElement('div');
      item.className = 'places-dropdown-item';
      item.textContent = pred.text?.text || '';
      item.addEventListener('mousedown', (e) => { e.preventDefault(); selectPrediction(pred); });
      dropdown.appendChild(item);
    }
    wrap.appendChild(dropdown);
  }

  async function selectPrediction(pred) {
    closeDropdown();
    input.value = pred.text?.text || input.value;
    try {
      const place = pred.toPlace();
      await place.fetchFields({ fields: ['addressComponents', 'location', 'id'] });
      const comps = place.addressComponents || [];
      const get = (type) => comps.find(c => c.types.includes(type))?.longText || '';
      const getShort = (type) => comps.find(c => c.types.includes(type))?.shortText || '';
      const streetNum = get('street_number'), route = get('route');
      if (fields.address) document.getElementById(fields.address).value = [streetNum, route].filter(Boolean).join(' ') || input.value;
      if (fields.city) document.getElementById(fields.city).value = get('locality') || get('sublocality') || get('postal_town');
      if (fields.state) document.getElementById(fields.state).value = getShort('administrative_area_level_1');
      if (fields.zip) document.getElementById(fields.zip).value = get('postal_code');
      if (fields.placeId) document.getElementById(fields.placeId).value = place.id || '';
      if (fields.lat) document.getElementById(fields.lat).value = place.location?.lat() ?? '';
      if (fields.lng) document.getElementById(fields.lng).value = place.location?.lng() ?? '';
    } catch (e) {
      console.error('[places] Could not fetch place details:', e.message);
    }
    sessionToken = new AutocompleteSessionToken(); // billing session ends at a completed selection
  }

  input.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    const query = input.value.trim();
    if (!query) { closeDropdown(); return; }
    debounceTimer = setTimeout(async () => {
      const thisRequest = ++requestId;
      try {
        const { suggestions } = await AutocompleteSuggestion.fetchAutocompleteSuggestions({ input: query, sessionToken });
        if (thisRequest !== requestId) return; // a newer keystroke already superseded this request
        renderDropdown(suggestions || []);
      } catch (e) { console.error('[places] suggestion fetch failed:', e.message); }
    }, 250);
  });
  input.addEventListener('blur', () => setTimeout(closeDropdown, 150));
  input.setAttribute('autocomplete', 'off');
}

async function loadGoogleMaps() {
  if (window.google?.maps) return;
  try {
    const { googleMapsApiKey } = await api('/config');
    if (!googleMapsApiKey) {
      // Silent by design for end users (the form stays fully usable without
      // autofill), but this is the #1 thing to check when someone reports
      // "address autocomplete isn't working": GOOGLE_MAPS_API_KEY is not set
      // as an env var on the server.
      console.warn('[places] Address autocomplete disabled: GOOGLE_MAPS_API_KEY is not set on the server.');
      return;
    }
    // Surfaces Google's own runtime errors (bad key, required APIs not
    // enabled, billing not enabled, referrer restrictions blocking this
    // domain) instead of failing silently.
    window.gm_authFailure = () => console.error('[places] Google Maps authentication failed — check that the API key is valid, unrestricted for this domain, and that "Places API (New)" is enabled with billing active in Google Cloud Console.');
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = `https://maps.googleapis.com/maps/api/js?key=${googleMapsApiKey}&libraries=places`;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Google Maps script failed to load (network error or invalid key)'));
      document.head.appendChild(s);
    });
    if (!window.google?.maps?.places) console.error('[places] Google Maps script loaded but google.maps.places is unavailable — the Places API may not be enabled for this key.');
  } catch (e) {
    console.error('[places] Address autocomplete unavailable:', e.message, '— forms remain fully usable manually.');
  }
}

// Quick "+ Add Task" flow usable from any detail modal (shul, applicant, ...).
// Linked to that record via entity_type/entity_id.
async function openQuickTaskModal(entityType, entityId, entityLabel) {
  let users = [];
  try { ({ users } = await api('/users')); } catch { /* non-admin viewers won't have access; button shouldn't be shown to them anyway */ }
  const options = `<option value="">Unassigned</option>` + users.filter(u => u.is_active).map(u => `<option value="${u.id}">${esc(u.first_name)} ${esc(u.last_name||'')}</option>`).join('');
  const body = `
    <p class="small-muted">Linked to ${esc(entityType)}: <strong>${esc(entityLabel)}</strong></p>
    <label>Title <span class="req">*</span></label><input id="qt-title">
    <label>Assign To</label><select id="qt-assigned_to">${options}</select>
    <label>Due Date</label><input type="date" id="qt-due_date" style="max-width:200px">`;
  openModal('Add Task', body, `<button class="btn btn-primary btn-sm" onclick="submitQuickTask('${entityType}','${entityId}')">Create Task</button>`);
}
window.openQuickTaskModal = openQuickTaskModal;
window.submitQuickTask = async (entityType, entityId) => {
  const title = document.getElementById('qt-title').value.trim();
  if (!title) return toast('Title is required', true);
  const body = { title, assigned_to: document.getElementById('qt-assigned_to').value || null, due_date: document.getElementById('qt-due_date').value || null, entity_type: entityType, entity_id: entityId };
  try { await api('/tasks', { method: 'POST', body }); toast('Task created'); closeModal(); } catch (err) { toast(err.message, true); }
};

// Side-by-side field comparison table for duplicate review (shuls & applicants).
// fields: [[key, label], ...]. Differing values get a highlighted background.
function renderCompareTable(fields, a, b) {
  const rows = fields.map(([key, label]) => {
    const av = a?.[key], bv = b?.[key];
    const differs = String(av ?? '') !== String(bv ?? '');
    const cellStyle = differs ? 'background:#f9efe0' : '';
    return `<tr><td class="small-muted" style="white-space:nowrap">${esc(label)}</td><td style="${cellStyle}">${esc(av ?? '')}</td><td style="${cellStyle}">${esc(bv ?? '')}</td></tr>`;
  }).join('');
  return `<div style="overflow-x:auto"><table>
    <thead><tr><th></th><th>Record A <span class="small-muted">(${fmtDate(a?.created_at)})</span></th><th>Record B <span class="small-muted">(${fmtDate(b?.created_at)})</span></th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

// Where to send a just-logged-in store user — onboarding wizard until they've
// completed all 3 steps, dashboard after.
async function storeLandingUrl(user) {
  try {
    const { store } = await api(`/stores/${user.store_id}`);
    return (store.onboarding_step || 0) >= 3 ? '/store-portal/dashboard' : '/store-portal/onboarding';
  } catch { return '/store-portal/dashboard'; }
}

// Authenticated PDF view (opens in a new tab instead of forcing a download) —
// same auth-header requirement as downloadAuthed above.
async function viewAuthed(path) {
  const headers = {};
  if (Auth.token()) headers['Authorization'] = `Bearer ${Auth.token()}`;
  const res = await fetch(API_BASE + path, { headers });
  if (res.status === 401) { Auth.logout(); return; }
  if (!res.ok) { toast('Could not load PDF', true); return; }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank');
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// Same fetch-with-auth-header pattern as downloadAuthed/viewAuthed, but
// returns the raw bytes for feeding into pdf.js instead of saving/opening
// the file — used by the signature-box placement editor to render the
// actual document as a canvas background. Throws on failure; caller decides
// how to degrade (the editor still works with just proportioned boxes if
// this fails).
async function fetchAuthedBytes(path) {
  const headers = {};
  if (Auth.token()) headers['Authorization'] = `Bearer ${Auth.token()}`;
  const res = await fetch(API_BASE + path, { headers });
  if (res.status === 401) { Auth.logout(); throw new Error('Session expired'); }
  if (!res.ok) throw new Error(`Could not load document (${res.status})`);
  return res.arrayBuffer();
}

// Lazily loads pdf.js — vendored under /js/vendor/pdfjs (not a CDN: same
// origin means no dependency on a third party's uptime, and nothing extra
// to allow through a future CSP) — only the signature-box placement editor
// needs it, so it's not worth bundling into every page load. Memoized so
// repeated opens of the editor don't re-fetch it.
let pdfJsPromise = null;
function loadPdfJs() {
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  if (pdfJsPromise) return pdfJsPromise;
  pdfJsPromise = import('/js/vendor/pdfjs/pdf.min.mjs')
    .then((pdfjsLib) => {
      pdfjsLib.GlobalWorkerOptions.workerSrc = '/js/vendor/pdfjs/pdf.worker.min.mjs';
      window.pdfjsLib = pdfjsLib;
      return pdfjsLib;
    })
    .catch((e) => { pdfJsPromise = null; throw e; });
  return pdfJsPromise;
}

// Generic per-entity Documents tab (applicants & stores) — list existing
// documents, generate new ones, and send a signing link either to the
// record's own email on file or to any other recipient (so a specific
// document can be routed to a specific person). The signee always gets an
// emailed link; see routes/documents.js.
async function loadDocumentsTab(entityType, entityId, containerId, defaultEmail) {
  const container = qs('#' + containerId);
  container.innerHTML = '<p class="small-muted">Loading…</p>';
  const safeEmail = esc(defaultEmail || '').replace(/'/g, "\\'");
  try {
    const { documents } = await api(`/documents?entity_type=${entityType}&entity_id=${entityId}`);
    container.innerHTML = `
      <div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;margin-bottom:14px">
        <div style="flex:1;min-width:160px"><label style="margin-top:0">New Document Title</label><input id="doc-title-${entityType}-${entityId}" placeholder="e.g. Agreement"></div>
        <button class="btn btn-sm btn-primary" onclick="generateDocument('${entityType}','${entityId}','${containerId}','${safeEmail}')">Generate New Document</button>
      </div>
      ${documents.length ? documents.map(d => documentRowHtml(d, entityType, entityId, containerId, defaultEmail)).join('') : '<p class="small-muted">No documents yet.</p>'}
    `;
  } catch (err) { container.innerHTML = `<p class="small-muted">${esc(err.message)}</p>`; }
}
function documentRowHtml(d, entityType, entityId, containerId, defaultEmail) {
  const inputId = `doc-email-${d.id}`;
  const safeEmail = esc(defaultEmail || '').replace(/'/g, "\\'");
  const canAct = d.status !== 'signed' && d.status !== 'void';
  return `<div class="card" style="margin-bottom:10px">
    <div class="flex-between"><strong>${esc(d.title || 'Agreement')}</strong>${badge(d.status, d.status)}</div>
    <p class="small-muted">Created ${fmtDateTime(d.created_at)}${d.sent_at ? ' · Sent ' + fmtDateTime(d.sent_at) : ''}${d.signed_at ? ' · Signed ' + fmtDateTime(d.signed_at) + ' by ' + esc(d.signer_name || '') : ''}</p>
    ${canAct ? `<div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;margin-top:8px">
      <div style="flex:1;min-width:180px"><label style="margin-top:0">Send To</label><input id="${inputId}" value="${esc(defaultEmail || '')}" placeholder="email address"></div>
      <button class="btn btn-sm btn-primary" onclick="sendDocument('${d.id}','${inputId}','${entityType}','${entityId}','${containerId}','${safeEmail}')">${d.status === 'sent' ? 'Resend' : 'Send'}</button>
    </div>` : ''}
    <div style="margin-top:8px;display:flex;gap:8px">
      <button class="btn btn-sm btn-outline" onclick="viewDocumentPdf('${d.id}')">View PDF</button>
      ${canAct ? `<button class="btn btn-sm btn-outline" onclick="voidDocument('${d.id}','${entityType}','${entityId}','${containerId}','${safeEmail}')">Void</button>` : ''}
      ${d.status === 'signed' ? `<button class="btn btn-sm btn-outline" onclick="retractDocumentSignature('${d.id}','${entityType}','${entityId}','${containerId}','${safeEmail}')">Retract Signature</button>` : ''}
    </div>
  </div>`;
}
window.generateDocument = async (entityType, entityId, containerId, defaultEmail) => {
  const titleInput = qs(`#doc-title-${entityType}-${entityId}`);
  const title = titleInput ? titleInput.value.trim() : '';
  try {
    await api('/documents/generate', { method: 'POST', body: { entity_type: entityType, entity_id: entityId, title } });
    toast('Document generated');
    loadDocumentsTab(entityType, entityId, containerId, defaultEmail);
  } catch (err) { toast(err.message, true); }
};
window.sendDocument = async (docId, inputId, entityType, entityId, containerId, defaultEmail) => {
  const email = qs('#' + inputId).value.trim();
  try {
    const r = await api(`/documents/${docId}/send`, { method: 'POST', body: email ? { email } : {} });
    toast(r.emailError ? `Link created, but email failed: ${r.emailError}` : `Sent to ${email || 'their email on file'}`, !!r.emailError);
    loadDocumentsTab(entityType, entityId, containerId, defaultEmail);
  } catch (err) { toast(err.message, true); }
};
window.voidDocument = async (docId, entityType, entityId, containerId, defaultEmail) => {
  if (!confirm('Void this document?')) return;
  try { await api(`/documents/${docId}/void`, { method: 'POST' }); toast('Voided'); loadDocumentsTab(entityType, entityId, containerId, defaultEmail); } catch (err) { toast(err.message, true); }
};
window.retractDocumentSignature = async (docId, entityType, entityId, containerId, defaultEmail) => {
  if (!confirm('Retract this signature? The document will go back to unsigned and can be signed again.')) return;
  try { await api(`/documents/${docId}/retract`, { method: 'POST' }); toast('Signature retracted'); loadDocumentsTab(entityType, entityId, containerId, defaultEmail); } catch (err) { toast(err.message, true); }
};
window.viewDocumentPdf = (docId) => viewAuthed(`/documents/${docId}/pdf`);

// {{variable}} names filled in automatically when sending from a specific
// applicant/shul profile — same substitution style as the Email/SMS Center's
// own POST /send (routes/emails.js, routes/sms.js), done client-side here
// since the quick-send box already has the live entity record in hand.
// Exported by name so the Template editors (Email Center / SMS Center) can
// show admins what's available while building a template (see emailVarsHint/
// wireQuickSendTemplate below), without duplicating this list.
const ENTITY_TEMPLATE_VARS = {
  applicant: [['first_name', 'First Name'], ['last_name', 'Last Name'], ['shul_name', 'Shul Name'], ['email', 'Email'], ['external_id', 'Applicant ID']],
  shul: [['name', 'Shul Name'], ['rav_first_name', 'Rav First Name'], ['rav_last_name', 'Rav Last Name'], ['gabai_first_name', 'Gabai First Name'], ['gabai_last_name', 'Gabai Last Name'], ['email', 'Gabai Email']],
};
function buildEntityVariables(entityType, entity) {
  if (!entity) return {};
  if (entityType === 'applicant') return { first_name: entity.first_name || '', last_name: entity.last_name || '', shul_name: entity.shul_name || '', email: entity.email || '', external_id: entity.external_id || '' };
  if (entityType === 'shul') return { name: entity.name_en || '', rav_first_name: entity.ruv_first_name || '', rav_last_name: entity.ruv_last_name || '', gabai_first_name: entity.gabai_first_name || '', gabai_last_name: entity.gabai_last_name || '', email: entity.gabai_email || '' };
  return {};
}
function substituteVars(text, vars) { return String(text || '').replace(/\{\{(\w+)\}\}/g, (m, key) => (vars && vars[key] != null ? vars[key] : m)); }
function varsHintHtml(entityType, vars) {
  return ENTITY_TEMPLATE_VARS[entityType].map(([key, label]) => `<code title="${esc(label)}">{{${key}}}</code>${vars[key] ? ` → ${esc(vars[key])}` : ''}`).join('&nbsp;&nbsp;');
}

// Shared "who edited this record" tab for applicant/shul/store detail modals.
// entityType is 'applicant', 'shul', or 'store' — the route prefix is just
// that plus 's'. Backed by audit_log via GET /:type/:id/history (admin-only,
// same gate as the entity detail fetch itself).
async function loadHistoryTab(entityType, entityId, containerId) {
  const container = qs('#' + containerId);
  container.innerHTML = '<p class="small-muted">Loading…</p>';
  try {
    const { history } = await api(`/${entityType}s/${entityId}/history`);
    container.innerHTML = history.length ? history.map(h => {
      const who = h.userName ? esc(h.userName) : '<span class="small-muted">System</span>';
      const what = h.action === 'update' && h.changedFields.length
        ? `Updated ${h.changedFields.map(esc).join(', ')}`
        : h.action.charAt(0).toUpperCase() + h.action.slice(1).replace(/_/g, ' ');
      return `<div class="card" style="padding:10px 14px;margin-bottom:8px">
        <div class="flex-between"><span>${what}</span><span class="small-muted">${fmtDateTime(h.created_at)}</span></div>
        <p class="small-muted" style="margin:4px 0 0">by ${who}</p>
      </div>`;
    }).join('') : '<p class="small-muted">No history yet.</p>';
  } catch (err) { container.innerHTML = `<p class="small-muted">${esc(err.message)}</p>`; }
}

// Shared SMS+Email history/quick-send tab for applicant & shul detail modals.
// entityType is 'applicant' or 'shul' — the route prefix is just that plus 's'.
// `entity` is the full record already fetched by the caller (openApplicant's
// `a` / openShul's `shul`) — used only to fill in {{variables}} when a
// template is picked, so it's optional and everything else still works
// without it.
async function loadMessagesTab(entityType, entityId, containerId, defaultPhone, defaultEmail, entity) {
  const container = qs('#' + containerId);
  container.innerHTML = '<p class="small-muted">Loading…</p>';
  const prefix = `/${entityType}s/${entityId}`;
  const safePhone = esc(defaultPhone || '').replace(/'/g, "\\'");
  const safeEmail = esc(defaultEmail || '').replace(/'/g, "\\'");
  // Reload-after-send calls (sendQuickSms/sendQuickEmail below) don't have
  // the entity record handy, so fall back to what the first load cached.
  entity = entity || window.__msgTemplates?.[entityId]?.entity;
  const vars = buildEntityVariables(entityType, entity);
  try {
    const [{ sms, emails }, smsTemplates, emailTemplates] = await Promise.all([
      api(`${prefix}/messages`),
      api('/sms/templates/all').then(r => r.templates).catch(() => []),
      api('/emails/templates/all').then(r => r.templates).catch(() => []),
    ]);
    window.__msgTemplates = window.__msgTemplates || {};
    window.__msgTemplates[entityId] = { sms: smsTemplates, email: emailTemplates, vars, entity };
    const smsTemplateOptions = `<option value="">No template — write your own</option>` + smsTemplates.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('');
    const emailTemplateOptions = `<option value="">No template — write your own</option>` + emailTemplates.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('');
    container.innerHTML = `
      <div class="card" style="margin-bottom:14px">
        <strong>Send SMS</strong>
        <div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;margin-top:8px">
          <div style="flex:1;min-width:140px"><label style="margin-top:0">To</label><input id="msg-sms-to-${entityId}" value="${esc(defaultPhone || '')}" placeholder="phone number"></div>
        </div>
        ${smsTemplates.length ? `<label>Use Template</label><select id="msg-sms-template-${entityId}" onchange="applyQuickSendTemplate('sms','${entityType}','${entityId}')">${smsTemplateOptions}</select>` : ''}
        <label>Message</label><textarea id="msg-sms-body-${entityId}" rows="2" placeholder="Type a message…"></textarea>
        <p class="small-muted" style="margin-top:4px">Available variables: ${varsHintHtml(entityType, vars)}</p>
        <button class="btn btn-sm btn-primary" style="margin-top:8px" onclick="sendQuickSms('${entityType}','${entityId}','${containerId}','${safePhone}','${safeEmail}')">Send SMS</button>
      </div>
      <div style="margin-bottom:16px">${sms.length ? sms.map(m => `<div style="padding:8px 0;border-bottom:1px solid var(--border)">
          <div class="flex-between"><strong>${esc(m.phone)}</strong>${badge(m.status, m.status)}</div>
          <div>${esc(m.body || '')}</div>
          <div class="small-muted">${fmtDateTime(m.created_at)}${m.error_message ? ' · ' + esc(m.error_message) : ''}</div>
        </div>`).join('') : '<p class="small-muted">No SMS messages yet.</p>'}</div>
      <div class="divider"></div>
      <div class="card" style="margin:14px 0">
        <strong>Send Email</strong>
        <div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;margin-top:8px">
          <div style="flex:1;min-width:160px"><label style="margin-top:0">To</label><input id="msg-email-to-${entityId}" value="${esc(defaultEmail || '')}" placeholder="email address"></div>
        </div>
        ${emailTemplates.length ? `<label>Use Template</label><select id="msg-email-template-${entityId}" onchange="applyQuickSendTemplate('email','${entityType}','${entityId}')">${emailTemplateOptions}</select>` : ''}
        <label>Subject</label><input id="msg-email-subject-${entityId}" placeholder="Subject">
        <label>Message</label><div id="msg-email-body-${entityId}"></div>
        <p class="small-muted" style="margin-top:4px">Available variables: ${varsHintHtml(entityType, vars)}</p>
        <button class="btn btn-sm btn-primary" style="margin-top:8px" onclick="sendQuickEmail('${entityType}','${entityId}','${containerId}','${safePhone}','${safeEmail}')">Send Email</button>
      </div>
      <div>${emails.length ? emails.map(m => `<div style="padding:8px 0;border-bottom:1px solid var(--border)">
          <div class="flex-between"><strong>${esc(m.to_email)}</strong>${badge(m.status, m.status)}</div>
          <div>${esc(m.subject || '')}</div>
          <div class="small-muted">${fmtDateTime(m.created_at)}${m.error_message ? ' · ' + esc(m.error_message) : ''}</div>
        </div>`).join('') : '<p class="small-muted">No emails sent yet.</p>'}</div>
    `;
    window.__msgEmailEditors = window.__msgEmailEditors || {};
    window.__msgEmailEditors[entityId] = createRichTextEditor(`msg-email-body-${entityId}`);
  } catch (err) { container.innerHTML = `<p class="small-muted">${esc(err.message)}</p>`; }
}
window.applyQuickSendTemplate = (kind, entityType, entityId) => {
  const store = window.__msgTemplates?.[entityId];
  if (!store) return;
  if (kind === 'sms') {
    const t = store.sms.find(x => x.id === qs(`#msg-sms-template-${entityId}`).value);
    qs(`#msg-sms-body-${entityId}`).value = t ? substituteVars(t.body, store.vars) : '';
  } else {
    const t = store.email.find(x => x.id === qs(`#msg-email-template-${entityId}`).value);
    qs(`#msg-email-subject-${entityId}`).value = t ? substituteVars(t.subject, store.vars) : '';
    window.__msgEmailEditors?.[entityId]?.setHtml(t ? substituteVars(t.body_html, store.vars) : '');
  }
};
window.sendQuickSms = async (entityType, entityId, containerId, defaultPhone, defaultEmail) => {
  const to = qs(`#msg-sms-to-${entityId}`).value.trim();
  const body = qs(`#msg-sms-body-${entityId}`).value.trim();
  if (!body) return toast('Enter a message', true);
  try {
    const r = await api(`/${entityType}s/${entityId}/send-sms`, { method: 'POST', body: { to, body } });
    toast(r.emailError ? `SMS failed: ${r.emailError}` : 'SMS sent', !!r.emailError);
    loadMessagesTab(entityType, entityId, containerId, defaultPhone, defaultEmail);
  } catch (err) { toast(err.message, true); }
};
window.sendQuickEmail = async (entityType, entityId, containerId, defaultPhone, defaultEmail) => {
  const to = qs(`#msg-email-to-${entityId}`).value.trim();
  const subject = qs(`#msg-email-subject-${entityId}`).value.trim();
  const body = window.__msgEmailEditors?.[entityId]?.getHtml().trim() || '';
  if (!subject || !body) return toast('Enter a subject and message', true);
  try {
    const r = await api(`/${entityType}s/${entityId}/send-email`, { method: 'POST', body: { to, subject, body } });
    toast(r.emailError ? `Email failed: ${r.emailError}` : 'Email sent', !!r.emailError);
    loadMessagesTab(entityType, entityId, containerId, defaultPhone, defaultEmail);
  } catch (err) { toast(err.message, true); }
};

// Injects the same admin-configured header/footer nav that the homepage
// renders directly, onto every other public-facing page (login, apply
// forms, FAQ, contact, sign-*, forms, invite/reset flows). Prepends a slim
// nav strip and appends a footer with the org's footer buttons + the
// everythingshul mark. Both fall back to the same defaults as the homepage
// when the admin hasn't customized them, so a fresh org looks right without
// any setup, and both are just extra flex/flow children — safe to add to
// any page's <body> regardless of that page's own layout.
async function renderPublicFooter() {
  try {
    const { content } = await api('/orgs/resolve');
    const headerBtns = content?.headerButtons?.length ? content.headerButtons : [{ label: 'Sign In', url: '/login' }];
    const footerBtns = content?.footerButtons?.length ? content.footerButtons : [
      { label: 'Register a Shul', url: '/apply' }, { label: 'Apply as a Store', url: '/apply-store' },
      { label: 'Ezras Habayis Application', url: '/apply-ezras-habayis' }, { label: 'FAQ', url: '/faq' },
      { label: 'Contact Us', url: '/contact' }, { label: 'Sign In', url: '/login' },
    ];

    const nav = document.createElement('nav');
    nav.className = 'public-nav-strip';
    nav.innerHTML = headerBtns.map(b => `<a href="${esc(b.url)}">${esc(b.label)}</a>`).join('');
    document.body.insertBefore(nav, document.body.firstChild);

    const foot = document.createElement('footer');
    foot.className = 'public-footer-strip';
    foot.innerHTML = `<div class="foot-links">${footerBtns.map(b => `<a href="${esc(b.url)}">${esc(b.label)}</a>`).join('')}</div>
      <a class="powered-by" href="https://everythingshul.com" target="_blank" rel="noopener">Powered By <img src="/img/everythingshul-logo.png" alt="everythingshul"></a>`;
    document.body.appendChild(foot);
  } catch { /* best-effort — the page underneath still works without it */ }
}

// Polls a list endpoint's row count (for whatever filters/search/page the
// caller's own load() would currently use) and, if it changed, shows a
// small dismiss-to-refresh banner instead of silently rewriting the table.
// This is the whole point: another admin adding/removing a record must
// never yank anyone else's scroll position, open filters, or row selection
// out from under them — so nothing on screen changes until the viewer
// actually clicks the banner, which just calls their page's own load().
// Paused while the tab is hidden (nothing to disrupt if no one's looking).
function attachLiveRefresh(bannerContainerId, fetchTotal, loadFn, intervalMs = 15000) {
  let knownTotal = null;
  let bannerShown = false;
  async function check() {
    if (bannerShown || document.hidden) return;
    try {
      const total = await fetchTotal();
      if (knownTotal === null) { knownTotal = total; return; }
      if (total !== knownTotal) {
        bannerShown = true;
        const container = document.getElementById(bannerContainerId);
        if (!container) return;
        const banner = document.createElement('div');
        banner.className = 'card';
        banner.style.cssText = 'margin-bottom:14px;background:var(--brand-panel-2);cursor:pointer;text-align:center;padding:10px 16px;font-size:13px;';
        banner.textContent = 'New data is available — click to refresh this list';
        banner.onclick = () => { banner.remove(); bannerShown = false; knownTotal = null; loadFn(); };
        container.prepend(banner);
      }
    } catch { /* transient network hiccup — just try again next tick */ }
  }
  setInterval(check, intervalMs);
}

// Lets an admin choose which columns show in a list view, and in what
// order, persisted to their own account (routes/preferences.js) — follows
// them across devices/browsers, not just this one. `columns` is the full
// available set [{key,label}]; `storageKey` picks which saved preference to
// load/save (e.g. 'columns_applicants'); `defaultOrder` is the fallback
// list of visible column keys when nothing's been saved yet. Wires a
// "Customize Columns" button (by id) to open the editor; `onChange(order)`
// is called with the new visible-column-keys array whenever it's saved.
// Returns a promise resolving to the currently-effective order, so the
// caller's first render can use it immediately rather than waiting on a
// separate callback.
async function attachColumnCustomizer(buttonId, storageKey, columns, defaultOrder, onChange) {
  let order = defaultOrder;
  try {
    const { value } = await api(`/preferences/${storageKey}`);
    if (Array.isArray(value) && value.length) order = value.filter(k => columns.some(c => c.key === k));
  } catch { /* use default */ }

  let draft = null;
  function renderList() {
    if (!draft) draft = [...order, ...columns.map(c => c.key).filter(k => !order.includes(k))];
    qs('#col-customizer-list').innerHTML = draft.map((key, i) => {
      const col = columns.find(c => c.key === key);
      const visible = order.includes(key);
      return `<div class="card" style="margin:6px 0;padding:8px 12px;display:flex;align-items:center;gap:10px">
        <label class="checkbox-row" style="flex:1;margin:0"><input type="checkbox" ${visible ? 'checked' : ''} onchange="window.__toggleCustomCol('${key}')"> ${esc(col.label)}</label>
        <button type="button" class="btn btn-sm btn-outline" onclick="window.__moveCustomCol('${key}',-1)" ${i === 0 ? 'disabled' : ''}>&uarr;</button>
        <button type="button" class="btn btn-sm btn-outline" onclick="window.__moveCustomCol('${key}',1)" ${i === draft.length - 1 ? 'disabled' : ''}>&darr;</button>
      </div>`;
    }).join('');
  }
  window.__toggleCustomCol = (key) => {
    if (order.includes(key)) order = order.filter(k => k !== key);
    else { order.push(key); order = draft.filter(k => order.includes(k)); }
    renderList();
  };
  window.__moveCustomCol = (key, dir) => {
    const i = draft.indexOf(key), j = i + dir;
    if (j < 0 || j >= draft.length) return;
    [draft[i], draft[j]] = [draft[j], draft[i]];
    order = draft.filter(k => order.includes(k));
    renderList();
  };
  window.__saveCustomCols = async () => {
    try { await api(`/preferences/${storageKey}`, { method: 'PUT', body: { value: order } }); closeModal(); onChange(order); } catch (err) { toast(err.message, true); }
  };

  const btn = document.getElementById(buttonId);
  if (btn) btn.addEventListener('click', () => {
    draft = null;
    openModal('Customize Columns', `<p class="small-muted">Choose which columns to show, and use the arrows to reorder them.</p><div id="col-customizer-list"></div>`,
      `<button class="btn btn-primary btn-sm" onclick="window.__saveCustomCols()">Save</button>`);
    renderList();
  });
  return order;
}

// Renders one form-builder field as public-facing HTML — shared by
// form.html (custom slug-based forms) and the four built-in flows
// (apply.html/apply-store.html/apply-ezras-habayis.html, shul-portal
// dashboard/shul-info), whether the field array came from a real Form
// Builder schema or one of the fixed arrays in utils/builtinSchemas.js
// (fetched via loadBuiltinSchema below). Every real input also gets id=key
// alongside name=key so page-specific wiring (Google Places autocomplete on
// address/city/state/zip, for one) can still target known field keys
// directly. expectedAnswer (Form Builder: "Expected Answer") never reaches
// here in the first place — routes/forms.js strips it before any public
// response — so there's nothing to accidentally leak by rendering fields
// verbatim. shulOptions is only used for the special shul_id field on a
// custom Applicant Application form; pass [] anywhere else.
// f.align ('center'/'right', default left/unset) — whitelisted rather than
// escaped since it lands directly in a CSS declaration, not an HTML
// attribute. Wraps the whole field block (label + input) so it shifts as a
// unit; also applied to the input/select/textarea itself so typed/selected
// text visibly shifts too, since inputs are full-width (theme.css) and
// alignment on the wrapper alone wouldn't otherwise be visible. Checkbox
// rows are flex layout, so alignment there maps to justify-content instead.
function fieldHtml(f, shulOptions = []) {
  const align = ['center', 'right'].includes(f.align) ? f.align : null;
  const wrapStyle = align ? ` style="text-align:${align}"` : '';
  const inputStyle = align ? ` style="text-align:${align}"` : '';
  const wrap = (inner) => align ? `<div${wrapStyle}>${inner}</div>` : inner;
  if (f.type === 'header') return wrap(`<h3 style="margin-top:22px">${esc(f.label || '')}</h3>`);
  if (f.type === 'image') return f.url ? wrap(`<img src="${esc(f.url)}" alt="${esc(f.label||'')}" style="max-width:100%;height:auto;margin:14px 0;border-radius:8px">`) : '';
  const req = f.required ? 'required' : '';
  const label = `<label>${esc(f.label || f.key)} ${f.required ? '<span class="req">*</span>' : ''}</label>`;
  if (f.key === 'shul_id') return wrap(`${label}<select name="shul_id" id="shul_id" ${req}${inputStyle}><option value="">Select your shul…</option>${shulOptions.map(s => `<option value="${s.id}">${esc(s.name_en)}</option>`).join('')}</select>`);
  if (f.type === 'select') return wrap(`${label}<select name="${esc(f.key)}" id="${esc(f.key)}" ${req}${inputStyle}><option value=""></option>${(f.options||[]).map(o => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('')}</select>`);
  if (f.type === 'textarea') return wrap(`${label}<textarea name="${esc(f.key)}" id="${esc(f.key)}" ${req}${inputStyle}></textarea>`);
  if (f.type === 'checkbox') {
    const justify = align === 'center' ? 'center' : align === 'right' ? 'flex-end' : 'flex-start';
    return `<div class="checkbox-row" style="margin-top:14px;justify-content:${justify}"><input type="checkbox" name="${esc(f.key)}" id="${esc(f.key)}" ${req}><label style="margin:0" for="${esc(f.key)}">${esc(f.label||f.key)}${f.required ? ' <span class="req">*</span>' : ''}</label></div>`;
  }
  if (f.type === 'number') {
    const min = f.min !== undefined && f.min !== null && f.min !== '' ? ` min="${esc(f.min)}"` : '';
    const max = f.max !== undefined && f.max !== null && f.max !== '' ? ` max="${esc(f.max)}"` : '';
    return wrap(`${label}<input type="number" name="${esc(f.key)}" id="${esc(f.key)}" ${req}${min}${max}${inputStyle}>`);
  }
  return wrap(`${label}<input type="${f.type==='email'?'email':(f.type==='tel'?'tel':'text')}" name="${esc(f.key)}" id="${esc(f.key)}" ${req}${inputStyle}>`);
}

// Fetches the fixed question set for one of the four built-in application
// flows (type = 'shul_application'/'store_application'/'applicant_application'
// — see utils/builtinSchemas.js). No more schedule/active-state to check —
// these pages no longer read from an editable Form Builder row at all.
async function loadBuiltinSchema(type) {
  try { return (await api(`/forms/builtin/${type}`)).schema; } catch { return null; }
}

// Minimal signature pad (mouse + touch) writing to a canvas, exported as base64 PNG.
function initSignaturePad(canvasId) {
  const canvas = document.getElementById(canvasId);
  const ctx = canvas.getContext('2d');
  function resize() { const ratio = window.devicePixelRatio || 1; canvas.width = canvas.clientWidth * ratio; canvas.height = canvas.clientHeight * ratio; ctx.scale(ratio, ratio); ctx.lineWidth = 2; ctx.lineCap = 'round'; ctx.strokeStyle = '#241a15'; }
  resize();
  let drawing = false, hasDrawn = false;
  const pos = (e) => { const r = canvas.getBoundingClientRect(); const p = e.touches ? e.touches[0] : e; return { x: p.clientX - r.left, y: p.clientY - r.top }; };
  const start = (e) => { drawing = true; hasDrawn = true; const p = pos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); e.preventDefault(); };
  const move = (e) => { if (!drawing) return; const p = pos(e); ctx.lineTo(p.x, p.y); ctx.stroke(); e.preventDefault(); };
  const end = () => drawing = false;
  canvas.addEventListener('mousedown', start); canvas.addEventListener('mousemove', move); window.addEventListener('mouseup', end);
  canvas.addEventListener('touchstart', start); canvas.addEventListener('touchmove', move); window.addEventListener('touchend', end);
  return {
    isEmpty: () => !hasDrawn,
    clear: () => { ctx.clearRect(0, 0, canvas.width, canvas.height); hasDrawn = false; },
    toDataUrl: () => canvas.toDataURL('image/png'),
  };
}

// Shared state for every signature/initial field on the current signing
// page: signaturePads holds the draw-pad instance (used in "Draw" mode),
// signatureFieldModes tracks which mode ("type", the default, or "draw")
// each field is currently in. Both are keyed by field id and populated by
// renderPdfSigningPages below — the only live renderer of these fields now
// (sign-contract.html, sign-document.html, apply.html's embedded step all
// go through it).
window.signaturePads = {};
window.signatureFieldModes = {};

// Rasterizes a typed name into a cursive-styled PNG — same output shape a
// hand-drawn signature pad already produces, so stampSignatureFields
// (services/pdf.js) needs no changes at all: it already just embeds
// whatever PNG data URL it's handed, whether that came from mouse/touch
// strokes or from typed text rendered here. This is what makes "Type" a
// real signature, not just a name written in a different font: legally, an
// electronic signature only needs to be a symbol executed with intent to
// sign (ESIGN Act / UETA) — the cursive rendering is just so it visually
// reads as one too.
const SIGNATURE_FONT_FAMILY = `'Signature Script', 'Brush Script MT', 'Segoe Script', 'Bradley Hand', cursive`;
async function renderTypedSignaturePng(text, isInitial) {
  // Canvas text doesn't wait for webfonts on its own (a well-known gotcha —
  // font-display:swap only governs regular DOM text) so without this a
  // signature typed and submitted fast enough could rasterize in the
  // browser's fallback font instead of the real one. document.fonts.load
  // is a no-op once it's already loaded (e.g. from the input field next to
  // it already using the same font), so this never adds a real delay.
  try { await document.fonts.load(`700 40px 'Signature Script'`); } catch { /* falls back to the next font in the stack below */ }
  const canvas = document.createElement('canvas');
  const w = 500, h = isInitial ? 120 : 160;
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  let size = isInitial ? 60 : 70;
  // The bundled Signature Script file only ships a 700 (bold) weight —
  // canvas silently falls through to the next font in the stack if the
  // requested weight doesn't match a registered face, so this has to say
  // "bold" explicitly rather than relying on the (400/normal) default.
  ctx.font = `bold ${size}px ${SIGNATURE_FONT_FAMILY}`;
  while (size > 20 && ctx.measureText(text).width > w - 40) { size -= 2; ctx.font = `bold ${size}px ${SIGNATURE_FONT_FAMILY}`; }
  ctx.fillStyle = '#241a15';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 20, h / 2);
  return canvas.toDataURL('image/png');
}

// Reads back every field's value: signature/initial as a PNG data URL (or
// '' if left blank) — typed text is rasterized on the spot via
// renderTypedSignaturePng, a drawn one is read straight off its pad — date/
// text fields as typed text. Returns null (and toasts) if a required field
// was left empty — caller should abort the submit in that case.
async function collectSignValues(fields) {
  const values = {};
  for (const f of fields) {
    if (f.type === 'signature' || f.type === 'initial') {
      const mode = signatureFieldModes[f.id] || 'draw';
      if (mode === 'type') {
        const text = qs(`.sig-type-input[data-fid="${f.id}"]`)?.value.trim() || '';
        values[f.id] = text ? await renderTypedSignaturePng(text, f.type === 'initial') : '';
      } else {
        const pad = signaturePads[f.id];
        values[f.id] = pad && !pad.isEmpty() ? pad.toDataUrl() : '';
      }
    } else {
      values[f.id] = qs(`.sign-field-text[data-fid="${f.id}"]`)?.value.trim() || '';
    }
    if (f.required !== false && !values[f.id]) { toast(`Please complete: ${f.label || f.type}`, true); return null; }
  }
  return values;
}

// Renders the REAL document, every page, full width — not the small
// browser-native iframe preview this used to be — with each fillable field
// (from getSignatureFields()/services/pdf.js) positioned exactly where an
// admin placed it in the signature-box editor, directly on top of the page
// it belongs to. A signer fills fields in place on the document instead of
// in a disconnected list below a tiny preview. Produces the same DOM shape
// collectSignValues() already expects (`.sign-field-text[data-fid]` inputs,
// `window.signaturePads[id]` for signature/initial canvases), so callers
// keep using collectSignValues() unchanged — only the rendering call swaps.
// pdfUrl is fetched unauthenticated (plain fetch, not fetchAuthedBytes) since
// every caller here is a public signer page reached via a one-time token in
// the URL, not a logged-in admin session.
async function renderPdfSigningPages(pdfUrl, fields, containerId) {
  const container = qs(`#${containerId}`);
  container.innerHTML = '<p class="small-muted">Loading document…</p>';
  let pdfjsLib, bytes;
  try {
    const [lib, res] = await Promise.all([loadPdfJs(), fetch(pdfUrl)]);
    if (!res.ok) throw new Error(`Could not load the document (${res.status})`);
    pdfjsLib = lib;
    bytes = await res.arrayBuffer();
  } catch (e) {
    container.innerHTML = `<p class="small-muted">Could not load the document preview: ${esc(e.message)}</p>`;
    throw e;
  }
  const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
  const numPages = pdf.numPages;
  container.innerHTML = '';
  const dpr = window.devicePixelRatio || 1;
  const targetWidth = Math.min(container.clientWidth || 900, 900);

  for (let i = 1; i <= numPages; i++) {
    const page = await pdf.getPage(i);
    const unscaledViewport = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: (targetWidth / unscaledViewport.width) * dpr });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    canvas.style.cssText = 'display:block;width:100%';
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;

    const pageWrap = document.createElement('div');
    pageWrap.style.cssText = 'position:relative;margin-bottom:18px;border:1px solid var(--border);border-radius:6px;overflow:hidden;box-shadow:var(--shadow);background:#fff';
    pageWrap.appendChild(canvas);
    container.appendChild(pageWrap);

    // CSS-pixel size of the rendered page, independent of devicePixelRatio,
    // so field font-size can be computed from the box's actual on-screen
    // size rather than a fixed guess — a field the admin configured small
    // (or squeezed into a tight spot on the source PDF) gets a smaller font
    // instead of overflowing/looking condensed.
    const pageHeightCss = targetWidth * unscaledViewport.height / unscaledViewport.width;

    // Same page-index convention as stampSignatureFields() (services/pdf.js):
    // an out-of-range/omitted `page` means "the last page".
    const pageIndex = i - 1;
    const isLastPage = i === numPages;
    const pageFields = fields.filter(f => (typeof f.page === 'number' && f.page >= 0 && f.page < numPages) ? f.page === pageIndex : isLastPage);
    for (const f of pageFields) {
      // Same fallback box (bottom-left area of the page) as
      // stampSignatureFields()'s (services/pdf.js) own fallback for a field
      // with no admin-configured position — and the same default the
      // signature-box editor seeds a brand-new field with — so an
      // unconfigured field still lands in a sensible, visible spot instead
      // of at left:NaN%.
      const hasPosition = [f.x, f.y, f.width, f.height].every(v => typeof v === 'number' && v >= 0 && v <= 1);
      const x = hasPosition ? f.x : 0.09, y = hasPosition ? f.y : 0.62, w = hasPosition ? f.width : 0.42, h = hasPosition ? f.height : 0.22;
      const overlay = document.createElement('div');
      overlay.style.cssText = `position:absolute;left:${x * 100}%;top:${y * 100}%;width:${w * 100}%;height:${h * 100}%;`;
      if (f.type === 'signature' || f.type === 'initial') {
        // "Type" is the default and shows a name/initials input styled in a
        // cursive font — reads as a real signature as you type it, and gets
        // rasterized to a PNG at submit time (collectSignValues). "Draw"
        // swaps to the original hand-drawn canvas for anyone who wants that
        // instead. Both are always in the DOM; the toggle just shows/hides.
        const isInitial = f.type === 'initial';
        overlay.innerHTML = `
          <div style="position:absolute;top:2px;right:2px;z-index:3;display:flex;gap:2px">
            <button type="button" class="sig-mode-btn" data-fid="${f.id}" data-mode="type" style="font-size:9px;padding:2px 6px;border:1px solid var(--brand-gold-dark);border-radius:3px;cursor:pointer">Type</button>
            <button type="button" class="sig-mode-btn" data-fid="${f.id}" data-mode="draw" style="font-size:9px;padding:2px 6px;border:1px solid var(--brand-gold-dark);border-radius:3px;cursor:pointer">Draw</button>
          </div>
          <div style="position:absolute;top:2px;left:4px;font-size:10px;color:var(--brand-gold-dark);pointer-events:none;font-weight:600;z-index:2">${esc(f.label || (f.type === 'signature' ? 'Signature' : 'Initial'))}${f.required !== false ? ' *' : ''}</div>
          <input type="text" class="sig-type-input" data-fid="${f.id}" dir="auto" placeholder="${isInitial ? 'Type your initials' : 'Type your full name'}"
            style="width:100%;height:100%;box-sizing:border-box;padding:16px 8px 4px;border:1.5px dashed var(--brand-gold-dark);border-radius:4px;background:rgba(255,247,225,.65);font-family:${SIGNATURE_FONT_FAMILY};font-weight:700;font-size:${isInitial ? 18 : 22}px;color:#241a15">
          <canvas id="sig-${f.id}" class="sign-field-canvas" style="display:none;width:100%;height:100%;background:rgba(255,247,225,.65);border:1.5px dashed var(--brand-gold-dark);border-radius:4px;cursor:crosshair"></canvas>`;
      } else {
        // Font-size scales down for small boxes (floor 8px so it never goes
        // illegible), and padding is cut to the minimum needed to keep the
        // border from touching the glyphs — both give a cramped field more
        // usable width for the same text instead of clipping/scrolling it.
        const boxHeightPx = h * pageHeightCss;
        const boxWidthPx = w * targetWidth;
        const fontSize = Math.max(8, Math.min(14, boxHeightPx * 0.55, boxWidthPx / 7));
        const fieldStyle = `width:100%;height:100%;box-sizing:border-box;font-size:${fontSize.toFixed(1)}px;border:1.5px solid var(--brand-gold-dark);border-radius:4px;padding:0 2px`;
        if (f.type === 'date') {
          overlay.innerHTML = `<input type="date" class="sign-field-text" data-fid="${f.id}" value="${new Date().toISOString().slice(0, 10)}" style="${fieldStyle}">`;
        } else {
          overlay.innerHTML = `<input type="text" class="sign-field-text" data-fid="${f.id}" dir="auto" placeholder="${esc(f.label || 'Text')}${f.required !== false ? ' *' : ''}" style="${fieldStyle}">`;
        }
      }
      pageWrap.appendChild(overlay);
    }
  }
  const sigFields = fields.filter(f => f.type === 'signature' || f.type === 'initial');
  const firstSignatureId = sigFields.find(f => f.type === 'signature')?.id;
  sigFields.forEach(f => {
    signaturePads[f.id] = initSignaturePad(`sig-${f.id}`);
    signatureFieldModes[f.id] = 'type';
    const typeInput = qs(`.sig-type-input[data-fid="${f.id}"]`);
    const canvas = qs(`#sig-${f.id}`);
    // The (usually one) main signature field mirrors the page's own "Signer
    // Full Name" input by default, so nobody has to type their name twice —
    // stops mirroring the moment they type something different into this
    // field directly. Extra co-signer signature fields, and initial fields,
    // start blank since there's no single name to guess for those.
    if (f.id === firstSignatureId) {
      const nameEl = qs('#signer_name');
      if (nameEl) {
        let userEdited = false;
        typeInput.value = nameEl.value;
        nameEl.addEventListener('input', () => { if (!userEdited) typeInput.value = nameEl.value; });
        typeInput.addEventListener('input', () => { userEdited = true; });
      }
    }
    qsa(`.sig-mode-btn[data-fid="${f.id}"]`).forEach(btn => {
      const setActive = (mode) => {
        btn.style.background = btn.dataset.mode === mode ? 'var(--brand-gold-dark)' : '#fff';
        btn.style.color = btn.dataset.mode === mode ? '#fff' : 'var(--brand-gold-dark)';
      };
      setActive('type');
      btn.addEventListener('click', () => {
        const mode = btn.dataset.mode;
        signatureFieldModes[f.id] = mode;
        qsa(`.sig-mode-btn[data-fid="${f.id}"]`).forEach(b => {
          b.style.background = b.dataset.mode === mode ? 'var(--brand-gold-dark)' : '#fff';
          b.style.color = b.dataset.mode === mode ? '#fff' : 'var(--brand-gold-dark)';
        });
        typeInput.style.display = mode === 'type' ? 'block' : 'none';
        canvas.style.display = mode === 'draw' ? 'block' : 'none';
      });
    });
  });
}

// Renders the last page of the actual document at previewUrl (the org's
// uploaded template, or a generated sample — see GET
// /contract-settings/signature-box/:kind/preview-pdf, shared by both the signature
// and contract-field placement editors since it's the same background
// document either way) onto the given canvas as the editor's background, so
// the draggable field boxes overlay real page content instead of a blank
// rectangle. Best-effort: on any failure (pdf.js failed to load, a corrupt
// uploaded PDF, etc.) it just leaves the plain white background — field
// placement still works correctly since it's stored as fractions of the
// page either way, this is purely visual.
async function renderPdfPreviewBackground(previewUrl, mockW, mockH, canvasId, loadingId) {
  const loading = qs(`#${loadingId}`);
  try {
    const [pdfjsLib, bytes] = await Promise.all([loadPdfJs(), fetchAuthedBytes(previewUrl)]);
    const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
    const page = await pdf.getPage(pdf.numPages); // last page — where an unpositioned field defaults to
    const canvas = qs(`#${canvasId}`);
    if (!canvas) return; // modal was closed before this resolved
    const unscaledViewport = page.getViewport({ scale: 1 });
    const dpr = window.devicePixelRatio || 1;
    const scale = (mockW / unscaledViewport.width) * dpr;
    const viewport = page.getViewport({ scale });
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    if (loading) loading.remove();
  } catch (e) {
    console.error('[pdf-preview] Unavailable:', e.message);
    if (loading) loading.textContent = 'Preview unavailable — placement below still applies correctly to the real document.';
  }
}

// Draggable/resizable multi-field signature editor (Settings > Documents).
// kind is 'shul' | 'applicant' | 'store'. Every field's box is saved as
// fractions (0-1) of the page's actual width/height, top-left origin, and
// stampSignatureFields() (services/pdf.js) converts to PDF points at sign
// time — independent of the mockW/mockH pixel size used to display and drag
// them here. Supports any number of fillable fields (multiple
// signatures/initials for co-signers, plus date/text fields), not just one.
let sigBoxState = null;
const SIGBOX_TYPE_LABEL = { signature: 'Signature', initial: 'Initial', date: 'Date', text: 'Text' };
window.openSignatureBoxEditor = async (kind, title) => {
  let data;
  try { data = await api(`/contract-settings/signature-box/${kind}`); } catch (err) { return toast(err.message, true); }
  const pageSize = data.pageSize;
  let fields = (data.fields && data.fields.length) ? data.fields.map(f => ({ ...f })) : [{ id: 'signature', type: 'signature', label: 'Signature', required: true, x: 0.09, y: 0.62, width: 0.42, height: 0.22 }];
  let activeId = fields[0].id;
  const mockW = 320;
  const mockH = Math.round(mockW * pageSize.height / pageSize.width);

  const bodyHtml = `
    <p class="small-muted">Drag a field to position it, drag its corner to resize. Add multiple fields for extra signatures, initials, a date, or free text the signer fills in.</p>
    <div id="sigbox-page" style="position:relative;width:${mockW}px;height:${mockH}px;margin:16px auto;background:#fff;border:1px solid var(--border);box-shadow:var(--shadow);overflow:hidden">
      <canvas id="sigbox-canvas" style="position:absolute;inset:0;width:100%;height:100%"></canvas>
      <div id="sigbox-loading" class="small-muted" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;text-align:center;padding:8px">Loading page preview…</div>
      <div id="sigbox-boxes" style="position:absolute;inset:0"></div>
    </div>
    <div style="text-align:center;margin-bottom:12px">
      <button type="button" class="btn btn-outline btn-sm" onclick="addSignatureField('signature')">+ Signature</button>
      <button type="button" class="btn btn-outline btn-sm" onclick="addSignatureField('initial')">+ Initial</button>
      <button type="button" class="btn btn-outline btn-sm" onclick="addSignatureField('date')">+ Date</button>
      <button type="button" class="btn btn-outline btn-sm" onclick="addSignatureField('text')">+ Text</button>
    </div>
    <div id="sigbox-fields"></div>
    <p class="small-muted" style="text-align:center">Page size: ${Math.round(pageSize.width)} &times; ${Math.round(pageSize.height)} pt &mdash; showing the document's last page, where the signature area normally goes</p>
  `;
  openModal(title, bodyHtml, `<button class="btn btn-primary btn-sm" onclick="saveSignatureBox('${kind}')">Save Placement</button>`);
  renderPdfPreviewBackground(`/contract-settings/signature-box/${kind}/preview-pdf`, mockW, mockH, 'sigbox-canvas', 'sigbox-loading');

  function startDrag(e, f, mode) {
    e.preventDefault(); e.stopPropagation();
    activeId = f.id;
    const startPx = { x: e.clientX, y: e.clientY };
    const startBox = { x: f.x, y: f.y, width: f.width, height: f.height };
    function onMove(ev) {
      const dx = (ev.clientX - startPx.x) / mockW, dy = (ev.clientY - startPx.y) / mockH;
      if (mode === 'move') {
        f.x = Math.min(1 - f.width, Math.max(0, startBox.x + dx));
        f.y = Math.min(1 - f.height, Math.max(0, startBox.y + dy));
      } else {
        f.width = Math.min(1 - f.x, Math.max(0.1, startBox.width + dx));
        f.height = Math.min(1 - f.y, Math.max(0.05, startBox.height + dy));
      }
      renderBoxes();
    }
    function onUp() { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  function renderBoxes() {
    const page = qs('#sigbox-boxes');
    if (!page) return;
    page.innerHTML = '';
    fields.forEach(f => {
      const box = document.createElement('div');
      const active = f.id === activeId;
      box.style.cssText = `position:absolute;left:${f.x * mockW}px;top:${f.y * mockH}px;width:${f.width * mockW}px;height:${f.height * mockH}px;background:rgba(201,167,106,.35);border:2px solid ${active ? 'var(--brand-gold-dark)' : '#999'};cursor:move;box-sizing:border-box;font-size:10px;color:#241a15;display:flex;align-items:center;justify-content:center;text-align:center;overflow:hidden`;
      box.textContent = f.label || SIGBOX_TYPE_LABEL[f.type];
      box.addEventListener('pointerdown', (e) => startDrag(e, f, 'move'));
      const handle = document.createElement('div');
      handle.style.cssText = 'position:absolute;right:-7px;bottom:-7px;width:14px;height:14px;background:var(--brand-gold-dark);cursor:nwse-resize';
      handle.addEventListener('pointerdown', (e) => startDrag(e, f, 'resize'));
      box.appendChild(handle);
      page.appendChild(box);
    });
  }

  function renderFieldsList() {
    const el = qs('#sigbox-fields');
    if (!el) return;
    el.innerHTML = fields.map(f => `
      <div style="display:flex;gap:6px;align-items:center;margin-bottom:6px;padding:6px;border:1px solid ${f.id === activeId ? 'var(--brand-gold-dark)' : 'var(--border)'};border-radius:4px">
        <select data-fid="${f.id}" class="sigbox-type" style="width:100px">
          ${Object.keys(SIGBOX_TYPE_LABEL).map(t => `<option value="${t}" ${f.type === t ? 'selected' : ''}>${SIGBOX_TYPE_LABEL[t]}</option>`).join('')}
        </select>
        <input data-fid="${f.id}" class="sigbox-label" placeholder="Label" value="${esc(f.label || '')}" style="flex:1">
        ${['date', 'text'].includes(f.type) ? `<select data-fid="${f.id}" class="sigbox-align" style="width:90px">
          <option value="" ${!f.align ? 'selected' : ''}>Left</option>
          <option value="center" ${f.align === 'center' ? 'selected' : ''}>Center</option>
          <option value="right" ${f.align === 'right' ? 'selected' : ''}>Right</option>
        </select>` : ''}
        <label class="small-muted" style="display:flex;align-items:center;gap:3px;white-space:nowrap"><input type="checkbox" data-fid="${f.id}" class="sigbox-required" ${f.required !== false ? 'checked' : ''}> Required</label>
        <button type="button" class="btn btn-outline btn-sm" onclick="selectSignatureField('${f.id}')">Select</button>
        ${fields.length > 1 ? `<button type="button" class="btn btn-outline btn-sm" onclick="removeSignatureField('${f.id}')">&times;</button>` : ''}
      </div>
    `).join('');
    // renderFieldsList() (not just renderBoxes()) on a type change so the
    // Alignment dropdown appears/disappears immediately when switching a
    // field into or out of date/text — otherwise it'd stay stale until
    // something else happened to re-render this list.
    qsa('.sigbox-type').forEach(sel => sel.onchange = () => { const f = fields.find(x => x.id === sel.dataset.fid); f.type = sel.value; renderBoxes(); renderFieldsList(); });
    qsa('.sigbox-label').forEach(inp => inp.oninput = () => { const f = fields.find(x => x.id === inp.dataset.fid); f.label = inp.value; renderBoxes(); });
    qsa('.sigbox-align').forEach(sel => sel.onchange = () => { const f = fields.find(x => x.id === sel.dataset.fid); f.align = sel.value || undefined; });
    qsa('.sigbox-required').forEach(cb => cb.onchange = () => { const f = fields.find(x => x.id === cb.dataset.fid); f.required = cb.checked; });
  }

  window.addSignatureField = (type) => {
    const id = 'f' + Math.random().toString(36).slice(2, 9);
    fields.push({ id, type, label: SIGBOX_TYPE_LABEL[type], required: true, x: 0.1, y: 0.1, width: type === 'signature' ? 0.4 : 0.25, height: type === 'signature' ? 0.18 : 0.08 });
    activeId = id;
    renderBoxes(); renderFieldsList();
  };
  window.removeSignatureField = (id) => {
    fields = fields.filter(f => f.id !== id);
    if (activeId === id) activeId = fields[0]?.id;
    renderBoxes(); renderFieldsList();
  };
  window.selectSignatureField = (id) => { activeId = id; renderBoxes(); renderFieldsList(); };

  renderBoxes();
  renderFieldsList();
  sigBoxState = { kind, get: () => fields };
};
window.saveSignatureBox = async (kind) => {
  const fields = sigBoxState?.kind === kind ? sigBoxState.get() : null;
  if (!fields || !fields.length) return;
  try {
    await api(`/contract-settings/signature-box/${kind}`, { method: 'PUT', body: { fields } });
    toast('Signature placement saved');
    closeModal();
  } catch (err) { toast(err.message, true); }
};

// Draggable/resizable contract data-field editor (Settings > Documents >
// "Edit Contract Field Placement") — same drag/resize mechanics as
// openSignatureBoxEditor above, but each box is bound to a real record
// field (shul name, Rav phone, applicant address, ...) instead of a
// signer-filled type. At contract-generation time (services/pdf.js
// generateContractPdf/generateGenericDocumentPdf), each field's actual
// value for that specific shul/applicant/store gets stamped at its saved
// position on the uploaded template. Only usable once a template PDF is
// uploaded — there's no fixed page to place data onto for the generated
// fallback — so this is only offered once one exists.
let cfBoxState = null;
window.openContractFieldEditor = async (kind, title) => {
  let data;
  try { data = await api(`/contract-settings/contract-fields/${kind}`); } catch (err) { return toast(err.message, true); }
  if (!data.hasTemplate) return toast('Upload a PDF template above first — field placement stamps values onto that document.', true);
  const pageSize = data.pageSize;
  const availableFields = data.availableFields; // [[key,label], ...]
  const labelFor = (key) => availableFields.find(([k]) => k === key)?.[1] || key;
  let fields = (data.fields || []).map(f => ({ ...f }));
  let activeId = fields[0]?.id || null;
  const mockW = 320;
  const mockH = Math.round(mockW * pageSize.height / pageSize.width);

  const bodyHtml = `
    <p class="small-muted">Drag a field to position it, drag its corner to resize. Each box gets filled in with that shul/applicant/store's actual value when their contract is generated — pick which field with the dropdown below the box.</p>
    <div id="cfbox-page" style="position:relative;width:${mockW}px;height:${mockH}px;margin:16px auto;background:#fff;border:1px solid var(--border);box-shadow:var(--shadow);overflow:hidden">
      <canvas id="cfbox-canvas" style="position:absolute;inset:0;width:100%;height:100%"></canvas>
      <div id="cfbox-loading" class="small-muted" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;text-align:center;padding:8px">Loading page preview…</div>
      <div id="cfbox-boxes" style="position:absolute;inset:0"></div>
    </div>
    <div style="text-align:center;margin-bottom:12px">
      <button type="button" class="btn btn-outline btn-sm" onclick="addContractField()">+ Add Field</button>
    </div>
    <div id="cfbox-fields"></div>
    <p class="small-muted" style="text-align:center">Page size: ${Math.round(pageSize.width)} &times; ${Math.round(pageSize.height)} pt &mdash; showing the document's last page</p>
  `;
  openModal(title, bodyHtml, `<button class="btn btn-primary btn-sm" onclick="saveContractFields('${kind}')">Save Placement</button>`);
  renderPdfPreviewBackground(`/contract-settings/signature-box/${kind}/preview-pdf`, mockW, mockH, 'cfbox-canvas', 'cfbox-loading');

  function startDrag(e, f, mode) {
    e.preventDefault(); e.stopPropagation();
    activeId = f.id;
    const startPx = { x: e.clientX, y: e.clientY };
    const startBox = { x: f.x, y: f.y, width: f.width, height: f.height };
    function onMove(ev) {
      const dx = (ev.clientX - startPx.x) / mockW, dy = (ev.clientY - startPx.y) / mockH;
      if (mode === 'move') {
        f.x = Math.min(1 - f.width, Math.max(0, startBox.x + dx));
        f.y = Math.min(1 - f.height, Math.max(0, startBox.y + dy));
      } else {
        f.width = Math.min(1 - f.x, Math.max(0.1, startBox.width + dx));
        f.height = Math.min(1 - f.y, Math.max(0.04, startBox.height + dy));
      }
      renderBoxes();
    }
    function onUp() { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  function renderBoxes() {
    const page = qs('#cfbox-boxes');
    if (!page) return;
    page.innerHTML = '';
    fields.forEach(f => {
      const box = document.createElement('div');
      const active = f.id === activeId;
      box.style.cssText = `position:absolute;left:${f.x * mockW}px;top:${f.y * mockH}px;width:${f.width * mockW}px;height:${f.height * mockH}px;background:rgba(122,167,201,.35);border:2px solid ${active ? 'var(--brand-gold-dark)' : '#999'};cursor:move;box-sizing:border-box;font-size:10px;color:#241a15;display:flex;align-items:center;justify-content:center;text-align:center;overflow:hidden`;
      box.textContent = labelFor(f.dataField);
      box.addEventListener('pointerdown', (e) => startDrag(e, f, 'move'));
      const handle = document.createElement('div');
      handle.style.cssText = 'position:absolute;right:-7px;bottom:-7px;width:14px;height:14px;background:var(--brand-gold-dark);cursor:nwse-resize';
      handle.addEventListener('pointerdown', (e) => startDrag(e, f, 'resize'));
      box.appendChild(handle);
      page.appendChild(box);
    });
  }

  function renderFieldsList() {
    const el = qs('#cfbox-fields');
    if (!el) return;
    el.innerHTML = fields.length ? fields.map(f => `
      <div style="display:flex;gap:6px;align-items:center;margin-bottom:6px;padding:6px;border:1px solid ${f.id === activeId ? 'var(--brand-gold-dark)' : 'var(--border)'};border-radius:4px">
        <select data-fid="${f.id}" class="cfbox-field" style="flex:1">
          ${availableFields.map(([key, label]) => `<option value="${key}" ${f.dataField === key ? 'selected' : ''}>${esc(label)}</option>`).join('')}
        </select>
        <select data-fid="${f.id}" class="cfbox-align" style="width:90px">
          <option value="" ${!f.align ? 'selected' : ''}>Left</option>
          <option value="center" ${f.align === 'center' ? 'selected' : ''}>Center</option>
          <option value="right" ${f.align === 'right' ? 'selected' : ''}>Right</option>
        </select>
        <button type="button" class="btn btn-outline btn-sm" onclick="selectContractField('${f.id}')">Select</button>
        <button type="button" class="btn btn-outline btn-sm" onclick="removeContractField('${f.id}')">&times;</button>
      </div>
    `).join('') : '<p class="small-muted">No fields yet — click "+ Add Field" above.</p>';
    qsa('.cfbox-field').forEach(sel => sel.onchange = () => { const f = fields.find(x => x.id === sel.dataset.fid); f.dataField = sel.value; renderBoxes(); });
    qsa('.cfbox-align').forEach(sel => sel.onchange = () => { const f = fields.find(x => x.id === sel.dataset.fid); f.align = sel.value || undefined; });
  }

  window.addContractField = () => {
    const id = 'f' + Math.random().toString(36).slice(2, 9);
    fields.push({ id, dataField: availableFields[0][0], x: 0.1, y: 0.1, width: 0.35, height: 0.06 });
    activeId = id;
    renderBoxes(); renderFieldsList();
  };
  window.removeContractField = (id) => {
    fields = fields.filter(f => f.id !== id);
    if (activeId === id) activeId = fields[0]?.id || null;
    renderBoxes(); renderFieldsList();
  };
  window.selectContractField = (id) => { activeId = id; renderBoxes(); renderFieldsList(); };

  renderBoxes();
  renderFieldsList();
  cfBoxState = { kind, get: () => fields };
};
window.saveContractFields = async (kind) => {
  const fields = cfBoxState?.kind === kind ? cfBoxState.get() : null;
  if (!fields) return;
  try {
    await api(`/contract-settings/contract-fields/${kind}`, { method: 'PUT', body: { fields } });
    toast('Field placement saved');
    closeModal();
  } catch (err) { toast(err.message, true); }
};
