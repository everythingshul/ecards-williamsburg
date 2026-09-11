import { db, uuid } from '../db.js';
import * as giftcard from './giftcard.js';
import { resolveStoreId } from './storeMatch.js';
import { getApplicantBalances } from './applicantBalance.js';
import { sendMailChecked } from './mail.js';
import { scheduleProviderEnforceSoon } from './providerAccount.js';

// See syncApplicantCards' diagnostic comment below — logged at most once
// per process lifetime, not per applicant/sweep.
let loggedTransactionShapeOnce = false;

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
export async function syncApplicantCards(orgId, applicant) {
  if (!applicant.provider_account_id || applicant.provider_exempt) return { discovered: 0, removed: 0, transactionsSynced: 0 };
  let customer;
  try {
    customer = await giftcard.getCustomerByExternalId(applicant.season_id, applicant.external_id, { balances: true, transactions: true });
  } catch (e) {
    console.error('[cardSync] failed to fetch customer for card/transaction sync, applicant', applicant.id, ':', e.message);
    return { discovered: 0, removed: 0, transactionsSynced: 0 };
  }
  if (!customer) return { discovered: 0, removed: 0, transactionsSynced: 0 };
  const remoteMasked = new Set(Array.isArray(customer.active_cards) ? customer.active_cards : []);
  const localActive = db.prepare(`SELECT id, card_number_masked FROM cards WHERE applicant_id = ? AND status IN ('assigned','activated')`).all(applicant.id);
  const known = new Set(localActive.map(c => c.card_number_masked));

  // Package balance is the customer's aggregate — the best per-card figure
  // available, since disccardpromos doesn't expose a per-card balance
  // without a stable card id to ask about. `amount` (not `balance`) is the
  // real field name on a package per giftcard.js's own documented shape
  // (id/name/amount/rate) — this previously read `.balance`, which doesn't
  // exist on the real object and always evaluated to 0, so every
  // newly-discovered card was recorded locally with a $0 amount regardless
  // of its real balance.
  const balance = (customer.packages || []).reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
  let discovered = 0;
  for (const masked of remoteMasked) {
    if (known.has(masked)) continue;
    db.prepare(`INSERT INTO cards (id, org_id, applicant_id, season_id, card_number_masked, provider_card_id, status, amount, assigned_at, activated_at)
      VALUES (?,?,?,?,?,NULL,'activated',?,datetime('now'),datetime('now'))`)
      .run(uuid(), orgId, applicant.id, applicant.season_id, masked, balance);
    discovered++;
  }

  let removed = 0;
  const deactivate = db.prepare(`UPDATE cards SET status='deactivated', deactivated_at=datetime('now') WHERE id = ?`);
  for (const local of localActive) {
    if (remoteMasked.has(local.card_number_masked)) continue;
    deactivate.run(local.id);
    removed++;
  }

  // Transactions — every card this applicant has EVER held (not just the
  // currently-active ones above), so a purchase on a since-deactivated card
  // still lands in the ledger.
  const rawTxns = Array.isArray(customer.transactions) ? customer.transactions
    : Array.isArray(customer.transaction_history) ? customer.transaction_history : [];
  // Diagnostic, logged ONCE per process lifetime (not per applicant/sweep —
  // this would otherwise fire every minute for every applicant with no new
  // activity, which is most applicants most of the time): shows the real
  // customer response's top-level keys the first time transactions=true
  // comes back with nothing recognized as an array of transactions. If
  // disccardpromos' real field name isn't "transactions" or
  // "transaction_history" (both guesses — see the comment above), this is
  // the fastest way to find the real one instead of another guess.
  if (!rawTxns.length && customer && typeof customer === 'object' && !loggedTransactionShapeOnce) {
    loggedTransactionShapeOnce = true;
    console.log(`[cardSync] diagnostic (logged once): customer response's top-level keys when no transactions array was recognized: ${Object.keys(customer).join(', ')}`);
  }
  let transactionsSynced = 0;
  if (rawTxns.length) {
    const allLocal = db.prepare(`SELECT id, card_number_masked FROM cards WHERE applicant_id = ?`).all(applicant.id);
    const cardIdByMasked = new Map(allLocal.map(c => [c.card_number_masked, c.id]));
    // The overwhelmingly common case is one card per applicant — if that's
    // true here, attribute every transaction to it even if the per-
    // transaction card-identifying field turns out to use a name this app
    // doesn't recognize yet (transactions=true's exact response shape isn't
    // documented beyond the flag's existence — field names below are a
    // best guess, matched defensively like every other disccardpromos
    // response in this file). Only genuinely ambiguous (multi-card,
    // unmatched) transactions get skipped, and logged rather than silently
    // dropped, so a real shape mismatch is at least visible in server logs
    // instead of reproducing the exact "transactions don't show up" bug
    // this change fixes.
    const singleCardId = allLocal.length === 1 ? allLocal[0].id : null;
    const insertTxn = db.prepare(`INSERT OR IGNORE INTO card_transactions (id, card_id, provider_txn_id, type, amount, balance_after, store_name, store_id, occurred_at, raw_payload)
      VALUES (?,?,?,?,?,?,?,?,?,?)`);
    for (const t of rawTxns) {
      const masked = t.card_number || t.masked_card_number || t.card || t.card_number_masked || t.card_last4;
      const cardId = (masked && cardIdByMasked.get(masked)) || singleCardId;
      if (!cardId) {
        console.warn(`[cardSync] transaction for applicant ${applicant.id} could not be matched to a local card (multi-card applicant, no recognized card field) — raw: ${JSON.stringify(t).slice(0, 300)}`);
        continue;
      }
      const storeName = t.store_name || t.merchant || '';
      const result = insertTxn.run(uuid(), cardId, t.id || t.transaction_id, t.type || (t.amount < 0 ? 'purchase' : 'refund'), t.amount, t.balance_after ?? null, storeName, resolveStoreId(orgId, storeName), t.occurred_at || t.date, JSON.stringify(t));
      if (result.changes) transactionsSynced++;
    }
    db.prepare(`UPDATE cards SET last_synced_at = datetime('now') WHERE applicant_id = ?`).run(applicant.id);
  }

  return { discovered, removed, transactionsSynced };
}

// Compares our own ledger (approval-time card_amount + every shul_allocation
// since, minus spend — see services/applicantBalance.js, merge-group aware)
// against disccardpromos' real remaining balance for the same customer, and
// flags a mismatch for an admin to review. `applicant` must be a merge-
// group's funding anchor (the primary, or a standalone applicant — see
// routes/applicants.js's fundingAnchor for the same concept) since that's
// whose external_id the one real shared disccardpromos customer is known
// under; calling this once per anchor (not once per group member) is the
// caller's responsibility (see syncAllCards below) since every member would
// otherwise compare against the exact same two numbers.
// Never auto-corrects either side — this app doesn't assume which one is
// wrong. A newly-detected mismatch emails the org's support address (once,
// not on every sweep) and opens a card_reconciliation_flags row; a flag
// that's no longer reproducing (the numbers now agree, within a cent) is
// auto-resolved on the next sweep rather than needing a manual dismiss.
export async function reconcileApplicantBalance(orgId, applicant) {
  if (!applicant.provider_account_id || applicant.provider_exempt) return null;
  const discountId = db.prepare(`SELECT value FROM settings WHERE org_id = ? AND key = 'disccardpromos_discount_id'`).get(orgId)?.value;
  if (!discountId) return null;
  let customer;
  try {
    customer = await giftcard.getCustomerByExternalId(applicant.season_id, applicant.external_id, { balances: true });
  } catch (e) {
    console.error('[cardSync] reconciliation fetch failed for applicant', applicant.id, ':', e.message);
    return null;
  }
  if (!customer) return null;
  const pkg = (customer.packages || []).find(p => String(p.id) === String(discountId));
  const actual = Math.round((pkg ? Number(pkg.amount) || 0 : 0) * 100) / 100;
  const expected = getApplicantBalances(orgId, [applicant.id]).get(applicant.id)?.remaining ?? 0;
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
  const subject = `Card balance mismatch: ${applicant.first_name || ''} ${applicant.last_name || ''}`.trim();
  const body = `<p>Our records and disccardpromos disagree about this applicant's remaining card balance.</p>
    <p><strong>${esc(applicant.first_name || '')} ${esc(applicant.last_name || '')}</strong> (external ID ${esc(applicant.external_id || '')})</p>
    <p>Our ledger says: <strong>$${flag.expected_amount.toFixed(2)}</strong><br>disccardpromos says: <strong>$${flag.actual_amount.toFixed(2)}</strong></p>
    <p>This has been flagged for review — see this applicant's Cards tab in the admin.</p>`;
  const { emailError } = await sendMailChecked(orgId, org.support_email, subject, body);
  if (emailError) console.error('[cardSync] reconciliation mismatch email failed:', emailError);
}
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// Sweeps every applicant with a disccardpromos account — cards AND
// transactions together (one customer fetch each, see syncApplicantCards
// above) — used by the automatic background interval (see index.js) and
// the "Sync All" button. This is what makes card activity/store spend
// "live" without someone having to click into each card individually.
// No-ops instantly per applicant in mock mode.
//
// Used to run a SEPARATE loop first over `cards WHERE ... provider_card_id
// IS NOT NULL` for transactions — removed because that query matched zero
// real cards (provider_card_id is never set for a card discovered the
// normal way) and its own per-card sync hit an unconfirmed, likely-wrong
// endpoint anyway; see syncOneCard's comment for the full story. Every
// card and every transaction now comes from the one per-applicant
// customer fetch below.
export async function syncAllCards(orgId) {
  const applicants = db.prepare(`SELECT * FROM applicants WHERE org_id = ? AND provider_account_id IS NOT NULL AND provider_exempt = 0`).all(orgId);
  let cardsDiscovered = 0, cardsRemoved = 0, totalSynced = 0;
  for (const applicant of applicants) {
    try {
      const { discovered, removed, transactionsSynced } = await syncApplicantCards(orgId, applicant);
      cardsDiscovered += discovered; cardsRemoved += removed; totalSynced += transactionsSynced;
    } catch (e) { console.error('[cardSync] sync failed for applicant', applicant.id, e.message); }
  }
  // Reconciliation runs once per merge-group funding ANCHOR (the primary,
  // or a standalone applicant — never a merge-group secondary, which shares
  // its group's one real disccardpromos customer and would just re-check
  // the exact same two numbers under a different applicant_id).
  let reconciliationFlags = 0;
  const anchors = applicants.filter(a => !a.merge_group_id || a.merge_group_id === a.id);
  for (const anchor of anchors) {
    try {
      const flag = await reconcileApplicantBalance(orgId, anchor);
      if (flag) reconciliationFlags++;
    } catch (e) { console.error('[cardSync] balance reconciliation failed for applicant', anchor.id, e.message); }
  }
  // cardsChecked is shown to the admin as "Checked N card(s)" (see
  // frontend/admin/cards.html) — computed separately from the sync loop
  // above (which iterates applicants, not cards) purely so that toast still
  // reads as a card count.
  const cardsChecked = db.prepare(`SELECT COUNT(*) c FROM cards WHERE org_id = ? AND status IN ('assigned','activated')`).get(orgId).c;
  return { cardsChecked, transactionsSynced: totalSynced, cardsDiscovered, cardsRemoved, reconciliationFlags };
}
