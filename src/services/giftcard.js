// ---------------------------------------------------------------------------
// disccardpromos.com gift card provider. Credentials are per-season for now
// (each season can hold its own DISCCARDPROMOS_API_BASE/KEY, entered on the
// season's edit form) — a season with no override falls back to the
// org-wide DISCCARDPROMOS_API_BASE/DISCCARDPROMOS_API_KEY env vars. MOCK
// MODE (simulated card ids, activation, empty transaction feed) applies
// whenever neither is set for the resolved season.
//
// (Every exported function's first argument is seasonId, not orgId — this
// app is single-org, so orgId was never actually load-bearing for config
// resolution; it's kept as the first argument shape so call sites didn't
// need restructuring, just the value they pass.)
//
// This module is the only place in the app that talks to disccardpromos.com —
// if the real API contract differs once confirmed (or they add an endpoint we
// need), only this file changes.
//
// CONFIRMED against real API docs (2026-08-16/17): base
// https://api.disccardpromos.com, auth header is `Authorization: Token <key>`
// — NOT Bearer. Two resource groups are now confirmed against real docs
// pasted in by the user (docs.disccardpromos.com itself is blocked by this
// environment's network egress policy, so we only ever see what gets pasted
// in directly):
//   - Customers: /org/customers/... — see the block further down.
//   - Card ops: /v1/balances/, /v1/charge/, /v1/refund/, /v1/add-funds/ —
//     see getCardBalance/chargeCard/refundCard/addFunds below.
//
// IMPORTANT — this changes the mental model of "assigning a card":
// /v1/add-funds/ credits a customer's balance against one of their
// `packages` (their term for what we'd call a season's Discount), identified
// by discount_id, and takes the customer by our external_id directly. There
// is no confirmed "assign/activate a card to an applicant" endpoint at all —
// every real endpoint we've seen operates on an existing customer (who
// already carries `active_cards`), not on a card being provisioned fresh.
// assignCard/activateCard/deactivateCard/getCardStatus/listTransactions
// below are the OLD unverified best-guess placeholder (paths like
// /cards/assign, /cards/:id/activate) and almost certainly do NOT match the
// real API — real confirmed paths all live under /v1/ or /org/, never
// /cards/. They're left in place (and still used by routes/cards.js /
// services/cardSync.js) because pulling them without a confirmed
// replacement would break the app; treat them as known-wrong pending real
// docs for card provisioning/activation and a transaction-history endpoint.
// ---------------------------------------------------------------------------

import { randomUUID } from 'crypto';
import { db } from '../db.js';

// Strips a trailing slash on a base URL (a very easy copy-paste mistake,
// e.g. 'https://api.disccardpromos.com/') so `${apiBase}${path}` (path
// already starts with '/') never silently doubles up into '...com//org/...',
// which many API gateways 404 on.
function stripTrailingSlash(url) { return (url || '').replace(/\/+$/, ''); }

// Defense-in-depth against already-stored corrupted ids: provider_account_id
// is a TEXT column that got a plain JS number bound into it before the fix
// above existed (upsertAccountForApproval now always stores a clean
// String()), so any customer id already saved for an applicant approved
// earlier is "74421.0" rather than "74421" — which 404s when used to build
// a URL. Every function below that takes a raw customerId strips a
// trailing ".0" so those existing rows keep working without a data
// migration, not just newly-approved ones.
function normalizeCustomerId(id) { return String(id).replace(/\.0$/, ''); }

const globalConfig = {
  apiBase: stripTrailingSlash(process.env.DISCCARDPROMOS_API_BASE || ''),
  apiKey: process.env.DISCCARDPROMOS_API_KEY || '',
};

// A season's own override wins only when BOTH fields are set — a
// half-configured override (base without key, or vice versa) falls back to
// the org-wide default rather than silently mock-mode-ing just that one
// season, which would be a confusing, hard-to-spot state.
function resolveConfig(seasonId) {
  if (seasonId) {
    const season = db.prepare('SELECT disccardpromos_api_base, disccardpromos_api_key FROM seasons WHERE id = ?').get(seasonId);
    if (season?.disccardpromos_api_base && season?.disccardpromos_api_key) {
      return { apiBase: stripTrailingSlash(season.disccardpromos_api_base), apiKey: season.disccardpromos_api_key };
    }
  }
  return globalConfig;
}

export function isMockMode(seasonId) {
  const cfg = resolveConfig(seasonId);
  return !cfg.apiBase || !cfg.apiKey;
}

// Loud, unmissable startup log — every mock-mode function below returns a
// fake success silently (no error, no thrown exception), so a half-set
// config otherwise looks identical to a fully-working live integration:
// approvals "succeed", accounts "get created", funds "get added" — nothing
// on disccardpromos' side ever actually happens, and there is no other
// signal that anything is wrong. Runs once at process start, per season
// (each can have its own override) plus the org-wide default they fall back
// to, so it's the first thing visible in the deploy's server logs.
function logStartupStatus() {
  console.log(`[giftcard] org-wide default: ${isMockMode(null) ? 'MOCK MODE' : `LIVE (base ${globalConfig.apiBase})`}${isMockMode(null) ? ` — missing ${[!globalConfig.apiBase && 'DISCCARDPROMOS_API_BASE', !globalConfig.apiKey && 'DISCCARDPROMOS_API_KEY'].filter(Boolean).join(', ')}` : ''}`);
  try {
    const seasons = db.prepare('SELECT id, name, disccardpromos_api_base, disccardpromos_api_key FROM seasons').all();
    for (const s of seasons) {
      const hasBase = !!s.disccardpromos_api_base, hasKey = !!s.disccardpromos_api_key;
      if (!hasBase && !hasKey) continue; // no override — inherits the org-wide default logged above
      if (hasBase !== hasKey) {
        console.warn(`[giftcard] season "${s.name}" has a PARTIAL disccardpromos override (${hasBase ? 'base set, key missing' : 'key set, base missing'}) — falling back to the org-wide default instead.`);
      } else {
        console.log(`[giftcard] season "${s.name}": LIVE override (base ${stripTrailingSlash(s.disccardpromos_api_base)})`);
      }
    }
  } catch (e) {
    console.warn('[giftcard] could not read per-season overrides at startup:', e.message);
  }
}
logStartupStatus();

async function call(seasonId, path, opts = {}) {
  const cfg = resolveConfig(seasonId);
  if (!cfg.apiBase || !cfg.apiKey) throw new Error('disccardpromos not configured (running in mock mode; this should not be reached)');
  const res = await fetch(`${cfg.apiBase}${path}`, {
    ...opts,
    headers: {
      'Authorization': `Token ${cfg.apiKey}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  // A failure response isn't guaranteed to be JSON at all — a 500 from a
  // Django-style backend with DEBUG off is typically a plain-text/HTML error
  // page, which res.json() can't parse. Read the raw text first so that case
  // still surfaces SOMETHING instead of silently collapsing to {}.
  const rawText = await res.text();
  let body;
  try { body = rawText ? JSON.parse(rawText) : {}; } catch { body = {}; }
  if (!res.ok) {
    console.error(`[giftcard] ${opts.method || 'GET'} ${path} -> ${res.status}: ${rawText.slice(0, 2000)}`);
    // body.message covers their simple-error shape; a DRF-style validation
    // error instead comes back as {field: ["reason", ...]} with no top-level
    // message, which previously collapsed to an opaque "API error 500" with
    // no way to tell (from the admin UI's providerFundsError/
    // providerAccountError, the only place this ever surfaces outside server
    // logs) which field was rejected or why. A non-JSON body (HTML error
    // page, plain text) falls back to a truncated snippet of the raw text
    // rather than nothing at all.
    const detail = body?.message
      || (body && Object.keys(body).length ? JSON.stringify(body) : null)
      || (rawText ? rawText.replace(/\s+/g, ' ').trim().slice(0, 300) : null);
    const err = new Error(detail ? `disccardpromos API error ${res.status}: ${detail}` : `disccardpromos API error ${res.status}`);
    err.status = res.status; err.body = body; err.rawText = rawText;
    throw err;
  }
  return body;
}

// ---------------------------------------------------------------------------
// Card ops — CONFIRMED (2026-08-17) against real API docs. All four live
// under /v1/, distinct from the /org/customers/ prefix the Customers
// resource uses below.
// ---------------------------------------------------------------------------

// Live balance check for one card by its card number. Returns the raw
// provider response (docs show a balance figure keyed off cardNum) so
// callers can pick the field they need rather than this module guessing at
// a normalized shape.
export async function getCardBalance(seasonId, { cardNum }) {
  if (isMockMode(seasonId)) return { balance: null, mock: true };
  return call(seasonId, `/v1/balances/?cardNum=${encodeURIComponent(cardNum)}`);
}

// What a store's own register/card-reader calls at checkout to deduct from a
// card's balance — this app doesn't run a POS, so nothing currently calls
// this, but it's exposed as a correct, confirmed function in case a future
// store-portal manual-charge feature needs it.
export async function chargeCard(seasonId, { cardNum, amount }) {
  if (isMockMode(seasonId)) return { success: true, mock: true };
  return call(seasonId, '/v1/charge/', { method: 'POST', body: JSON.stringify({ cardNum, amount }) });
}

// Store-side reversal of a charge — same "not called anywhere yet" caveat as
// chargeCard above.
export async function refundCard(seasonId, { cardNum, amount }) {
  if (isMockMode(seasonId)) return { success: true, mock: true };
  return call(seasonId, '/v1/refund/', { method: 'POST', body: JSON.stringify({ cardNum, amount }) });
}

// Credits amount onto a customer's balance against one of their `packages`
// (discountId) — this is what actually loads money onto a card, identified
// by OUR applicant's external_id rather than a disccardpromos customer id.
// Wired into applicant approval (routes/applicants.js) — per-season/package
// mapping was explicitly ruled out; there's one org-wide Package/Discount ID
// (Settings > Organization > Gift Card Loading, settings key
// disccardpromos_discount_id) used for every approval regardless of season.
export async function addFunds(seasonId, { externalId, discountId, amount }) {
  if (isMockMode(seasonId)) return { success: true, mock: true };
  return call(seasonId, '/v1/add-funds/', { method: 'POST', body: JSON.stringify({
    external_id: externalId, discount_id: discountId, amount,
  }) });
}

// ---------------------------------------------------------------------------
// OLD unverified placeholder — see the file header note above. Kept in use
// by routes/cards.js and services/cardSync.js pending confirmed real
// endpoints for provisioning/activating a card and reading its transaction
// history.
// ---------------------------------------------------------------------------

// Assign the next available card to an applicant. externalId is the
// applicant's 4-digit external_id (see utils/externalId.js) — disccardpromos
// uses this as its own external reference for the card, in place of our
// internal UUID. Returns { providerCardId, maskedNumber }.
export async function assignCard(seasonId, { applicantId, externalId, amount }) {
  if (isMockMode(seasonId)) {
    const last4 = String(Math.floor(1000 + Math.random() * 9000));
    return { providerCardId: `mock_${randomUUID()}`, maskedNumber: `**** **** **** ${last4}`, amount };
  }
  const body = await call(seasonId, '/cards/assign', { method: 'POST', body: JSON.stringify({ external_ref: externalId || applicantId, amount }) });
  return { providerCardId: body.card_id, maskedNumber: body.masked_number, amount: body.amount ?? amount };
}

// Activate a card by the phone number the recipient provides — this is what
// "writes" the card onto their account per the spec. Returns { activatedAt }.
export async function activateCard(seasonId, { providerCardId, phone }) {
  if (isMockMode(seasonId)) return { activatedAt: new Date().toISOString() };
  const body = await call(seasonId, `/cards/${providerCardId}/activate`, { method: 'POST', body: JSON.stringify({ phone }) });
  return { activatedAt: body.activated_at || new Date().toISOString() };
}

export async function deactivateCard(seasonId, { providerCardId, reason }) {
  if (isMockMode(seasonId)) return { deactivatedAt: new Date().toISOString() };
  const body = await call(seasonId, `/cards/${providerCardId}/deactivate`, { method: 'POST', body: JSON.stringify({ reason }) });
  return { deactivatedAt: body.deactivated_at || new Date().toISOString() };
}

// Returns { balance, activatedAt, status }
export async function getCardStatus(seasonId, { providerCardId }) {
  if (isMockMode(seasonId)) return { balance: null, activatedAt: null, status: 'unknown (mock mode)' };
  return call(seasonId, `/cards/${providerCardId}`);
}

// Returns an array of raw transactions: { id, type, amount, store_name, occurred_at, ... }
export async function listTransactions(seasonId, { providerCardId, since }) {
  if (isMockMode(seasonId)) return [];
  const qs = since ? `?since=${encodeURIComponent(since)}` : '';
  const body = await call(seasonId, `/cards/${providerCardId}/transactions${qs}`);
  return body.transactions || body.data || [];
}

// Pull transactions across ALL cards since a timestamp, if the provider supports
// a bulk feed (cheaper than per-card polling). Falls back to null so the caller
// knows to loop per-card instead.
export async function listAllTransactions(seasonId, { since }) {
  if (isMockMode(seasonId)) return null;
  try {
    const body = await call(seasonId, `/transactions?since=${encodeURIComponent(since || '')}`);
    return body.transactions || body.data || null;
  } catch {
    return null; // endpoint may not exist — caller falls back to per-card polling
  }
}

// ---------------------------------------------------------------------------
// Customers — CONFIRMED against disccardpromos's real Customer Management API
// docs (2026-08-17): /org/customers/... . This is their term for what the
// rest of this app calls an "account", written at applicant-approval time
// (routes/applicants.js POST /:id/approve).
//
// Their "group" is NOT a separate resource with its own id — `group_name` is
// a plain string field directly on the customer record, just sent along on
// create/update; passing an unknown group_name creates it automatically.
//
// IMPORTANT — there is no separate "assign/provision a new card" endpoint at
// all. A customer carries a `card_number` write field ("activate a card
// number for this customer") and a read-only `active_cards` array (masked
// numbers) — disccardpromos expects the ORG to already hold real physical
// card numbers and "assigning a card" means activating one of those numbers
// against a customer via PATCH, not generating a fresh card id the way the
// old assignCard()/activateCard() below (still kept for
// deactivate/status/transactions, which their docs don't cover) guessed.
// See linkCardToCustomer() / getCustomer() further down.
//
// Still unconfirmed: how "current season" maps onto their data model —
// nothing in the Customer resource represents a season directly. The
// customer's `packages` array (each with its own id/name/amount/rate) is the
// likely place — one seeded example package was literally named "Vip Grocery
// 2025" — but which package to attach for a given season, and through which
// endpoint, needs their Packages docs to confirm. `seasonName` is threaded
// through below and intentionally unused for now rather than guessed at.
// ---------------------------------------------------------------------------

// Every writable Customer field per their docs, mapped from our applicant
// shape. house_number/street/appartment are three separate fields on their
// side but one free-text `address` on ours — sent whole as `street` (with
// house_number left unset) rather than guessing a split that would silently
// mis-parse real addresses.
function customerPayload({ firstName, lastName, groupName, homePhone, cell, email, phone2, address, city, state, zip, officeNotes, isActive, cardNumber, amount, externalId }) {
  const body = {
    first_name: firstName, last_name: lastName, group_name: groupName,
    home_phone: homePhone, cell, email, phone2,
    street: address, city, state, zip,
    office_notes: officeNotes, is_active: isActive,
    card_number: cardNumber, amount,
    // Live-tested 2026-08-19: external_id came back null on a customer
    // whose CREATE payload included it — every other field round-tripped
    // fine, so it's specifically that field being dropped, not a payload
    // problem in general. Included here too so a PATCH can be tried as a
    // diagnostic (see GET .../provider-customer-by-id's PATCH sibling in
    // routes/applicants.js) to tell "read-only on create" apart from
    // "read-only everywhere".
    external_id: externalId,
  };
  for (const k of Object.keys(body)) if (body[k] === undefined || body[k] === '') delete body[k];
  return body;
}

// Looks up an existing disccardpromos customer by OUR applicant's
// external_id. Returns null if not found (a 404 from the provider) or in
// mock mode.
export async function findCustomerByExternalId(seasonId, externalId) {
  if (isMockMode(seasonId)) return null;
  try {
    const result = await call(seasonId, `/org/customers/by-external-id/${encodeURIComponent(externalId)}/`);
    // Diagnostic for the "re-approving creates a duplicate customer instead
    // of updating" report: if this fires and shows found=false/no id on an
    // applicant that's been approved before, the by-external-id lookup
    // itself is the thing not matching what create actually stored (wrong
    // endpoint shape, or the real API doesn't echo external_id the way
    // that path assumes) — upsertAccountForApproval below has no way to
    // know that without this logged.
    console.log(`[giftcard] findCustomerByExternalId(${externalId}) -> found id=${result?.id ?? '(none in response)'}`);
    return result;
  } catch (e) {
    if (e.status === 404) { console.log(`[giftcard] findCustomerByExternalId(${externalId}) -> 404 not found`); return null; }
    console.error(`[giftcard] findCustomerByExternalId(${externalId}) -> unexpected error (status ${e.status}): ${e.message}`);
    throw e;
  }
}

// Diagnostic-only direct lookup by disccardpromos' own numeric customer id
// (distinct from findCustomerByExternalId/getCustomerByExternalId, which go
// through the by-external-id sub-path) — used to check whether a customer
// definitely known to exist (its id came back from createCustomer) actually
// carries the external_id we sent, disambiguating "by-external-id doesn't
// exist as a route" from "it exists but external_id isn't stored/matched
// the way we assumed."
export async function getCustomerById(seasonId, customerId) {
  if (isMockMode(seasonId)) return null;
  return call(seasonId, `/org/customers/${normalizeCustomerId(customerId)}/`);
}

// Live-tested 2026-08-19: disccardpromos silently drops external_id from
// the CREATE payload (every other field — name, phone, email, address,
// group — round-trips fine, only this one comes back null), so this always
// follows a create with a PATCH that sets it. Whether that follow-up PATCH
// reliably persists external_id on its own is still not fully confirmed —
// every real-flow test so far has had a second, unrelated PATCH
// (upsertAccountForApproval's old separate isActive-only call) run
// immediately after it, and that second call is the prime suspect for why
// external_id kept coming back null (see upsertAccountForApproval below,
// which now folds isActive into this same call instead of a follow-up one).
// If external_id still doesn't stick with no other PATCH ever following
// this one, that's a genuine disccardpromos-side limitation to escalate to
// their support, not something fixable from here.
export async function createCustomer(seasonId, opts) {
  const { externalId } = opts;
  if (isMockMode(seasonId)) return { id: `mock_${externalId}`, external_id: externalId, group_name: opts.groupName, active_cards: [] };
  const created = await call(seasonId, '/org/customers/', { method: 'POST', body: JSON.stringify(customerPayload(opts)) });
  if (created?.id && externalId) {
    try {
      return await updateCustomer(seasonId, created.id, { externalId });
    } catch (e) {
      console.error(`[giftcard] customer ${created.id} created but the external_id=${externalId} follow-up PATCH failed (status ${e.status}):`, e.message);
      return created;
    }
  }
  return created;
}

// Their docs show PATCH at '/org/customers/{id}' with no trailing slash,
// unlike every other Customer endpoint (list/create/get-by-id/
// get-by-external-id/delete). Originally matched exactly as documented, on
// the theory that a real API is safer to follow literally than to "fix" —
// but a live "disccardpromos API error 404" report on card assignment
// (POST /api/cards/assign -> linkCardToCustomer below, same PATCH path) is
// consistent with this being the docs typo it was already suspected to be.
// Trailing slash added to match every sibling endpoint; call() now logs the
// exact path/status/body on every failure (see below), so if this guess is
// wrong the next occurrence will say so directly instead of a bare 404.
export async function updateCustomer(seasonId, customerId, opts) {
  if (isMockMode(seasonId)) return { id: customerId, ...customerPayload(opts) };
  return call(seasonId, `/org/customers/${normalizeCustomerId(customerId)}/`, { method: 'PATCH', body: JSON.stringify(customerPayload(opts)) });
}

export async function deleteCustomer(seasonId, customerId) {
  if (isMockMode(seasonId)) return { ok: true };
  return call(seasonId, `/org/customers/${normalizeCustomerId(customerId)}/`, { method: 'DELETE' });
}

// Full customer record including active_cards (masked numbers) and packages
// — balances/transactions are opt-in per their docs (?balances=true /
// ?transactions=true) since presumably heavier to compute. Used by
// syncCustomerCards() below to mirror what's actually on disccardpromos'
// side into our local `cards` table, which is the only way to pick up a
// card that was assigned directly in their dashboard rather than through
// this app.
// suppressNotFound=false is a diagnostic escape hatch (used by GET
// /applicants/:id/provider-customer) — normal callers want a plain null for
// "no customer yet", but investigating whether the by-external-id lookup
// itself matches what create() actually stored needs to see the real 404
// body/text rather than have it swallowed.
export async function getCustomerByExternalId(seasonId, externalId, { balances = false, transactions = false, suppressNotFound = true } = {}) {
  if (isMockMode(seasonId)) return null;
  const qs = [balances && 'balances=true', transactions && 'transactions=true'].filter(Boolean).join('&');
  try {
    return await call(seasonId, `/org/customers/by-external-id/${encodeURIComponent(externalId)}/${qs ? `?${qs}` : ''}`);
  } catch (e) {
    if (e.status === 404 && suppressNotFound) return null;
    throw e;
  }
}

// "Assigning a card" on disccardpromos means activating a real physical card
// number the org already holds against a customer — there is no endpoint
// that generates/provisions a fresh card number. cardNumber must be a real
// number an admin has in hand (e.g. from a batch of physical cards).
// externalId: live-tested 2026-08-19 — same clobber as upsertAccountForApproval
// (see its comment above): a PATCH that omits external_id clears it back to
// null rather than leaving it alone, confirmed here too via a bare
// {isActive:false}-only PATCH from lockApplicantCards. So every PATCH to a
// customer, for any reason, must carry the applicant's external_id along or
// risk silently breaking every future by-external-id lookup for them.
// Passing it is optional only for backward compatibility with any caller
// that genuinely doesn't have it in hand yet.
export async function linkCardToCustomer(seasonId, customerId, cardNumber, externalId) {
  if (isMockMode(seasonId)) return { id: customerId, active_cards: [`****${String(cardNumber).slice(-4)}`] };
  const body = { card_number: cardNumber };
  if (externalId) body.external_id = externalId;
  return call(seasonId, `/org/customers/${normalizeCustomerId(customerId)}/`, { method: 'PATCH', body: JSON.stringify(body) });
}

// Idempotent upsert used at applicant-approval time: an existing customer
// (matched by external_id) gets every field below refreshed (name, contact
// info, address, group) rather than just group_name — the "not all info
// transfers" report was this function only ever sending
// external_id/first_name/last_name/group_name even though the applicant
// record (and disccardpromos' own Customer schema) has phone/email/address
// too. A new customer gets created with the same full set. Returns
// { created, accountId }. (seasonName isn't wired to anything yet — see
// note above.)
export async function upsertAccountForApproval(seasonId, opts) {
  const { externalId } = opts;
  if (isMockMode(seasonId)) return { created: true, accountId: `mock_acct_${externalId}` };
  const existing = await findCustomerByExternalId(seasonId, externalId);
  if (existing) {
    // isActive: true folded into this same PATCH (not a separate call
    // afterward) — live-tested 2026-08-19 that a follow-up PATCH omitting
    // external_id clears the field back to null instead of leaving it
    // alone, which is exactly what was happening when approval used to call
    // unlockApplicantCustomer() right after this: every approval silently
    // wiped the external_id it had just set, which is why by-external-id
    // lookups (duplicate-prevention above, and add-funds right after
    // approval) kept reporting "Customer not found" for accounts that
    // demonstrably existed. One combined PATCH avoids the clobber.
    const updated = await updateCustomer(seasonId, existing.id, { ...opts, isActive: true });
    // Live-tested 2026-08-19: accountId gets stored into applicants.
    // provider_account_id (a TEXT column) via a plain positional bind — a
    // JS number bound directly into a TEXT-affinity column comes back out
    // as "74421.0" (better-sqlite3/SQLite formats it as REAL, not INTEGER,
    // even for whole numbers), and that corrupted value then 404s when
    // later used to build a card-assign PATCH URL like
    // /org/customers/74421.0/. Forcing a clean string here, at the one
    // place accountId is produced, fixes every caller at once.
    return { created: false, accountId: String(updated.id ?? existing.id) };
  }
  const created = await createCustomer(seasonId, { ...opts, isActive: true });
  return { created: true, accountId: String(created.id) };
}
