import { db, uuid } from '../db.js';
import * as giftcard from './giftcard.js';
import { resolveStoreId } from './storeMatch.js';
import { getApplicantBalances } from './applicantBalance.js';
import { sendMailChecked } from './mail.js';

// Pulls new transactions for a single card from disccardpromos and inserts
// them into the ledger, resolving each to a known store where possible.
// Shared by the manual per-card "Sync Now" button and the automatic
// background sweep below.
export async function syncOneCard(orgId, card) {
  const txns = await giftcard.listTransactions(card.season_id, { providerCardId: card.provider_card_id, since: card.last_synced_at });
  const insert = db.prepare(`INSERT OR IGNORE INTO card_transactions (id, card_id, provider_txn_id, type, amount, balance_after, store_name, store_id, occurred_at, raw_payload)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  for (const t of txns) {
    const storeName = t.store_name || t.merchant || '';
    insert.run(uuid(), card.id, t.id || t.transaction_id, t.type || (t.amount < 0 ? 'purchase' : 'refund'), t.amount, t.balance_after ?? null, storeName, resolveStoreId(orgId, storeName), t.occurred_at || t.date, JSON.stringify(t));
  }
  db.prepare(`UPDATE cards SET last_synced_at = datetime('now') WHERE id = ?`).run(card.id);
  return txns.length;
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
    return { errors: [] };
  } catch (e) {
    console.error('[cardSync] failed to lock disccardpromos customer for applicant', applicant.id, ':', e.message);
    return { errors: [e.message] };
  }
}

// Reconciles a customer's actual active_cards (from disccardpromos' real,
// confirmed Customer API) against our local cards table in both directions:
//  - discovers cards activated directly on disccardpromos' own dashboard,
//    which this app would otherwise never learn about since they never went
//    through routes/cards.js's /assign.
//  - marks locally assigned/activated cards as removed once their masked
//    number is no longer in the customer's active_cards, so a card
//    unassigned/removed on disccardpromos' side stops showing as live here.
// Matches by masked number: disccardpromos has no stable per-card id at all
// (confirmed — see giftcard.js's linkCardToCustomer), so masked number is
// the only thing both sides agree on. Returns { discovered, removed } counts.
export async function syncApplicantCards(orgId, applicant) {
  if (!applicant.provider_account_id || applicant.provider_exempt) return { discovered: 0, removed: 0 };
  let customer;
  try {
    customer = await giftcard.getCustomerByExternalId(applicant.season_id, applicant.external_id, { balances: true });
  } catch (e) {
    console.error('[cardSync] failed to fetch customer for card discovery, applicant', applicant.id, ':', e.message);
    return { discovered: 0, removed: 0 };
  }
  if (!customer) return { discovered: 0, removed: 0 };
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
  return { discovered, removed };
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

// Sweeps every assigned/activated card in an org, and discovers any card
// activated straight on disccardpromos' own dashboard for every applicant
// who already has a customer there. Used by the automatic background
// interval (see index.js) and the "Sync All" button — this is what makes
// card activity/store spend "live" without someone having to click into
// each card individually. No-ops instantly per card in mock mode.
export async function syncAllCards(orgId) {
  const cards = db.prepare(`SELECT * FROM cards WHERE org_id = ? AND status IN ('assigned','activated') AND provider_card_id IS NOT NULL`).all(orgId);
  let totalSynced = 0;
  for (const card of cards) {
    try { totalSynced += await syncOneCard(orgId, card); }
    catch (e) { console.error('[cardSync] failed for card', card.id, e.message); }
  }
  const applicants = db.prepare(`SELECT * FROM applicants WHERE org_id = ? AND provider_account_id IS NOT NULL AND provider_exempt = 0`).all(orgId);
  let cardsDiscovered = 0, cardsRemoved = 0;
  for (const applicant of applicants) {
    try {
      const { discovered, removed } = await syncApplicantCards(orgId, applicant);
      cardsDiscovered += discovered; cardsRemoved += removed;
    } catch (e) { console.error('[cardSync] card discovery failed for applicant', applicant.id, e.message); }
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
  return { cardsChecked: cards.length, transactionsSynced: totalSynced, cardsDiscovered, cardsRemoved, reconciliationFlags };
}
