import { db, uuid, DEFAULT_ORG_ID } from '../db.js';
import * as giftcard from './giftcard.js';
import { resolveStoreId } from './storeMatch.js';
import { getApplicantBalances } from './applicantBalance.js';
import { sendMailChecked } from './mail.js';
import { scheduleProviderEnforceSoon } from './providerAccount.js';

// See syncApplicantCards' diagnostic comment below — logged at most once
// per process lifetime, not per applicant/sweep.
let loggedTransactionShapeOnce = false;

// Last 4 digits of any masked card string, whatever mask convention it uses
// (`****1123`, `************1123`, `**** **** **** 1123`) — the only card
// identifier every side agrees on. See syncApplicantCards.
function last4(masked) { return String(masked ?? '').replace(/\D/g, '').slice(-4); }

// Persisted counterpart to the console-only diagnostic below — the
// deployed environment gives admins no server console access, so a
// diagnostic that ONLY ever printed to console.log was invisible to anyone
// who actually needed it. This settings row is what Admin > Cards' banner
// (see frontend/admin/cards.html) reads to show the real customer response
// shape directly in the browser — the fastest way to find disccardpromos'
// real transactions field name (still unconfirmed — see the comment below)
// without needing a developer to read logs on the org's behalf. Cleared the
// moment transactions ARE successfully recognized, so a stale "shape
// mismatch" warning never lingers after the real field name is found and
// fixed.
const TXN_SHAPE_DIAGNOSTIC_KEY = 'disccard_txn_shape_diagnostic';
function recordTxnShapeDiagnostic(orgId, customer) {
  const value = JSON.stringify({ at: new Date().toISOString(), keys: Object.keys(customer), sample: JSON.stringify(customer).slice(0, 1500) });
  db.prepare(`INSERT INTO settings (org_id, key, value) VALUES (?,?,?)
    ON CONFLICT(org_id, key) DO UPDATE SET value = excluded.value`).run(orgId || DEFAULT_ORG_ID, TXN_SHAPE_DIAGNOSTIC_KEY, value);
}
function clearTxnShapeDiagnostic(orgId) {
  db.prepare(`DELETE FROM settings WHERE org_id = ? AND key = ?`).run(orgId || DEFAULT_ORG_ID, TXN_SHAPE_DIAGNOSTIC_KEY);
}
export function getTxnShapeDiagnostic(orgId) {
  const row = db.prepare(`SELECT value FROM settings WHERE org_id = ? AND key = ?`).get(orgId || DEFAULT_ORG_ID, TXN_SHAPE_DIAGNOSTIC_KEY);
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return null; }
}

// FIXED (2026-09) — root cause of "transactions never show up": this used
// to call giftcard.js's listTransactions(), which hits /cards/:id/transactions
// — one of the OLD unverified best-guess paths documented at the top of
// giftcard.js ("almost certainly do NOT match the real API — real confirmed
// paths all live under /v1/ or /org/, never /cards/"). Worse, it only ever
// ran for a card whose provider_card_id was set — but every real card this
// app discovers (see syncApplicantCards below) is inserted with
// provider_card_id = NULL, since disccardpromos has no stable per-card id
// at all. So the automatic sweep's old top-level query
// (`... AND provider_card_id IS NOT NULL`) matched zero real cards, and
// even a manual per-card "Sync Now" click hit an endpoint that likely
// doesn't exist — nothing about real spend could ever have synced.
//
// The one CONFIRMED way to read a customer's activity is the Customer API
// itself (giftcard.js's getCustomerByExternalId, with transactions=true) —
// already used, with balances=true, to discover cards. syncApplicantCards
// below now pulls transactions in that SAME call and matches each one back
// to a local card by masked number (the only identifier both sides agree
// on) — a single card's "Sync Now" is really "sync this card's applicant"
// (every card they hold syncs together), same as the automatic sweep.
export async function syncOneCard(orgId, card) {
  const applicant = db.prepare('SELECT * FROM applicants WHERE id = ?').get(card.applicant_id);
  if (!applicant) return 0;
  const { transactionsSynced } = await syncApplicantCards(orgId, applicant);
  return transactionsSynced;
}

// Locks an applicant's disccardpromos customer — used when an applicant is
// rejected or moved back to pending (spec: "rejecting or making a customer
// pending should trigger a lock on the card by disccard"), so their card(s)
// can't keep being spent once they're no longer approved. Per disccardpromos'
// real Customer API, `is_active` is a field on the CUSTOMER, not on an
// individual card — there is no per-card lock/deactivate endpoint at all —
// so this deactivates the whole customer record rather than any specific
// card, and every local card row for them is marked deactivated to match
// (an applicant only ever has one disccardpromos customer regardless of how
// many cards they hold). Reactivation on (re-)approval is folded directly
// into giftcard.js's upsertAccountForApproval (isActive: true alongside
// every other field in the same call) rather than a separate PATCH here —
// live-tested 2026-08-19 that a bare `{is_active: true}` PATCH issued right
// after account creation/update was wiping the external_id that same
// approval had just set, breaking duplicate-customer prevention and
// add-funds (both look the customer up by external_id) on every approval.
// Best-effort: a provider failure is returned to the caller to surface, but
// never blocks the status change that triggered it — the local rows are
// still marked deactivated either way, since "no longer approved" should
// never show as still-active in our own UI regardless of whether the
// provider call succeeded.
export async function lockApplicantCards(orgId, applicant) {
  db.prepare(`UPDATE cards SET status='deactivated', deactivated_at=datetime('now') WHERE applicant_id = ? AND status IN ('assigned','activated')`).run(applicant.id);
  if (!applicant.provider_account_id) return { errors: [] };
  try {
    // externalId included alongside isActive — live-tested 2026-08-19 that a
    // bare {is_active:false}-only PATCH clears the customer's external_id
    // back to null instead of leaving it alone (see upsertAccountForApproval
    // in giftcard.js for the full story). Re-sending it here is what keeps
    // by-external-id lookups working for this applicant after a reject.
    await giftcard.updateCustomer(applicant.season_id, applicant.provider_account_id, { isActive: false, externalId: applicant.external_id });
    // Clears a previously-flagged failure the moment a later attempt
    // (automatic retry, or a manual one from the sync-status diagnostic)
    // actually succeeds.
    db.prepare(`UPDATE applicants SET provider_deactivate_error = NULL WHERE id = ?`).run(applicant.id);
    return { errors: [] };
  } catch (e) {
    console.error('[cardSync] failed to lock disccardpromos customer for applicant', applicant.id, ':', e.message);
    db.prepare(`UPDATE applicants SET provider_deactivate_error = ? WHERE id = ?`).run(e.message, applicant.id);
    // A failed write here means disccardpromos and our own "should be
    // locked" expectation have drifted apart — the same standing
    // reconciliation loop that keeps approvals matched (services/
    // providerAccount.js's runProviderEnforce) will pick this up and retry
    // it shortly, without anyone needing to notice or click a button.
    scheduleProviderEnforceSoon(orgId, `deactivation failed for applicant ${applicant.id}`);
    return { errors: [e.message] };
  }
}

// Reconciles a customer's actual active_cards (from disccardpromos' real,
// confirmed Customer API) against our local cards table in both directions,
// AND syncs their transactions — all from the SAME customer fetch, one API
// call per applicant instead of a separate round-trip per concern:
//  - discovers cards activated directly on disccardpromos' own dashboard,
//    which this app would otherwise never learn about since they never went
//    through routes/cards.js's /assign.
//  - marks locally assigned/activated cards as removed once their masked
//    number is no longer in the customer's active_cards, so a card
//    unassigned/removed on disccardpromos' side stops showing as live here.
//  - inserts any new card_transactions rows (purchases/refunds/etc — see
//    syncOneCard's comment above for why this replaced the old, broken
//    per-card sync path).
// Card matching is by masked number throughout: disccardpromos has no
// stable per-card id at all (confirmed — see giftcard.js's
// linkCardToCustomer), so masked number is the only thing both sides agree
// on. Returns { discovered, removed, transactionsSynced }.
//
// customerOverride: pass an already-fetched customer object (or explicit
// `null` for "confirmed absent, disccardpromos has no such customer right
// now") to skip this function's own live GET — see syncAllCards below,
// which builds ONE bulk customer pull per sweep (giftcard.buildCustomerIndex
// with balances+transactions) and hands each applicant's own record in
// directly, instead of every applicant triggering its own round trip.
// Leave undefined (the default) for the old one-call-per-applicant behavior
// — used by syncOneCard's manual "Sync Now" click, where there's no batch
// to amortize a bulk pull across.
export async function syncApplicantCards(orgId, applicant, customerOverride) {
  if (!applicant.provider_account_id || applicant.provider_exempt) return { discovered: 0, removed: 0, transactionsSynced: 0 };
  let customer = customerOverride;
  if (customer === undefined) {
    try {
      customer = await giftcard.getCustomerByExternalId(applicant.season_id, applicant.external_id, { balances: true, transactions: true });
    } catch (e) {
      console.error('[cardSync] failed to fetch customer for card/transaction sync, applicant', applicant.id, ':', e.message);
      return { discovered: 0, removed: 0, transactionsSynced: 0 };
    }
  }
  if (!customer) return { discovered: 0, removed: 0, transactionsSynced: 0 };
  // Card matching is by LAST 4 DIGITS everywhere (STORE-TRANSACTIONS-
  // INSTRUCTIONS.md §4/§6): disccardpromos' active_cards use `****1123`,
  // its transactions' `card` field uses `************1123`, and whatever
  // this app stored at assign time may be a third convention. Exact-string
  // matching made every sync "remove" a real card and then "discover" it
  // again as a phantom duplicate.
  const remoteCards = Array.isArray(customer.active_cards) ? customer.active_cards.map(String) : [];
  const remoteLast4 = new Set(remoteCards.map(last4));
  const localActive = db.prepare(`SELECT id, card_number_masked FROM cards WHERE applicant_id = ? AND status IN ('assigned','activated')`).all(applicant.id);
  const knownLast4 = new Set(localActive.map(c => last4(c.card_number_masked)));

  // `packages[].balance` is the real, currently-spendable balance (confirmed
  // — it's what decreases as they spend). `packages[].amount` is ALWAYS
  // null on the real API and must never be read; the committed total lives
  // on the top-level `amount` instead (see reconcileApplicantBalance).
  const balance = Math.round((customer.packages || []).reduce((sum, p) => sum + (Number(p.balance) || 0), 0) * 100) / 100;
  let discovered = 0;
  for (const masked of remoteCards) {
    if (knownLast4.has(last4(masked))) continue;
    db.prepare(`INSERT INTO cards (id, org_id, applicant_id, season_id, card_number_masked, provider_card_id, status, amount, assigned_at, activated_at)
      VALUES (?,?,?,?,?,NULL,'activated',?,datetime('now'),datetime('now'))`)
      .run(uuid(), orgId, applicant.id, applicant.season_id, masked, balance);
    knownLast4.add(last4(masked));
    discovered++;
  }
  // FIXED (2026-09) — real root cause of "Card Amount doesn't show the
  // total money on the card": `amount` used to only ever get written ONCE,
  // at the moment a card was first discovered (the INSERT above) — every
  // sweep since then left it at that original snapshot regardless of how
  // much was added or spent afterward, so the admin applicant profile's
  // Cards tab (and anywhere else that reads cards.amount) showed a stale
  // number from whenever the card first showed up, not the real current
  // balance. Every ACTIVE card now gets its `amount` refreshed to the same
  // current package balance on every sync, same as a newly-discovered one.
  if (localActive.length) {
    const updateAmount = db.prepare(`UPDATE cards SET amount = ?, last_synced_at = datetime('now') WHERE id = ?`);
    for (const local of localActive) {
      if (!remoteLast4.has(last4(local.card_number_masked))) continue; // about to be deactivated below, not refreshed
      updateAmount.run(balance, local.id);
    }
  }

  let removed = 0;
  const deactivate = db.prepare(`UPDATE cards SET status='deactivated', deactivated_at=datetime('now') WHERE id = ?`);
  for (const local of localActive) {
    if (remoteLast4.has(last4(local.card_number_masked))) continue;
    deactivate.run(local.id);
    removed++;
  }

  // Transactions — every card this applicant has EVER held (not just the
  // currently-active ones above), so a purchase on a since-deactivated card
  // still lands in the ledger. disccardpromos' real docs (confirmed 2026-09)
  // only document `transactions=true` as a query PARAM on this endpoint —
  // the response schema they publish doesn't show what field it actually
  // adds, so every name below past the first two is still an unconfirmed
  // guess at common REST conventions, same as every other undocumented
  // shape this file defends against.
  const rawTxns = Array.isArray(customer.transactions) ? customer.transactions
    : Array.isArray(customer.transaction_history) ? customer.transaction_history
    : Array.isArray(customer.recent_transactions) ? customer.recent_transactions
    : Array.isArray(customer.transaction_list) ? customer.transaction_list
    : Array.isArray(customer.card_transactions) ? customer.card_transactions
    : Array.isArray(customer.history) ? customer.history : [];
  // Diagnostic: shows the real customer response's top-level keys (plus a
  // truncated raw sample) whenever transactions=true comes back with
  // nothing recognized as an array — persisted to a settings row (see
  // recordTxnShapeDiagnostic above) and surfaced directly in Admin > Cards'
  // banner, since this deployed environment gives admins no server console
  // access at all. Still also logged once per process for anyone who does
  // have console access. Cleared the moment transactions ARE recognized, so
  // a real fix (once the true field name is found from this diagnostic)
  // makes the banner disappear on its own rather than lingering stale.
  if (!rawTxns.length && customer && typeof customer === 'object') {
    recordTxnShapeDiagnostic(orgId, customer);
    if (!loggedTransactionShapeOnce) {
      loggedTransactionShapeOnce = true;
      console.log(`[cardSync] diagnostic (logged once): customer response's top-level keys when no transactions array was recognized: ${Object.keys(customer).join(', ')}`);
    }
  } else if (rawTxns.length) {
    clearTxnShapeDiagnostic(orgId);
  }
  let transactionsSynced = 0, unattributed = 0, malformed = 0;
  if (rawTxns.length) {
    const allLocal = db.prepare(`SELECT id, card_number_masked FROM cards WHERE applicant_id = ?`).all(applicant.id);
    const cardIdByLast4 = new Map(allLocal.map(c => [last4(c.card_number_masked), c.id]));
    const singleCardId = allLocal.length === 1 ? allLocal[0].id : null;
    const insertTxn = db.prepare(`INSERT OR IGNORE INTO card_transactions (id, card_id, provider_txn_id, type, amount, balance_after, store_name, store_id, occurred_at, raw_payload)
      VALUES (?,?,?,?,?,?,?,?,?,?)`);
    // CONFIRMED transaction shape (STORE-TRANSACTIONS-INSTRUCTIONS.md §3) —
    // the ONLY fields that exist: id (bare number), timestamp, disccardPaid
    // (always positive; the amount charged to the card), cartAmount, card
    // (`************1123`), vendor. No type/balance_after/store_name/
    // occurred_at/amount — every previous guess at those names silently
    // produced undefined, which is why no store spend ever synced.
    //  - provider_txn_id is String(id): binding a raw JS integer into a TEXT
    //    column stores "320972.0", and a later run then inserts "320972" as
    //    a duplicate.
    //  - amount is stored NEGATIVE for a purchase (-disccardPaid): every
    //    total in this app (applicantBalance.js, cards.js) sums
    //    `CASE WHEN amount < 0 THEN -amount` — storing the positive figure
    //    as-is would exclude every real purchase from every total.
    //  - each entry is its own try/catch: one malformed entry used to abort
    //    the whole array and silently drop everything after it.
    for (const t of rawTxns) {
      try {
        const cardId = cardIdByLast4.get(last4(t.card)) || singleCardId;
        if (!cardId) {
          unattributed++;
          console.warn(`[cardSync] transaction for applicant ${applicant.id} could not be matched to a local card (multi-card applicant, no last-4 match) — raw: ${JSON.stringify(t).slice(0, 300)}`);
          continue;
        }
        const paid = Number(t.disccardPaid ?? t.cartAmount);
        if (t.id == null || !Number.isFinite(paid)) {
          malformed++;
          console.warn(`[cardSync] malformed transaction for applicant ${applicant.id} skipped — raw: ${JSON.stringify(t).slice(0, 300)}`);
          continue;
        }
        const type = t.type || (paid < 0 ? 'refund' : 'purchase');
        const amount = type === 'purchase' ? -Math.abs(paid) : Math.abs(paid);
        const storeName = t.vendor || t.store_name || t.merchant || '';
        const result = insertTxn.run(uuid(), cardId, String(t.id), type, amount, null, storeName, resolveStoreId(orgId, storeName), t.timestamp || t.occurred_at || null, JSON.stringify(t));
        if (result.changes) transactionsSynced++;
      } catch (e) {
        malformed++;
        console.warn(`[cardSync] transaction insert threw for applicant ${applicant.id}: ${e.message} — raw: ${JSON.stringify(t).slice(0, 300)}`);
      }
    }
    db.prepare(`UPDATE cards SET last_synced_at = datetime('now') WHERE applicant_id = ?`).run(applicant.id);
  }

  return { discovered, removed, transactionsSynced, unattributed, malformed };
}

// Compares our own ledger (approval-time card_amount + every shul_allocation
// since — see services/applicantBalance.js, merge-group aware) against
// disccardpromos' real remaining balance for the same customer, and flags a
// mismatch for an admin to review. `applicant` must be a merge-group's
// funding anchor (the primary, or a standalone applicant — see
// routes/applicants.js's fundingAnchor for the same concept) since that's
// whose external_id the one real shared disccardpromos customer is known
// under; calling this once per anchor (not once per group member) is the
// caller's responsibility (see syncAllCards below) since every member would
// otherwise compare against the exact same two numbers.
//
// Compares this app's `loaded` (the full total ever granted, per its own
// ledger) against disccardpromos' TOP-LEVEL `amount` — the committed total
// last written there, which does not move as the customer spends (real
// spend shows up in `packages[].balance` instead, and is deliberately NOT
// part of this comparison). Because both sides are "committed" figures, a
// disagreement in either direction is a real drift worth a flag; the
// earlier one-direction rule existed only because this used to read
// `packages[].amount` (always null) and mistook spend for drift.
//
// customerOverride: same convention as syncApplicantCards above — pass an
// already-fetched customer (or explicit null) to skip this function's own
// live GET when the caller already has one bulk pull's worth of data in
// hand (see syncAllCards). undefined falls back to the old per-anchor call.
export async function reconcileApplicantBalance(orgId, applicant, customerOverride) {
  if (!applicant.provider_account_id || applicant.provider_exempt) return null;
  const discountId = db.prepare(`SELECT value FROM settings WHERE org_id = ? AND key = 'disccardpromos_discount_id'`).get(orgId)?.value;
  if (!discountId) return null;
  let customer = customerOverride;
  if (customer === undefined) {
    try {
      customer = await giftcard.getCustomerByExternalId(applicant.season_id, applicant.external_id, { balances: true });
    } catch (e) {
      console.error('[cardSync] reconciliation fetch failed for applicant', applicant.id, ':', e.message);
      return null;
    }
  }
  if (!customer) return null;
  // CONFIRMED (STORE-TRANSACTIONS-INSTRUCTIONS.md): reconcile against the
  // TOP-LEVEL `amount` — the committed total this app last wrote, which
  // does NOT move as the customer spends — never `packages[].amount`
  // (always null; reading it as 0 made every account look out of sync).
  // Since this is the committed figure rather than a spendable balance, a
  // mismatch in EITHER direction is real: lower means a write was lost or
  // failed, higher means something outside this app's ledger added funds.
  if (customer.amount == null) return null;
  const actual = Math.round(Number(customer.amount) * 100) / 100;
  const expected = getApplicantBalances(orgId, [applicant.id]).get(applicant.id)?.loaded ?? 0;
  const diff = Math.round((actual - expected) * 100) / 100;

  const existing = db.prepare(`SELECT * FROM card_reconciliation_flags WHERE org_id = ? AND applicant_id = ? AND status = 'open'`).get(orgId, applicant.id);
  if (Math.abs(diff) <= 0.01) {
    if (existing) db.prepare(`UPDATE card_reconciliation_flags SET status = 'resolved', resolved_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(existing.id);
    return null;
  }
  if (existing) {
    db.prepare(`UPDATE card_reconciliation_flags SET expected_amount = ?, actual_amount = ?, updated_at = datetime('now') WHERE id = ?`).run(expected, actual, existing.id);
    return db.prepare('SELECT * FROM card_reconciliation_flags WHERE id = ?').get(existing.id);
  }
  const id = uuid();
  db.prepare(`INSERT INTO card_reconciliation_flags (id, org_id, applicant_id, expected_amount, actual_amount) VALUES (?,?,?,?,?)`)
    .run(id, orgId, applicant.id, expected, actual);
  const flag = db.prepare('SELECT * FROM card_reconciliation_flags WHERE id = ?').get(id);
  await notifyReconciliationMismatch(orgId, applicant, flag);
  return flag;
}

// Best-effort admin alert to the org's main support address (Settings >
// Organization) — no separate opt-in setting, since a real money mismatch
// should always be surfaced, not silently sit in a list nobody configured
// notifications for. Only fires once per NEW flag (see the existing-row
// branch above, which updates silently) so a mismatch that keeps not
// resolving doesn't re-email on every 15-minute sweep.
async function notifyReconciliationMismatch(orgId, applicant, flag) {
  const org = db.prepare('SELECT support_email FROM organizations WHERE id = ?').get(orgId);
  if (!org?.support_email) { console.error('[cardSync] reconciliation mismatch found for applicant', applicant.id, 'but no Settings > Organization support email is set to notify'); return; }
  const higher = flag.actual_amount > flag.expected_amount;
  const subject = `Card amount ${higher ? 'higher' : 'lower'} than expected: ${applicant.first_name || ''} ${applicant.last_name || ''}`.trim();
  const body = `<p>disccardpromos' committed amount for this applicant doesn't match this app's ledger${higher ? ' — it shows MORE than we ever loaded, which shouldn\'t be possible unless something outside this app added funds' : ' — it shows LESS than we loaded, which usually means a write was lost or failed'}. (This compares committed totals, not spendable balance — real store spend is not counted as a mismatch.)</p>
    <p><strong>${esc(applicant.first_name || '')} ${esc(applicant.last_name || '')}</strong> (external ID ${esc(applicant.external_id || '')})</p>
    <p>Our ledger says: <strong>$${flag.expected_amount.toFixed(2)}</strong><br>disccardpromos says: <strong>$${flag.actual_amount.toFixed(2)}</strong></p>
    <p>This has been flagged for review — see this applicant's Cards tab in the admin.</p>`;
  const { emailError } = await sendMailChecked(orgId, org.support_email, subject, body);
  if (emailError) console.error('[cardSync] reconciliation mismatch email failed:', emailError);
}
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// Sweeps every applicant with a disccardpromos account — cards, transactions,
// AND balance reconciliation together — used by the automatic background
// interval (see index.js, every 60s) and the "Sync All" button. This is
// what makes card activity/store spend "live" without someone having to
// click into each card individually. No-ops instantly per applicant in mock
// mode.
//
// FIXED (2026-09): used to make one live getCustomerByExternalId call per
// applicant for card/transaction sync, THEN a second one per merge-group
// anchor for balance reconciliation — up to 2N live calls every 60 seconds
// for N applicants. disccardpromos' own docs (confirmed directly, not
// inferred) show `balances` and `transactions` are both optional query
// params on the BULK list endpoint too (giftcard.js's listAllCustomers/
// buildCustomerIndex), not just the single-customer one — so this now pulls
// ONE bulk index per season touched by this sweep, with both flags on, and
// hands each applicant's own record out of that same index to both
// syncApplicantCards and reconcileApplicantBalance. A season whose index
// pull genuinely doesn't contain a given external_id (never created, or the
// bulk pull is momentarily behind) is treated as "no customer" for that
// applicant THIS sweep — never falls back to an extra live call, or every
// sweep would regress right back into one call per applicant, the exact
// thing this eliminates; it'll show up next time the bulk pull catches up
// (well within the 60-second cadence). An index build that fails outright
// (network error, or mock mode) IS a safe per-season fallback to the old
// one-call-per-applicant path, same "degrade to live lookups" convention
// used everywhere else this file's index pattern is used.
export async function syncAllCards(orgId) {
  const applicants = db.prepare(`SELECT * FROM applicants WHERE org_id = ? AND provider_account_id IS NOT NULL AND provider_exempt = 0`).all(orgId);
  const seasonIds = [...new Set(applicants.map(a => a.season_id))];
  const indexBySeason = new Map();
  for (const seasonId of seasonIds) {
    indexBySeason.set(seasonId, giftcard.isMockMode(seasonId) ? null : await giftcard.buildCustomerIndex(seasonId, { balances: true, transactions: true }));
  }
  // undefined (index missing/failed for this season) preserves
  // syncApplicantCards'/reconcileApplicantBalance's own live-fetch fallback;
  // a real index in hand always resolves to either the matched customer or
  // an explicit null ("confirmed absent this sweep") — see the function
  // comment above for why a miss never triggers an extra live call.
  const customerFor = (a) => {
    const index = indexBySeason.get(a.season_id);
    return index ? (index.byExt.get(String(a.external_id)) ?? null) : undefined;
  };

  // Real counts, surfaced in the "Sync All" toast (frontend/admin/cards.html)
  // — a fetch/index failure must never look identical to "nothing new",
  // which is how a sweep failing for half the org once passed as healthy.
  const indexPullsFailed = seasonIds.filter(s => !giftcard.isMockMode(s) && !indexBySeason.get(s)).length;
  let cardsDiscovered = 0, cardsRemoved = 0, totalSynced = 0, unattributed = 0, malformed = 0, failed = 0;
  for (const applicant of applicants) {
    try {
      const r = await syncApplicantCards(orgId, applicant, customerFor(applicant));
      cardsDiscovered += r.discovered || 0; cardsRemoved += r.removed || 0; totalSynced += r.transactionsSynced || 0;
      unattributed += r.unattributed || 0; malformed += r.malformed || 0;
    } catch (e) { failed++; console.error('[cardSync] sync failed for applicant', applicant.id, e.message); }
  }
  // Reconciliation runs once per merge-group funding ANCHOR (the primary,
  // or a standalone applicant — never a merge-group secondary, which shares
  // its group's one real disccardpromos customer and would just re-check
  // the exact same two numbers under a different applicant_id).
  let reconciliationFlags = 0;
  const anchors = applicants.filter(a => !a.merge_group_id || a.merge_group_id === a.id);
  for (const anchor of anchors) {
    try {
      const flag = await reconcileApplicantBalance(orgId, anchor, customerFor(anchor));
      if (flag) reconciliationFlags++;
    } catch (e) { console.error('[cardSync] balance reconciliation failed for applicant', anchor.id, e.message); }
  }
  // cardsChecked is shown to the admin as "Checked N card(s)" (see
  // frontend/admin/cards.html) — computed separately from the sync loop
  // above (which iterates applicants, not cards) purely so that toast still
  // reads as a card count.
  const cardsChecked = db.prepare(`SELECT COUNT(*) c FROM cards WHERE org_id = ? AND status IN ('assigned','activated')`).get(orgId).c;
  return { cardsChecked, transactionsSynced: totalSynced, cardsDiscovered, cardsRemoved, reconciliationFlags, unattributed, malformed, failed, indexPullsFailed };
}
