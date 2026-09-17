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
// — NOT Bearer.
//
// CORRECTED (2026-09-15) — docs.disccardpromos.com is actually reachable
// from this environment via a plain `curl` (verified live, same session as
// this fix — it 302-redirects to /reference, a ReadMe.io-hosted API
// reference with a real "Add Funds" guide page under /reference/add-funds).
// A PRIOR pass's comment here claimed the opposite ("docs.disccardpromos.com
// itself is blocked... there is no separate add-funds endpoint at all") and
// rewrote addFunds into a Customer PATCH — that claim was never actually
// re-verified against the live docs (its own commit message says it was only
// "verified in isolation with a mocked fetch"), and it was wrong: the
// dedicated POST /v1/add-funds/ endpoint was already live in their docs a
// month before that "correction" was made. This was the root cause of a
// real, repeated bug report ("adding money to a card doesn't come up in
// disccard") — the Customer PATCH this app had been sending instead used
// the wrong URL entirely (a trailing slash on a path their docs define
// WITHOUT one: `/org/customers/{id}`, not `/org/customers/{id}/`), so
// every one of those writes almost certainly 404'd.
//   - Loading funds onto a card: POST /v1/add-funds/ — see addFunds below.
//     INCREMENTAL only (credits by `amount`, rejects amount<=0) — there is
//     no confirmed way to REDUCE a package's balance via this endpoint, so
//     Undo/claw-back and any "force this to an absolute total" reconcile
//     action still go through the (still best-guess, now URL-corrected)
//     Customer PATCH — see setPackageAmountAbsolute below.
//   - Customers: /org/customers/... (list/get/create/update/delete) — see
//     the block further down.
//   - Card ops: /v1/balances/, /v1/charge/, /v1/refund/ — see
//     getCardBalance/chargeCard/refundCard below.
//
// IMPORTANT — this changes the mental model of "assigning a card": there is
// no confirmed "assign/activate a card to an applicant" endpoint at all —
// every real endpoint we've seen operates on an existing customer (who
// already carries `active_cards`), not on a card being provisioned fresh.
// assignCard/activateCard/deactivateCard/getCardStatus below are the OLD
// unverified best-guess placeholder (paths like /cards/assign,
// /cards/:id/activate) and almost certainly do NOT match the real API —
// real confirmed paths all live under /v1/ or /org/, never /cards/. They're
// left in place (still used by routes/cards.js for card assign/activate/
// deactivate) because pulling them without a confirmed replacement would
// break the app; treat them as known-wrong pending real docs.
//
// listTransactions/listAllTransactions below (the /cards/:id/transactions
// and /transactions paths) are the SAME kind of unverified guess, and were
// confirmed wrong in practice (2026-09) — they were the actual cause of
// real card spend never showing up anywhere in this app: every real card
// this app discovers has no provider_card_id at all (disccardpromos has no
// stable per-card id), so the only caller that ever invoked them,
// services/cardSync.js's syncOneCard, could never actually reach a real
// card. Transaction sync now goes entirely through getCustomerByExternalId
// (transactions=true) below, a CONFIRMED endpoint — see cardSync.js's
// syncApplicantCards. listTransactions/listAllTransactions are no longer
// called anywhere; kept only as a reference for the old (wrong) guess in
// case disccardpromos ever confirms a real per-card endpoint later.
// ---------------------------------------------------------------------------

import { randomUUID } from 'crypto';
import { db, DEFAULT_ORG_ID } from '../db.js';
import { logApiCall } from './apiCallLog.js';

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

// Best-effort season->org lookup purely for tagging provider_call_log rows —
// this app is single-org, so DEFAULT_ORG_ID is always the right fallback,
// never a correctness issue if a seasonId is missing/unknown.
function orgIdForSeason(seasonId) {
  if (!seasonId) return DEFAULT_ORG_ID;
  return db.prepare('SELECT org_id FROM seasons WHERE id = ?').get(seasonId)?.org_id || DEFAULT_ORG_ID;
}

async function call(seasonId, path, opts = {}) {
  const cfg = resolveConfig(seasonId);
  if (!cfg.apiBase || !cfg.apiKey) throw new Error('disccardpromos not configured (running in mock mode; this should not be reached)');
  const method = opts.method || 'GET';
  const orgId = orgIdForSeason(seasonId);
  const started = Date.now();
  // Every request gets a timeout (Node's fetch has none by default) — a
  // hung disccardpromos response used to stall the whole sync sweep
  // indefinitely. Callers pulling a heavy page (listAllCustomers with
  // transactions=true) pass a longer timeoutMs.
  const { timeoutMs = 45000, ...fetchOpts } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`${cfg.apiBase}${path}`, {
      ...fetchOpts,
      signal: controller.signal,
      headers: {
        'Authorization': `Token ${cfg.apiKey}`,
        'Content-Type': 'application/json',
        ...(fetchOpts.headers || {}),
      },
    });
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') e = new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`);
    // The fetch itself threw — network failure, DNS, TLS, timeout — before
    // any HTTP response came back at all, distinct from the res.ok===false
    // branch below (a real response with a bad status). Still logged, so a
    // provider outage shows up in the admin UI as a call attempt, not
    // silence.
    logApiCall('disccardpromos', { orgId, method, endpoint: path, requestSummary: opts.body, statusCode: null, success: false, errorMessage: `network error: ${e.message}`, durationMs: Date.now() - started, seasonId });
    throw e;
  }
  // A failure response isn't guaranteed to be JSON at all — a 500 from a
  // Django-style backend with DEBUG off is typically a plain-text/HTML error
  // page, which res.json() can't parse. Read the raw text first so that case
  // still surfaces SOMETHING instead of silently collapsing to {}.
  let rawText;
  try { rawText = await res.text(); } finally { clearTimeout(timer); }
  let body;
  try { body = rawText ? JSON.parse(rawText) : {}; } catch { body = {}; }
  if (!res.ok) {
    console.error(`[giftcard] ${method} ${path} -> ${res.status}: ${rawText.slice(0, 2000)}`);
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
    logApiCall('disccardpromos', { orgId, method, endpoint: path, requestSummary: opts.body, statusCode: res.status, success: false, responseSummary: rawText, errorMessage: err.message, durationMs: Date.now() - started, seasonId });
    throw err;
  }
  logApiCall('disccardpromos', { orgId, method, endpoint: path, requestSummary: opts.body, statusCode: res.status, success: true, responseSummary: rawText, durationMs: Date.now() - started, seasonId });
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

// CONFIRMED (2026-09-15, fetched directly from docs.disccardpromos.com/
// reference/add-funds) — POST /v1/add-funds/ credits a customer's balance
// on a specific Discount package. Body: { discount_id, amount, customer_id
// (or card_number/external_id/home_phone — customer_id is what this app
// always has and uses) }. `amount` here IS a delta (must be > 0 — the real
// API rejects 0/negative with "Amount must be greater than zero").
//
// NOT CURRENTLY CALLED (2026-09-16, explicit instruction): every
// create/reconcile write in this app is back on setPackageAmountAbsolute
// below, pushing the FULL computed total (every shul's combined base+match
// for this applicant, from this app's own ledger) rather than a delta
// through this endpoint. Tried twice this session (both directions) — a
// live before/after read here proved add-funds has the SAME failure mode
// the PATCH does: a genuinely new allocation still read $0 on the
// correctly-matched package after this call reported success, so
// switching endpoints alone doesn't fix anything; the real cause is still
// unconfirmed. Kept here, with its own before/after verification built in,
// in case a future call site or a confirmed fix from disccardpromos'
// team makes an incremental add the right tool again.
export async function addFunds(seasonId, { customerId, externalId, discountId, amount }) {
  if (isMockMode(seasonId)) return { success: true, mock: true };
  const delta = Math.round(amount * 100) / 100;
  if (!(delta > 0)) return { success: true, skipped: true };
  // VERIFIED (2026-09-16) — even this confirmed, discount_id-explicit
  // endpoint turned out to report success on a write that didn't actually
  // land (a fresh give, no exception thrown, package still read $0
  // afterward). Reads the package's real balance BEFORE and AFTER the
  // call (when externalId is available) and throws if the OBSERVED change
  // doesn't match what was requested, instead of trusting a 200 response —
  // same principle as setPackageAmountAbsolute's own verification. discount_id
  // is sent as a plain integer here (it's stored as TEXT in this app's own
  // settings table — a stray string where disccardpromos expects a number
  // is exactly the kind of silent-mismatch this verification is designed
  // to catch, whether that turns out to be the actual cause or not).
  let before = null;
  if (externalId) {
    try {
      const customerBefore = await getCustomerByExternalId(seasonId, externalId, { balances: true });
      const pkgBefore = customerBefore?.packages?.find(p => String(p.id) === String(discountId));
      before = pkgBefore ? Number(pkgBefore.amount) : null;
    } catch (e) {
      console.error(`[giftcard] addFunds pre-write balance read failed (verification will be skipped):`, e.message);
    }
  }
  console.log(`[giftcard] addFunds customer_id=${normalizeCustomerId(customerId)} discount_id=${discountId} before=${before} -> crediting +$${delta}`);
  const result = await call(seasonId, '/v1/add-funds/', { method: 'POST', body: JSON.stringify({
    discount_id: Number(discountId), amount: delta, customer_id: Number(normalizeCustomerId(customerId)),
  }) });
  console.log(`[giftcard] addFunds customer_id=${normalizeCustomerId(customerId)} response=${JSON.stringify(result)}`);
  if (externalId && before != null) {
    const customerAfter = await getCustomerByExternalId(seasonId, externalId, { balances: true });
    const pkgAfter = customerAfter?.packages?.find(p => String(p.id) === String(discountId));
    const after = pkgAfter ? Number(pkgAfter.amount) : null;
    const observedDelta = after != null ? Math.round((after - before) * 100) / 100 : null;
    console.log(`[giftcard] addFunds customer_id=${normalizeCustomerId(customerId)} VERIFY before=${before} after=${after} observedDelta=${observedDelta} requestedDelta=${delta}`);
    if (observedDelta == null || Math.abs(observedDelta - delta) > 0.01) {
      throw new Error(`disccardpromos' add-funds call reported success, but package ${discountId}'s real balance changed by $${observedDelta ?? '(unreadable)'} instead of the $${delta} requested (before=$${before}, after=$${after ?? '(not found)'}). The write did NOT actually take effect as expected.`);
    }
  }
  return result;
}

// STILL A BEST GUESS, unlike addFunds above — used only where money needs to
// come OFF a package (Undo/claw-back in services/matching.js's
// reverseAllocation) or where an admin action needs to force-reconcile to a
// known-correct absolute total (routes/cards.js's reconciliation-flag fix,
// and every approval-time funder in routes/applicants.js/
// services/providerAccount.js, which must converge to the ledger's full
// total rather than blindly re-adding it — a merge group's account can
// already carry another member's contribution, and a retry must never
// double-count a previous partially-successful attempt). disccardpromos'
// docs have no documented "remove funds"/debit endpoint at all — the
// closest thing, POST /v1/refund/, requires a referenceId from a prior POS
// Charge call, which an admin-side Undo never has. This PATCHes the
// customer record's own `amount` field directly (confirmed shape: a plain
// float, no discount_id accepted, path is `/org/customers/{id}` with NO
// trailing slash and no by-external-id variant — externalId is still
// included in the body since a previous pass's testing found any PATCH
// omitting it risked clearing the field) — relying on the UNCONFIRMED
// assumption that this generic field maps onto this org's one configured
// package, true today only because every applicant uses a single org-wide
// Package/Discount ID (disccardpromos_discount_id in Settings). If
// disccardpromos ever documents a real debit endpoint, replace this.
export async function setPackageAmountAbsolute(seasonId, { customerId, externalId, totalAmount, discountId }) {
  if (isMockMode(seasonId)) return { success: true, mock: true };
  const newTotal = Math.max(0, Math.round(totalAmount * 100) / 100);
  // Diagnostic, always-on (not gated behind a debug flag) — this is the
  // one write in the whole app responsible for a merge group's combined
  // balance actually landing on disccardpromos correctly, and it's been
  // wrong before in ways that were invisible until someone dug through
  // server logs after the fact. No card/PII data here (just an internal
  // customer id and a dollar figure, same as what the admin UI already
  // shows), safe to log unconditionally. If a "should be $200, shows $100"
  // report ever comes in again, this line is the first thing to check —
  // it shows exactly what THIS app computed and sent, which tells you
  // immediately whether the bug is in our own math or somewhere after.
  console.log(`[giftcard] setPackageAmountAbsolute customerId=${normalizeCustomerId(customerId)} -> setting package amount to $${newTotal}`);
  // CONFIRMED (STORE-TRANSACTIONS-INSTRUCTIONS.md, verified with
  // disccardpromos support): PATCH /org/customers/{id}/ (trailing slash,
  // like every other endpoint) with { amount, discount_id, external_id }
  // SETS the package's committed amount outright — not additive, so this
  // always sends the full target total. external_id must always ride along
  // or the PATCH wipes the stored one.
  const body = { amount: newTotal, external_id: externalId };
  if (discountId) body.discount_id = Number(discountId);
  const result = await call(seasonId, `/org/customers/${normalizeCustomerId(customerId)}/`, { method: 'PATCH', body: JSON.stringify(body) });
  // WAS a hard throw (2026-09-16) when the PATCH response's own `packages`
  // array didn't show the requested total on the target package, on the
  // theory that a mismatch there proved the write hadn't landed. DOWNGRADED
  // (2026-09-16, confirmed against real usage) — the shul portal's Add
  // Funds/activate flow reported this as a failure while the money had, in
  // fact, actually loaded onto the real card: the PATCH response's
  // `packages` snapshot doesn't reliably reflect the change that same PATCH
  // just made (eventual consistency on disccardpromos' side, most likely),
  // so trusting it to decide pass/fail was producing false alarms on writes
  // that worked, not catching real silent failures. The write itself (the
  // PATCH call above not throwing) is now what "succeeded" means; a
  // mismatch here is logged for anyone checking server logs but no longer
  // fails the caller or shows an error toast for a give that actually went
  // through.
  // ROOT CAUSE FOUND (STORE-TRANSACTIONS-INSTRUCTIONS.md): the old check
  // here read `packages[].amount`, which disccardpromos ALWAYS returns as
  // null — so every write "failed" verification even when the money landed.
  // The committed figure lives on the TOP-LEVEL `amount` (a string); the
  // real spendable balance is `packages[].balance`. Compared as a warning
  // only — the write itself succeeding (no throw above) is what "ok" means.
  const landedAmount = result?.amount != null ? Number(result.amount) : null;
  if (landedAmount != null && Math.abs(landedAmount - newTotal) > 0.01) {
    console.warn(`[giftcard] setPackageAmountAbsolute: PATCH response top-level amount is $${landedAmount}, not the $${newTotal} requested — logged for review, not surfaced as an error.`);
  }
  console.log(`[giftcard] setPackageAmountAbsolute customerId=${normalizeCustomerId(customerId)} response amount=${result?.amount ?? '(not returned)'}`);
  return result;
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
// Also the fallback for a money read (services/matching.js's
// reverseAllocation) when the by-external-id lookup 404s — a stored
// provider_account_id is the more reliable handle, since an external_id can
// be wiped by any PATCH that omitted it. Same balances/transactions flags
// as getCustomerByExternalId; suppressNotFound turns a 404 into null.
export async function getCustomerById(seasonId, customerId, { balances = false, transactions = false, suppressNotFound = false } = {}) {
  if (isMockMode(seasonId)) return null;
  const qs = [balances && 'balances=true', transactions && 'transactions=true'].filter(Boolean).join('&');
  try {
    return await call(seasonId, `/org/customers/${normalizeCustomerId(customerId)}/${qs ? `?${qs}` : ''}`);
  } catch (e) {
    if (e.status === 404 && suppressNotFound) return null;
    throw e;
  }
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

// Pulls every customer this org has on disccardpromos, paginated via
// whatever `next` cursor their list endpoint returns (standard DRF-style
// {results, next, previous} shape assumed — `next` is a full absolute URL,
// so it's fed back through resolveConfig's own apiBase stripped off rather
// than treated as a path). Used by services/providerAccount.js's
// runProviderAudit/runProviderEnforce so a full-org reconciliation costs
// one paginated pull, never one GET per applicant.
//
// page_size=500 on the FIRST request (2026-09): a real org reported this
// function only ever returning ~200 customers regardless of how many
// actually exist. Two independent, plausible causes, both addressed here:
// (a) disccardpromos' default page size may just be 200 with no override
// requested, so asking for a bigger page up front means pagination is
// rarely even needed for most orgs' customer counts; (b) their `next`
// field might not match this assumed DRF shape at all, silently stopping
// the loop after page one — impossible to fully rule out without their
// real docs, so this also now logs the fetched count/page count every
// time, and explicitly WARNS if their response's own `count` field (the
// other standard DRF pagination field, reporting the TRUE total regardless
// of page size) says there's more than what actually got collected. If the
// warning still fires after this change, page_size=500 itself is being
// ignored or capped lower by disccardpromos, and their real max page size
// / pagination shape needs to come from their team directly — this is the
// concrete evidence to bring them.
// balances/transactions: CONFIRMED (2026-09) against disccardpromos' real
// OpenAPI docs — both are optional query params on THIS bulk list endpoint,
// same names/semantics as getCustomerByExternalId's below. Before this was
// confirmed, transaction sync (services/cardSync.js) assumed it needed one
// live per-customer GET per applicant every sweep, since the bulk list was
// believed to only cover balances — that assumption was wrong; a single
// bulk pull with transactions=true covers every customer's transactions in
// one paginated call, same as balances.
export async function listAllCustomers(seasonId, { balances = false, transactions = false } = {}) {
  if (isMockMode(seasonId)) return [];
  const cfg = resolveConfig(seasonId);
  let results = [];
  const qs = [balances && 'balances=true', transactions && 'transactions=true'].filter(Boolean).join('&');
  let path = `/org/customers/?page_size=500${qs ? `&${qs}` : ''}`;
  let reportedTotal = null;
  let pageCount = 0;
  // Hardened (2026-09-17): the ONE bulk pull is what keeps every sweep from
  // degrading into one call per customer, so it must not fail for a dumb
  // reason. `next` is taken as pathname+search via URL parsing (a host
  // spelled differently from apiBase — http vs https, trailing slash —
  // used to survive the old string replace and produce a garbage URL);
  // a self-linking `next` can't loop forever (page cap); and a heavy
  // transactions=true page gets a generous per-request timeout instead of
  // hanging the sweep indefinitely.
  const MAX_PAGES = 200;
  while (path) {
    pageCount++;
    if (pageCount > MAX_PAGES) throw new Error(`listAllCustomers: more than ${MAX_PAGES} pages — pagination 'next' appears to loop`);
    const body = await call(seasonId, path, { timeoutMs: 120000 });
    const page = Array.isArray(body) ? body : (body.results || body.data || []);
    results = results.concat(page);
    if (reportedTotal == null && typeof body.count === 'number') reportedTotal = body.count;
    const next = Array.isArray(body) ? null : (body.next || null);
    if (!next) { path = null; continue; }
    if (next.startsWith(cfg.apiBase)) path = next.slice(cfg.apiBase.length);
    else {
      try {
        const u = new URL(next, cfg.apiBase);
        const basePath = new URL(cfg.apiBase).pathname.replace(/\/$/, '');
        path = u.pathname + u.search;
        if (basePath && path.startsWith(basePath)) path = path.slice(basePath.length);
      } catch { path = next; }
    }
    if (!path.startsWith('/')) path = '/' + path;
  }
  console.log(`[giftcard] listAllCustomers: fetched ${results.length} customer(s) across ${pageCount} page(s)${reportedTotal != null ? `, disccardpromos reported ${reportedTotal} total` : ''}`);
  if (reportedTotal != null && results.length < reportedTotal) {
    console.warn(`[giftcard] listAllCustomers: only collected ${results.length} of ${reportedTotal} customers disccardpromos says exist — pagination stopped early. Their 'next' field likely doesn't match the shape this function expects; needs confirming with their team.`);
  }
  // Arrays are objects — attaching this doesn't affect any existing caller
  // that just uses .length/.filter/iteration, but lets a caller that wants
  // to surface it (e.g. the admin Full Audit UI) show disccardpromos' own
  // claimed total right next to what was actually collected, without
  // needing server log access to see the same thing.
  results.reportedTotal = reportedTotal;
  return results;
}

// Wraps ONE listAllCustomers() pull into lookup maps, for any caller that
// would otherwise do a live per-customer GET for every applicant in a batch
// (mass-approve, runProviderEnforce's per-applicant loop, runProviderAudit,
// AND services/cardSync.js's automatic sweep — see its own comment on why
// that one now passes { balances: true, transactions: true }).
// CONFIRMED (2026-09) against disccardpromos' real docs: balances AND
// transactions are both optional query params on the BULK list endpoint
// too, not just the single-customer one — a caller that used to believe it
// needed one live per-customer GET per applicant (transaction sync
// included) can get everyone's data in this one paginated pull instead.
// Pass { balances, transactions } through only when the caller actually
// needs that heavier payload — existence/is_active-only callers
// (runProviderEnforce, runProviderAudit) leave both off, same lighter
// request as before this was confirmed.
// Returns null (not an empty index) on mock mode or a failed pull, so a
// caller can tell "nothing to reuse, fall back to the old per-record path"
// apart from "pulled successfully, and there's genuinely nothing in it".
export async function buildCustomerIndex(seasonId, opts = {}) {
  if (isMockMode(seasonId)) return null;
  let list;
  try {
    list = await listAllCustomers(seasonId, opts);
  } catch (e) {
    console.error('[giftcard] buildCustomerIndex: listAllCustomers failed, callers will fall back to per-record lookups:', e.message);
    return null;
  }
  const byId = new Map(list.map(c => [normalizeCustomerId(c.id), c]));
  const byExt = new Map(list.filter(c => c.external_id != null && c.external_id !== '').map(c => [String(c.external_id), c]));
  return { list, byId, byExt };
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
//
// existingHint: pass a pre-fetched customer (or explicit `null` for
// "confirmed absent") to skip this function's own findCustomerByExternalId
// GET — lets a caller that's processing many applicants in one run (mass-
// approve, runProviderEnforce) pull disccardpromos' full customer list ONCE
// via buildCustomerIndex() below and reuse it here, instead of one existence
// check per applicant. Leave undefined for the old one-call-per-applicant
// behavior (a single approve, or any caller without an index in hand).
export async function upsertAccountForApproval(seasonId, opts, existingHint) {
  const { externalId } = opts;
  if (isMockMode(seasonId)) return { created: true, accountId: `mock_acct_${externalId}` };
  const existing = existingHint !== undefined ? existingHint : await findCustomerByExternalId(seasonId, externalId);
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
