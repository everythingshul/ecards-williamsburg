import { db, uuid, DEFAULT_ORG_ID } from '../db.js';
import * as giftcard from './giftcard.js';
import { resolveStoreId } from './storeMatch.js';
import { getApplicantBalances } from './applicantBalance.js';
import { sendMailChecked } from './mail.js';
import { scheduleProviderEnforceSoon } from './providerAccount.js';
import { totalSpend, getSpendSnapshot, saveSpendSnapshot, setSnapshotStatus } from './spendTotals.js';
import { invalidateAggregates } from './aggCache.js';

// Last 4 digits of any masked card string, whatever mask convention it uses
// (`****1123`, `************1123`, `**** **** **** 1123`) — the only card
// identifier every side agrees on. See syncApplicantCards.
function last4(masked) { return String(masked ?? '').replace(/\D/g, '').slice(-4); }

// See the refund-detection comment in syncApplicantCards. No "return".
const REFUND_WORD = /\b(refund|refunded|reversal|reversed|void|voided|chargeback)\b/i;

const cleanProviderId = (id) => id == null ? null : String(id).replace(/\.0+$/, '');

// ONE place that turns a raw disccardpromos transaction into our stored shape
// (see syncApplicantCards for the confirmed field list and the refund /
// negative-purchase conventions), shared by the card_transactions insert and
// the unattributed one so the two can never classify a charge differently.
// Returns null when the entry has no id or no usable amount.
function normalizeTxn(t) {
  const paid = Number(t.disccardPaid ?? t.cartAmount ?? t.amount);
  if (t.id == null || !Number.isFinite(paid)) return null;
  const isRefund = paid < 0
    || t.is_refund === true || t.refund === true
    || [t.type, t.kind, t.transaction_type, t.status, t.description, t.note, t.vendor]
      .some(v => typeof v === 'string' && REFUND_WORD.test(v));
  const storeName = t.vendor || t.store_name || t.merchant || '';
  return {
    providerTxnId: cleanProviderId(String(t.id)),   // never store a ".0" form: it would count the same charge twice
    type: isRefund ? 'refund' : 'purchase',
    amount: isRefund ? Math.abs(paid) : -Math.abs(paid),
    storeName,
    occurredAt: t.timestamp || t.occurred_at || null,
  };
}

// Records a charge that has no card row of ours — by a disccardpromos
// customer not linked to any applicant, or by a linked applicant on a card we
// couldn't match. INSERT OR IGNORE on provider_txn_id, so re-running is safe.
// Returns the number of rows actually inserted (0 or 1).
function insertUnattributed(orgId, applicantId, t, customer = null) {
  const n = normalizeTxn(t);
  if (!n) return 0;
  // A charge is counted in exactly ONE table: if it's already a real card
  // transaction, it must never also be recorded as unattributed spend.
  if (db.prepare('SELECT 1 FROM card_transactions WHERE provider_txn_id IN (?, ?)').get(n.providerTxnId, n.providerTxnId + '.0')) return 0;
  const customerName = customer ? `${customer.first_name || ''} ${customer.last_name || ''}`.trim() : null;
  return db.prepare(`INSERT OR IGNORE INTO unattributed_transactions
    (id, org_id, applicant_id, provider_txn_id, type, amount, store_name, store_id, occurred_at, raw_payload, customer_id, customer_name)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(uuid(), orgId, applicantId || null, n.providerTxnId, n.type, n.amount, n.storeName, resolveStoreId(orgId, n.storeName), n.occurredAt, JSON.stringify(t),
      customer ? cleanProviderId(customer.id) : null, customerName || null).changes;
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
  invalidateAggregates();
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
//
// ctx (optional, supplied by syncAllCards — see its comment): { knownTxnIds,
// batch }. knownTxnIds is the set of provider charge ids ALREADY held in
// card_transactions, loaded once per sweep: a charge in it is skipped outright
// (no store lookup, no payload serialising, no insert attempt) — at tens of
// thousands of charges re-checked every minute that was most of the sweep's
// cost and froze the whole server while it ran. batch=true leaves the
// last_synced_at touch to one statement at the end of the sweep.
export async function syncApplicantCards(orgId, applicant, customerOverride, ctx = {}) {
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
  const localActive = db.prepare(`SELECT id, card_number_masked, amount FROM cards WHERE applicant_id = ? AND status IN ('assigned','activated')`).all(applicant.id);
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
      // Unchanged balance: nothing to write (a sweep used to rewrite every
      // card, every minute — thousands of commits for no change at all).
      if (ctx.batch && local.amount != null && Math.abs(Number(local.amount) - balance) < 0.005) continue;
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
  // still lands in the ledger. The field is `transactions` — confirmed live
  // (STORE-TRANSACTIONS-INSTRUCTIONS.md §3), only present with
  // ?transactions=true; an empty array just means no spend yet.
  const rawTxns = Array.isArray(customer.transactions) ? customer.transactions : [];
  let transactionsSynced = 0, unattributed = 0, malformed = 0;
  if (rawTxns.length) {
    const allLocal = db.prepare(`SELECT id, card_number_masked FROM cards WHERE applicant_id = ?`).all(applicant.id);
    const cardIdByLast4 = new Map(allLocal.map(c => [last4(c.card_number_masked), c.id]));
    const singleCardId = allLocal.length === 1 ? allLocal[0].id : null;
    const insertTxn = db.prepare(`INSERT OR IGNORE INTO card_transactions (id, card_id, provider_txn_id, type, amount, balance_after, store_name, store_id, occurred_at, raw_payload)
      VALUES (?,?,?,?,?,?,?,?,?,?)`);
    // A charge we now hold as a real card_transactions row must stop also
    // counting as an unattributed one (it was recorded there earlier, while
    // its customer wasn't linked to this applicant yet) — otherwise every
    // total would count it twice.
    const dropUnattributedStmt = db.prepare(`DELETE FROM unattributed_transactions WHERE org_id = ? AND provider_txn_id IN (?, ?)`);
    const dropUnattributed = { run: (org, id) => dropUnattributedStmt.run(org, id, id + '.0') };
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
    const known = ctx.knownTxnIds;
    for (const t of rawTxns) {
      try {
        // Already stored as a real card charge: nothing to do (see ctx above).
        if (known && t.id != null && known.has(cleanProviderId(t.id))) continue;
        const cardId = cardIdByLast4.get(last4(t.card)) || singleCardId;
        if (!cardId) {
          unattributed++;
          insertUnattributed(orgId, applicant.id, t, customer);
          console.warn(`[cardSync] transaction for applicant ${applicant.id} could not be matched to a local card (multi-card applicant, no last-4 match) — recorded as unattributed spend — raw: ${JSON.stringify(t).slice(0, 300)}`);
          continue;
        }
        const n = normalizeTxn(t);
        if (!n) {
          malformed++;
          console.warn(`[cardSync] malformed transaction for applicant ${applicant.id} skipped — raw: ${JSON.stringify(t).slice(0, 300)}`);
          continue;
        }
        // Refund/purchase classification and the sign convention (refund stored
        // positive, purchase negative) live in normalizeTxn above — see the SUM
        // convention in applicantBalance.js.
        const result = insertTxn.run(uuid(), cardId, n.providerTxnId, n.type, n.amount, null, n.storeName, resolveStoreId(orgId, n.storeName), n.occurredAt, JSON.stringify(t));
        if (result.changes) transactionsSynced++;
        if (known) known.add(cleanProviderId(n.providerTxnId));
        dropUnattributed.run(orgId, n.providerTxnId);
      } catch (e) {
        malformed++;
        console.warn(`[cardSync] transaction insert threw for applicant ${applicant.id}: ${e.message} — raw: ${JSON.stringify(t).slice(0, 300)}`);
      }
    }
    if (!ctx.batch) db.prepare(`UPDATE cards SET last_synced_at = datetime('now') WHERE applicant_id = ?`).run(applicant.id);
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
// balancesOverride (optional Map from getApplicantBalances for many
// applicants at once — supplied by syncAllCards) replaces the per-applicant
// balance query, which cost thousands of separate queries per sweep.
export async function reconcileApplicantBalance(orgId, applicant, customerOverride, balancesOverride) {
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
  const expected = (balancesOverride || getApplicantBalances(orgId, [applicant.id])).get(applicant.id)?.loaded ?? 0;
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

// Charges made by disccardpromos customers that NO applicant here is linked
// to. The per-applicant sync above only ever reads linked customers, so these
// were never stored and every spend total fell short of disccardpromos' own.
// Takes the bulk customer indexes the sweep already pulled (one per season)
// and records every transaction of every customer whose id isn't held by any
// applicant, via insertUnattributed (idempotent). If one of those customers
// is linked to an applicant later, syncApplicantCards records the same
// provider_txn_ids as real card transactions and drops these rows.
// The transactions a bulk-list customer record carries, whichever shape the
// provider used for them.
function embeddedTxns(c) {
  return Array.isArray(c?.transactions) ? c.transactions
    : (Array.isArray(c?.packages) ? c.packages.flatMap(p => Array.isArray(p.transactions) ? p.transactions : []) : []);
}

export function syncUnlinkedCustomers(orgId, indexes, coveredIds = null) {
  // Skip only customers the per-applicant sync really processed this sweep
  // (coveredIds). Merely "some applicant holds this account id" isn't enough:
  // the per-applicant sync finds its customer by external_id, so a customer
  // linked by account id whose external_id doesn't match would otherwise be
  // skipped by BOTH paths and its charges lost. Without coveredIds (a caller
  // outside the sweep) fall back to the account-id link.
  const linked = coveredIds || new Set(db.prepare(`SELECT provider_account_id FROM applicants WHERE org_id = ? AND provider_account_id IS NOT NULL`).all(orgId)
    .map(r => cleanProviderId(r.provider_account_id)));
  const seen = new Set();
  let unlinkedCustomers = 0, unlinkedTransactions = 0, unlinkedMalformed = 0;
  for (const index of indexes) {
    for (const c of index?.list || []) {
      const id = cleanProviderId(c.id);
      if (!id || linked.has(id) || seen.has(id)) continue;
      seen.add(id);
      const txns = embeddedTxns(c);
      if (!txns.length) continue;
      unlinkedCustomers++;
      for (const t of txns) {
        // An entry with no id / no usable amount used to vanish here without a
        // trace; now it is counted (and logged) like the per-applicant path does.
        if (!normalizeTxn(t)) { unlinkedMalformed++; console.warn(`[cardSync] malformed transaction from unlinked customer ${id} skipped — raw: ${JSON.stringify(t).slice(0, 300)}`); continue; }
        try { unlinkedTransactions += insertUnattributed(orgId, null, t, c); }
        catch (e) { unlinkedMalformed++; console.warn(`[cardSync] could not record a charge from unlinked customer ${id}: ${e.message}`); }
      }
    }
  }
  return { unlinkedCustomers, unlinkedTransactions, unlinkedMalformed };
}

// SPEND AUDIT — reconciles what disccardpromos itself returns right now
// against what is stored here, customer by customer, so a gap between our
// Total Spent and theirs is NAMED instead of guessed at. Takes the same bulk
// customer index(es) the sweep pulls (balances + transactions). For each
// customer it compares:
//   - the charges the provider lists (embedded transactions) with what we
//     hold in card_transactions / unattributed_transactions -> `missing`
//     (the provider has it, we never stored it: a sync that didn't run, an
//     entry we couldn't read, a customer we can't see);
//   - the spend implied by the provider's own balances (committed `amount`
//     minus the live package balances) with the charges it lists -> `feedGap`
//     (spend that reduced a balance but is NOT in the transaction list the
//     provider sends — nothing here can ever sync that).
// Also reports what we hold that the provider's feed no longer lists
// (`storedNotInFeed`: history of a deleted/merged account).
export function auditProviderSpend(orgId, indexes) {
  const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  const net = (n) => -n.amount; // purchases are stored negative (+spend), refunds positive (-spend)
  const stored = new Set();
  for (const r of db.prepare(`SELECT t.provider_txn_id id FROM card_transactions t JOIN cards c ON c.id = t.card_id WHERE c.org_id = ?`).all(orgId)) stored.add(cleanProviderId(r.id));
  for (const r of db.prepare(`SELECT provider_txn_id id FROM unattributed_transactions WHERE org_id = ?`).all(orgId)) stored.add(cleanProviderId(r.id));
  const linked = new Map();
  for (const a of db.prepare(`SELECT provider_account_id, first_name, last_name, external_id FROM applicants WHERE org_id = ? AND provider_account_id IS NOT NULL`).all(orgId)) {
    const k = cleanProviderId(a.provider_account_id); if (!linked.has(k)) linked.set(k, `${a.first_name || ''} ${a.last_name || ''}`.trim() || `#${a.external_id}`);
  }
  const sum = { customers: 0, customersWithCharges: 0, providerListedCount: 0, providerListedNet: 0, missingCount: 0, missingNet: 0, malformedCount: 0,
    balanceImpliedSpend: 0, feedGapNet: 0, feedGapCustomers: 0, customersWithoutAmount: 0 };
  const rows = []; const seen = new Set();
  for (const index of indexes || []) {
    for (const c of index?.list || []) {
      const id = cleanProviderId(c.id);
      if (!id || seen.has(id)) continue; seen.add(id); sum.customers++;
      let listedNet = 0, listedCount = 0, missNet = 0, missCount = 0, bad = 0;
      for (const t of embeddedTxns(c)) {
        const n = normalizeTxn(t);
        if (!n) { bad++; continue; }
        listedCount++; listedNet += net(n);
        if (!stored.has(cleanProviderId(n.providerTxnId))) { missCount++; missNet += net(n); }
      }
      if (listedCount) sum.customersWithCharges++;
      const amount = c.amount != null && c.amount !== '' ? Number(c.amount) : NaN;
      let balanceSpent = null, feedGap = null;
      if (Number.isFinite(amount)) {
        const bal = (Array.isArray(c.packages) ? c.packages : []).reduce((s, p) => s + (Number(p.balance) || 0), 0);
        balanceSpent = r2(Math.max(0, amount - bal)); feedGap = r2(balanceSpent - listedNet);
        sum.balanceImpliedSpend += balanceSpent;
        if (Math.abs(feedGap) >= 0.01) { sum.feedGapNet += feedGap; sum.feedGapCustomers++; }
      } else sum.customersWithoutAmount++;
      sum.providerListedCount += listedCount; sum.providerListedNet += listedNet; sum.missingCount += missCount; sum.missingNet += missNet; sum.malformedCount += bad;
      if (missCount || bad || (feedGap != null && Math.abs(feedGap) >= 0.01)) {
        rows.push({ customerId: id, externalId: c.external_id != null ? String(c.external_id) : '', name: `${c.first_name || ''} ${c.last_name || ''}`.trim(),
          linkedTo: linked.get(id) || '', listedCount, listedNet: r2(listedNet), missingCount: missCount, missingNet: r2(missNet), malformed: bad,
          balanceSpent, feedGap });
      }
    }
  }
  const ours = totalSpend(orgId).ledger;   // the transaction ledger, not the balance-based headline
  const storedInFeed = sum.providerListedNet - sum.missingNet;
  for (const k of ['providerListedNet', 'missingNet', 'balanceImpliedSpend', 'feedGapNet']) sum[k] = r2(sum[k]);
  rows.sort((a, b) => Math.max(Math.abs(b.missingNet), Math.abs(b.feedGap || 0)) - Math.max(Math.abs(a.missingNet), Math.abs(a.feedGap || 0)));
  return { summary: { ...sum, ourTotalSpent: ours, storedNotInFeed: r2(ours - storedInFeed) }, rows };
}

// TOTAL SPENT SNAPSHOT. From the same bulk customer pull the sweep already made
// (balances included), sums what disccardpromos itself implies was spent:
// per customer, loaded `amount` minus the current package balance(s) — exactly
// their own arithmetic, so it does not depend on their charge list being
// complete (it is not: see Spend Audit's feedGap) and cannot drift the way a
// running tally of charges can. Stored whole (services/spendTotals.js) and read
// by totalSpend(). It is replaced ONLY by a pull that passes every check below;
// otherwise the previous snapshot stands (and goes stale after 6 hours, when
// totalSpend() falls back to the ledger). Returns { ok, reason?, ... }.
let lastSnapshotReason = null;
export function recordSpendSnapshot(orgId, indexes) {
  const fail = (reason) => {
    if (reason !== lastSnapshotReason) console.warn(`[cardSync] spend snapshot NOT updated: ${reason}`);
    lastSnapshotReason = reason;
    setSnapshotStatus(reason);
    return { ok: false, reason };
  };
  if (!indexes.length || indexes.some(i => !i || !Array.isArray(i.list))) return fail('a customer pull failed or is unavailable (mock mode)');
  for (const i of indexes) {
    const rt = i.list.reportedTotal;
    if (typeof rt === 'number' && i.list.length < rt) return fail(`pull incomplete: collected ${i.list.length} of ${rt} customers`);
  }
  const seen = new Set();
  let spent = 0, listedNet = 0, customers = 0, unreadable = 0, anyReported = false;
  let noAmount = 0, noBalance = 0, sample = null;   // why customers are unreadable (shown on the Dashboard)
  for (const i of indexes) {
    if (typeof i.list.reportedTotal === 'number') anyReported = true;
    for (const c of i.list) {
      const id = cleanProviderId(c?.id);
      if (!id || seen.has(id)) continue;
      seen.add(id); customers++;
      for (const t of embeddedTxns(c)) { const n = normalizeTxn(t); if (n) listedNet += -n.amount; }   // purchases are stored negative, refunds positive
      const amount = c.amount != null && c.amount !== '' ? Number(c.amount) : NaN;
      const pkgs = Array.isArray(c.packages) ? c.packages : [];
      const withBalance = pkgs.filter(p => p && p.balance != null && p.balance !== '' && Number.isFinite(Number(p.balance)));
      if (!Number.isFinite(amount) || (amount !== 0 && !withBalance.length)) {
        unreadable++;
        if (!Number.isFinite(amount)) noAmount++; else noBalance++;
        // one redacted example of the shape (field names + numbers only, never names/contact details)
        if (!sample) sample = JSON.stringify({ fields: Object.keys(c).slice(0, 30), amount: c.amount ?? null, packages: pkgs.slice(0, 3).map(p => ({ fields: Object.keys(p || {}).slice(0, 12), id: p?.id ?? null, amount: p?.amount ?? null, balance: p?.balance ?? null })) });
        continue;
      }
      const balance = withBalance.reduce((t, p) => t + Number(p.balance), 0);
      spent += Math.max(0, amount - balance);
    }
  }
  if (!customers) return fail('the pull contained no customers');
  // Customers with no amount / no balance (never loaded, or not reported) are IGNORED for the balance figure — not
  // every disccardpromos customer has one. Guard only against a pull that suddenly lost most of the readable ones.
  const readable = customers - unreadable;
  if (readable <= 0) return fail(`none of the ${customers} customers has a readable amount/balance. Example: ${sample}`);
  const prevForReadable = getSpendSnapshot(orgId);
  if (prevForReadable && readable < (prevForReadable.customers - prevForReadable.unreadable) * 0.8) return fail(`only ${readable} customers have a readable amount/balance vs ${prevForReadable.customers - prevForReadable.unreadable} last time`);
  const prev = getSpendSnapshot(orgId);
  // A truncated pull that does not say so: far fewer customers than last time.
  if (prev && !anyReported && customers < prev.customers * 0.95) return fail(`only ${customers} customers vs ${prev.customers} last time and disccardpromos did not report a total`);
  saveSpendSnapshot(orgId, { spent, listedNet, customers, unreadable });
  lastSnapshotReason = null;
  setSnapshotStatus(null);
  return { ok: true, spent: Math.round(spent * 100) / 100, listedNet: Math.round(listedNet * 100) / 100, customers, unreadable };
}

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
// (network error) SKIPS that season for this sweep — it never degrades to
// one live call per applicant (see customerFor below for the incident that
// rule comes from).
export async function syncAllCards(orgId) {
  const applicants = db.prepare(`SELECT * FROM applicants WHERE org_id = ? AND provider_account_id IS NOT NULL AND provider_exempt = 0`).all(orgId);
  const seasonIds = [...new Set(applicants.map(a => a.season_id))];
  const indexBySeason = new Map();
  for (const seasonId of seasonIds) {
    indexBySeason.set(seasonId, giftcard.isMockMode(seasonId) ? null : await giftcard.buildCustomerIndex(seasonId, { balances: true, transactions: true }));
  }
  // EMERGENCY FIX (2026-09-17): this sweep must NEVER make one live call per
  // applicant. It used to hand `undefined` to syncApplicantCards/
  // reconcileApplicantBalance for a season whose bulk index pull failed,
  // which triggered their per-applicant live GET fallback — 2N calls to
  // disccardpromos every 60 seconds for as long as the bulk pull kept
  // failing. A failed index now means that season is SKIPPED this sweep
  // (explicit null = "nothing to sync from", never "go look it up
  // yourself"), reported via indexPullsFailed, and retried on the next
  // sweep. The per-applicant live path remains only for the manual "Sync
  // Now" click on a single card (syncOneCard), where there's no batch.
  const customerFor = (a) => {
    const index = indexBySeason.get(a.season_id);
    return index ? (index.byExt.get(String(a.external_id)) ?? null) : null;
  };

  // Real counts, surfaced in the "Sync All" toast (frontend/admin/cards.html)
  // — a fetch/index failure must never look identical to "nothing new",
  // which is how a sweep failing for half the org once passed as healthy.
  const indexPullsFailed = seasonIds.filter(s => !giftcard.isMockMode(s) && !indexBySeason.get(s)).length;
  let cardsDiscovered = 0, cardsRemoved = 0, totalSynced = 0, unattributed = 0, malformed = 0, failed = 0;
  const coveredCustomerIds = new Set();
  // PERFORMANCE (a sweep took ~16s at 150K charges and froze every request for
  // ~12s of it, once a minute): (1) every charge already stored is skipped
  // outright via one in-memory set; (2) unchanged cards are not rewritten;
  // (3) the loop hands control back to the event loop every few applicants, so
  // page requests are answered between chunks instead of waiting out the
  // whole sweep. No transaction is held open across those pauses.
  const ctx = { batch: true, knownTxnIds: new Set(db.prepare(`SELECT provider_txn_id id FROM card_transactions WHERE provider_txn_id IS NOT NULL`).all().map(r => cleanProviderId(r.id))) };
  const yieldNow = () => new Promise(resolve => setImmediate(resolve));
  let sinceYield = 0;
  for (const applicant of applicants) {
    try {
      const customer = customerFor(applicant);
      const r = await syncApplicantCards(orgId, applicant, customer, ctx);
      if (customer) coveredCustomerIds.add(cleanProviderId(customer.id));
      cardsDiscovered += r.discovered || 0; cardsRemoved += r.removed || 0; totalSynced += r.transactionsSynced || 0;
      unattributed += r.unattributed || 0; malformed += r.malformed || 0;
    } catch (e) { failed++; console.error('[cardSync] sync failed for applicant', applicant.id, e.message); }
    if (++sinceYield >= 25) { sinceYield = 0; await yieldNow(); }
  }
  // one statement instead of one commit per applicant
  db.prepare(`UPDATE cards SET last_synced_at = datetime('now') WHERE applicant_id IN (SELECT id FROM applicants WHERE org_id = ? AND provider_account_id IS NOT NULL AND provider_exempt = 0)`).run(orgId);
  let unlinked = { unlinkedCustomers: 0, unlinkedTransactions: 0 };
  try { unlinked = syncUnlinkedCustomers(orgId, [...indexBySeason.values()].filter(Boolean), coveredCustomerIds); }
  catch (e) { console.error('[cardSync] unlinked-customer sync failed:', e.message); }
  // Reconciliation runs once per merge-group funding ANCHOR (the primary,
  // or a standalone applicant — never a merge-group secondary, which shares
  // its group's one real disccardpromos customer and would just re-check
  // the exact same two numbers under a different applicant_id).
  let reconciliationFlags = 0;
  const anchors = applicants.filter(a => !a.merge_group_id || a.merge_group_id === a.id);
  // one balance computation for every anchor instead of one query set each
  let anchorBalances = null;
  try { anchorBalances = getApplicantBalances(orgId, anchors.map(a => a.id)); } catch (e) { console.error('[cardSync] batched balances failed, falling back per applicant:', e.message); }
  sinceYield = 0;
  for (const anchor of anchors) {
    try {
      const flag = await reconcileApplicantBalance(orgId, anchor, customerFor(anchor), anchorBalances);
      if (flag) reconciliationFlags++;
    } catch (e) { console.error('[cardSync] balance reconciliation failed for applicant', anchor.id, e.message); }
    if (++sinceYield >= 100) { sinceYield = 0; await yieldNow(); }
  }
  // cardsChecked is shown to the admin as "Checked N card(s)" (see
  // frontend/admin/cards.html) — computed separately from the sync loop
  // above (which iterates applicants, not cards) purely so that toast still
  // reads as a card count.
  let spendSnapshot = { ok: false, reason: 'not attempted' };
  try {
    // only when EVERY season's pull succeeded this sweep
    if (indexPullsFailed) { spendSnapshot = { ok: false, reason: `${indexPullsFailed} customer pull(s) failed` }; setSnapshotStatus(`${indexPullsFailed} disccardpromos customer pull(s) failed this sweep`); }
    else spendSnapshot = recordSpendSnapshot(orgId, seasonIds.map(sid => indexBySeason.get(sid)));
  } catch (e) { console.error('[cardSync] spend snapshot failed:', e.message); setSnapshotStatus(`error while computing it: ${e.message}`); }
  invalidateAggregates();
  const cardsChecked = db.prepare(`SELECT COUNT(*) c FROM cards WHERE org_id = ? AND status IN ('assigned','activated')`).get(orgId).c;
  return { cardsChecked, spendSnapshot, transactionsSynced: totalSynced, cardsDiscovered, cardsRemoved, reconciliationFlags, unattributed, malformed, failed, indexPullsFailed, ...unlinked };
}
