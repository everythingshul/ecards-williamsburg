import { Router } from 'express';
import { db, uuid } from '../db.js';
import { auth } from '../middleware/auth.js';
import { requirePermission, redact } from '../middleware/permissions.js';
import * as giftcard from '../services/giftcard.js';
import { sendXlsx } from '../services/xlsx.js';
import { syncOneCard, syncAllCards, auditProviderSpend } from '../services/cardSync.js';
import { getActiveSeasonId } from '../utils/formSchedule.js';
import { logAudit } from '../services/audit.js';
import { normalizePhone, isValidPhone } from '../utils/phone.js';
import { resolveFundingAnchor } from '../services/providerAccount.js';
import { getApplicantBalances } from '../services/applicantBalance.js';
import { totalSpend, unattributedNet } from '../services/spendTotals.js';

const router = Router();
router.use(auth, requirePermission('cards'));

router.get('/', (req, res) => {
  const { search, status, season_id, page = 1, pageSize = 50 } = req.query;
  let where = 'WHERE c.org_id = ?';
  const params = [req.user.org_id];
  if (status) { where += ' AND c.status = ?'; params.push(status); }
  if (season_id) { where += ' AND c.season_id = ?'; params.push(season_id); }
  if (search) {
    where += ` AND (a.first_name LIKE ? OR a.last_name LIKE ? OR (a.first_name || ' ' || a.last_name) LIKE ? OR c.card_number_masked LIKE ?)`;
    const like = `%${search}%`;
    params.push(like, like, like, like);
  }
  const total = db.prepare(`SELECT COUNT(*) c FROM cards c LEFT JOIN applicants a ON a.id=c.applicant_id ${where}`).get(...params).c;
  const offset = (Math.max(1, +page) - 1) * +pageSize;
  const rows = db.prepare(`SELECT c.*, a.first_name, a.last_name, a.email, s.name_en as shul_name
    FROM cards c LEFT JOIN applicants a ON a.id=c.applicant_id LEFT JOIN shuls s ON s.id=a.shul_id
    ${where} ORDER BY c.created_at DESC LIMIT ? OFFSET ?`).all(...params, +pageSize, offset);
  // mockMode here is a UI badge, not action-critical — a list spanning
  // multiple seasons with different overrides has no single true answer, so
  // report the filtered season's status if one's selected, else the
  // org-wide default every season without its own override actually uses.
  res.json({ cards: redact(rows, req.permission.hidden_fields), total, page: +page, pageSize: +pageSize, mockMode: giftcard.isMockMode(season_id || null) });
});

// Full-detail CSV export — every field, no pagination. Must be registered before /:id.
router.get('/export', requirePermission('cards', 'can_export'), (req, res) => {
  const { search, status, season_id } = req.query;
  let where = 'WHERE c.org_id = ?';
  const params = [req.user.org_id];
  if (status) { where += ' AND c.status = ?'; params.push(status); }
  if (season_id) { where += ' AND c.season_id = ?'; params.push(season_id); }
  if (search) {
    where += ` AND (a.first_name LIKE ? OR a.last_name LIKE ? OR (a.first_name || ' ' || a.last_name) LIKE ? OR c.card_number_masked LIKE ?)`;
    const like = `%${search}%`;
    params.push(like, like, like, like);
  }
  const rows = db.prepare(`SELECT c.*, a.first_name, a.last_name, a.email, s.name_en as shul_name
    FROM cards c LEFT JOIN applicants a ON a.id=c.applicant_id LEFT JOIN shuls s ON s.id=a.shul_id
    ${where} ORDER BY c.created_at DESC`).all(...params);
  sendXlsx(res, `cards-${Date.now()}.xlsx`, redact(rows, req.permission.hidden_fields));
});

// Per-shul rollup: how much of the money loaded onto that shul's applicants'
// cards has actually been spent so far. Must be registered before /:id (same
// reason as /export above — otherwise Express matches "by-shul" as an :id).
// "Allocated" is every approved applicant's committed card_amount for the
// shul — one row per applicant, same source the Dashboard's "Total Loaded"
// sums org-wide. FIXED (DASHBOARD-STORELINK-INSTRUCTIONS.md §1): this used
// to join through `cards` and SUM(cards.amount) per card row, so any
// applicant with more than one card row (a replaced card never deactivated,
// or two cards sharing one disccardpromos account — cardSync writes the
// same account-level balance onto every one of their rows) was counted two
// or three times. "Spent" is net of refunds, joined through cards/
// card_transactions (that half was already right).
//
// In THIS app most card money arrives through shul Gives (shul_allocations
// — base + match), not the approval-time card_amount, which is often $0 —
// so "Allocated" is the same per-applicant `loaded` figure
// services/applicantBalance.js computes (card_amount for approved
// applicants + every allocation row, reversals netting out, minus any
// merged_spend_adjustment, plus/minus any merged_funding_adjustment — see
// db.js for why those are two separate columns), summed over the applicants
// belonging to each shul. Named parameters, since the optional season
// filter repeats.
router.get('/by-shul', (req, res) => {
  const { season_id } = req.query;
  const seasonClause = season_id ? ' AND a2.season_id = @season_id' : '';
  const params = { org_id: req.user.org_id };
  if (season_id) params.season_id = season_id;
  const rows = db.prepare(`
    SELECT s.id AS shul_id, s.name_en AS shul_name,
      COALESCE((SELECT SUM(a2.card_amount) FROM applicants a2
        WHERE a2.shul_id = s.id AND a2.approval_status = 'approved'${seasonClause}), 0)
      + COALESCE((SELECT SUM(sa.total_amount) FROM shul_allocations sa JOIN applicants a2 ON a2.id = sa.applicant_id
        WHERE a2.shul_id = s.id${seasonClause}), 0)
      - COALESCE((SELECT SUM(a2.merged_spend_adjustment) FROM applicants a2
        WHERE a2.shul_id = s.id${seasonClause}), 0)
      + COALESCE((SELECT SUM(a2.merged_funding_adjustment) FROM applicants a2
        WHERE a2.shul_id = s.id${seasonClause}), 0) AS allocated,
      COALESCE((SELECT SUM(CASE WHEN t.type = 'refund' THEN -t.amount WHEN t.amount < 0 THEN -t.amount ELSE 0 END)
        FROM card_transactions t JOIN cards c2 ON c2.id = t.card_id JOIN applicants a2 ON a2.id = c2.applicant_id
        WHERE a2.shul_id = s.id AND c2.org_id = @org_id${seasonClause}), 0)
      + COALESCE((SELECT SUM(CASE WHEN u.type = 'refund' THEN -u.amount WHEN u.amount < 0 THEN -u.amount ELSE 0 END)
        FROM unattributed_transactions u JOIN applicants a2 ON a2.id = u.applicant_id
        WHERE a2.shul_id = s.id AND u.org_id = @org_id${seasonClause}), 0) AS spent
    FROM shuls s
    WHERE s.org_id = @org_id
    GROUP BY s.id
    HAVING allocated > 0
    ORDER BY allocated DESC`).all(params);
  // Charges by disccardpromos customers not linked to any applicant belong to
  // no shul — returned separately so this tab's total still adds up to Total Spent.
  const unlinked = unattributedNet(req.user.org_id, { seasonId: season_id, noApplicant: true });
  res.json({
    shuls: rows.map(r => ({ ...r, allocated: Math.round(r.allocated * 100) / 100, spent: Math.round(r.spent * 100) / 100, remaining: Math.round((r.allocated - r.spent) * 100) / 100 })),
    unattributed: { spent: unlinked.net, transactionCount: unlinked.count },
  });
});

// Open card-balance-vs-disccardpromos mismatches (see services/cardSync.js's
// reconcileApplicantBalance, run automatically as part of every sync sweep)
// — never auto-corrected, an admin reviews and resolves each one by hand.
// Must be registered before /:id (same reason as /export and /by-shul above
// — otherwise Express matches "reconciliation-flags" as an :id).
router.get('/reconciliation-flags', (req, res) => {
  const rows = db.prepare(`SELECT f.*, a.first_name, a.last_name, a.external_id FROM card_reconciliation_flags f
    JOIN applicants a ON a.id = f.applicant_id WHERE f.org_id = ? AND f.status = 'open' ORDER BY f.detected_at DESC`).all(req.user.org_id);
  res.json({ flags: rows });
});
router.post('/reconciliation-flags/:id/resolve', requirePermission('cards', 'can_edit'), (req, res) => {
  const flag = db.prepare(`SELECT * FROM card_reconciliation_flags WHERE id = ? AND org_id = ?`).get(req.params.id, req.user.org_id);
  if (!flag) return res.status(404).json({ error: 'Not found' });
  if (flag.status !== 'open') return res.status(400).json({ error: 'Already resolved' });
  db.prepare(`UPDATE card_reconciliation_flags SET status = 'resolved', resolved_by = ?, resolved_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`)
    .run(req.user.id, flag.id);
  res.json({ ok: true });
});

// Unlike /resolve above (which ONLY dismisses the flag — see its own
// comment — never touches either side's real balance), this actually
// CORRECTS disccardpromos: pushes this app's own ledger total (the same
// figure every other write in this app now treats as ground truth — see
// services/giftcard.js's setPackageAmountAbsolute) onto the customer's real
// package balance, then marks the flag resolved. Exists because a flag
// left open forever doesn't fix itself — nothing in this app auto-corrects
// a mismatch once detected (reconcileApplicantBalance's own comment: "this
// app doesn't assume which side is wrong"), so a real, accumulated
// discrepancy (e.g. from a write that failed before a bug fix landed) just
// sits there being reported on every sweep until an admin does something
// about it. This is that "something."
async function fixOneFlag(orgId, userId, flag) {
  const applicant = db.prepare('SELECT * FROM applicants WHERE id = ?').get(flag.applicant_id);
  if (!applicant) throw new Error('Applicant not found');
  const discountId = db.prepare(`SELECT value FROM settings WHERE org_id = ? AND key = 'disccardpromos_discount_id'`).get(orgId)?.value;
  if (!discountId) throw new Error('No disccardpromos Package/Discount ID configured (Settings > Organization > Gift Card Loading).');
  const fundingAnchor = resolveFundingAnchor(applicant);
  if (!fundingAnchor.provider_account_id) throw new Error('This applicant has no disccardpromos account on file.');
  // Pushes `loaded`, not `remaining` — see services/matching.js's
  // createAllocation for why (disccardpromos deducts real store spend from
  // "amount" automatically, so this app must never subtract its own
  // locally-tracked spend before writing).
  const expected = getApplicantBalances(orgId, [applicant.id]).get(applicant.id)?.loaded ?? 0;
  await giftcard.setPackageAmountAbsolute(applicant.season_id, { customerId: fundingAnchor.provider_account_id, externalId: fundingAnchor.external_id, totalAmount: expected, discountId });
  db.prepare(`UPDATE card_reconciliation_flags SET status = 'resolved', resolved_by = ?, resolved_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`)
    .run(userId, flag.id);
  return expected;
}

router.post('/reconciliation-flags/:id/fix', requirePermission('cards', 'can_edit'), async (req, res) => {
  const flag = db.prepare(`SELECT * FROM card_reconciliation_flags WHERE id = ? AND org_id = ?`).get(req.params.id, req.user.org_id);
  if (!flag) return res.status(404).json({ error: 'Not found' });
  if (flag.status !== 'open') return res.status(400).json({ error: 'Already resolved' });
  try {
    const pushedAmount = await fixOneFlag(req.user.org_id, req.user.id, flag);
    res.json({ ok: true, pushedAmount });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Bulk version — fixes every currently-open flag in one click, since a
// history of past (now-fixed) write bugs can leave dozens of these sitting
// around, and correcting each one individually is exactly the kind of
// tedious, repetitive task this should never require. Best-effort per
// flag: one failure (e.g. a transient disccardpromos error) doesn't stop
// the rest — every outcome is reported back so nothing fails silently.
router.post('/reconciliation-flags/fix-all', requirePermission('cards', 'can_edit'), async (req, res) => {
  const flags = db.prepare(`SELECT * FROM card_reconciliation_flags WHERE org_id = ? AND status = 'open'`).all(req.user.org_id);
  let fixed = 0;
  const failures = [];
  for (const flag of flags) {
    try { await fixOneFlag(req.user.org_id, req.user.id, flag); fixed++; }
    catch (e) {
      const a = db.prepare('SELECT first_name, last_name FROM applicants WHERE id = ?').get(flag.applicant_id);
      failures.push({ applicantId: flag.applicant_id, name: a ? `${a.first_name} ${a.last_name}`.trim() : flag.applicant_id, error: e.message });
    }
  }
  res.json({ ok: true, total: flags.length, fixed, failures });
});

// Spend audit: one live pull of every disccardpromos customer (balances +
// charges) reconciled against what is stored here — see auditProviderSpend.
// Read-only; ?export=1 downloads every row as Excel. Registered before /:id.
router.get('/spend-audit', requirePermission('cards', 'can_view'), async (req, res) => {
  const orgId = req.user.org_id;
  const seasonIds = [getActiveSeasonId(orgId), ...db.prepare('SELECT DISTINCT season_id FROM applicants WHERE org_id = ? AND season_id IS NOT NULL').all(orgId).map(r => r.season_id)].filter(Boolean);
  const seasonId = seasonIds.find(s => !giftcard.isMockMode(s));
  if (!seasonId) return res.json({ mock: true, message: 'disccardpromos is not connected (mock mode), so there is nothing live to compare against.' });
  let index;
  try { index = await giftcard.buildCustomerIndex(seasonId, { balances: true, transactions: true }); }
  catch (e) { return res.status(502).json({ error: `Could not read disccardpromos: ${e.message}` }); }
  if (!index) return res.status(502).json({ error: 'Could not read the customer list from disccardpromos (see the server log for the failing call). Try again.' });
  const audit = auditProviderSpend(orgId, [index]);
  if (req.query.export) {
    return sendXlsx(res, `spend-audit-${new Date().toISOString().slice(0, 10)}.xlsx`, audit.rows.map(r => ({
      'disccardpromos Customer #': r.customerId, 'External ID': r.externalId, 'Name': r.name, 'Linked to applicant': r.linkedTo,
      'Charges listed by disccardpromos': r.listedCount, 'Net spend listed': r.listedNet, 'Listed but NOT stored here (count)': r.missingCount,
      'Listed but NOT stored here ($)': r.missingNet, 'Unreadable entries': r.malformed, 'Spend implied by balances': r.balanceSpent, 'Spend not in charge list ($)': r.feedGap })));
  }
  logAudit(orgId, req.user.id, 'spend_audit', 'cards', null, null, audit.summary, req.ip);
  res.json({ ...audit, rows: audit.rows.slice(0, 200), totalRows: audit.rows.length, pulledCustomers: index.list.length, reportedTotal: index.list.reportedTotal ?? null });
});

router.get('/:id', (req, res) => {
  const card = db.prepare(`SELECT c.*, a.first_name, a.last_name, a.husband_cell, a.wife_cell, a.home_phone
    FROM cards c LEFT JOIN applicants a ON a.id=c.applicant_id WHERE c.id = ? AND c.org_id = ?`).get(req.params.id, req.user.org_id);
  if (!card) return res.status(404).json({ error: 'Not found' });
  const transactions = db.prepare('SELECT * FROM card_transactions WHERE card_id = ? ORDER BY occurred_at DESC').all(card.id);
  res.json({ card, transactions });
});

// Assign a card to an approved applicant. Per disccardpromos' real Customer
// API docs, there is no "give me a fresh card" endpoint — the org already
// holds real physical card numbers, and "assigning" one means PATCHing the
// applicant's disccardpromos customer with that exact card_number, which
// activates it for them. So card_number here must be an actual physical
// number in hand (e.g. from a batch of pre-printed cards), not something
// this app generates — replaces the old giftcard.assignCard(), which called
// a guessed, never-confirmed /cards/assign path.
router.post('/assign', requirePermission('cards', 'can_edit'), async (req, res) => {
  const { applicant_id, card_number } = req.body || {};
  if (!card_number) return res.status(400).json({ error: 'A real card number is required — disccardpromos activates an existing physical card, it does not generate one' });
  const applicant = db.prepare('SELECT * FROM applicants WHERE id = ? AND org_id = ?').get(applicant_id, req.user.org_id);
  if (!applicant) return res.status(404).json({ error: 'Applicant not found' });
  if (applicant.approval_status !== 'approved') return res.status(400).json({ error: 'Applicant must be approved before a card is assigned' });
  if (applicant.is_paused) return res.status(423).json({ error: 'Applicant is paused pending duplicate resolution' });
  if (!applicant.provider_account_id) return res.status(400).json({ error: 'This applicant has no disccardpromos customer on file yet — re-approve them first so one gets created' });
  const finalAmount = applicant.card_amount ?? 0;
  let result;
  try {
    result = await giftcard.linkCardToCustomer(applicant.season_id, applicant.provider_account_id, card_number, applicant.external_id);
  } catch (e) {
    console.error('[cards] assign failed:', e.message);
    return res.status(502).json({ error: `disccardpromos rejected the card assignment: ${e.message}` });
  }
  // active_cards is a list of masked numbers with no stable per-card id in
  // their API — the just-activated one is whichever entry matches this
  // card_number's last 4 digits, falling back to a locally-computed mask if
  // the response didn't come back as expected (mock mode, or an
  // unrecognized shape).
  const last4 = String(card_number).slice(-4);
  const maskedNumber = (result.active_cards || []).find(c => c.endsWith(last4)) || `****${last4}`;
  const id = uuid();
  db.prepare(`INSERT INTO cards (id, org_id, applicant_id, season_id, card_number_masked, provider_card_id, status, amount, assigned_at)
    VALUES (?,?,?,?,?,?,'assigned',?,datetime('now'))`)
    .run(id, req.user.org_id, applicant.id, applicant.season_id, maskedNumber, null, finalAmount);
  db.prepare(`INSERT INTO card_transactions (id, card_id, type, amount, occurred_at) VALUES (?,?,?,?,datetime('now'))`)
    .run(uuid(), id, 'load', finalAmount);
  db.prepare(`INSERT INTO audit_log (id, org_id, user_id, action, entity_type, entity_id, after_json) VALUES (?,?,?,?,?,?,?)`)
    .run(uuid(), req.user.org_id, req.user.id, 'assign_card', 'card', id, JSON.stringify({ applicant_id, amount: finalAmount }));
  res.status(201).json({ card: db.prepare('SELECT * FROM cards WHERE id = ?').get(id) });
});

// Activate — the phone number the applicant/gabai provides "gets written onto their account."
router.post('/:id/activate', requirePermission('cards', 'can_edit'), async (req, res) => {
  const card = db.prepare('SELECT * FROM cards WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!card) return res.status(404).json({ error: 'Not found' });
  const { phone } = req.body || {};
  if (!phone) return res.status(400).json({ error: 'Activation phone number is required' });
  if (!isValidPhone(phone)) return res.status(400).json({ error: 'Activation phone number must be a valid phone number (10 digits, or 11 digits starting with 1)' });
  let result;
  try {
    result = await giftcard.activateCard(card.season_id, { providerCardId: card.provider_card_id, phone });
  } catch (e) {
    console.error('[cards] activate failed:', e.message);
    return res.status(502).json({ error: `disccardpromos rejected the activation: ${e.message}` });
  }
  db.prepare(`UPDATE cards SET status='activated', activation_phone=?, activated_at=? WHERE id=?`).run(normalizePhone(phone), result.activatedAt, card.id);
  db.prepare(`INSERT INTO card_transactions (id, card_id, type, amount, occurred_at) VALUES (?,?,?,0,?)`).run(uuid(), card.id, 'activation', result.activatedAt);
  res.json({ card: db.prepare('SELECT * FROM cards WHERE id = ?').get(card.id) });
});

router.post('/:id/deactivate', requirePermission('cards', 'can_edit'), async (req, res) => {
  const card = db.prepare('SELECT * FROM cards WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!card) return res.status(404).json({ error: 'Not found' });
  let result;
  try {
    result = await giftcard.deactivateCard(card.season_id, { providerCardId: card.provider_card_id, reason: req.body?.reason });
  } catch (e) {
    console.error('[cards] deactivate failed:', e.message);
    return res.status(502).json({ error: `disccardpromos rejected the deactivation: ${e.message}` });
  }
  db.prepare(`UPDATE cards SET status='deactivated', deactivated_at=? WHERE id=?`).run(result.deactivatedAt, card.id);
  res.json({ ok: true });
});

// Pull latest balance/status + transactions from disccardpromos for one card.
router.post('/:id/sync', requirePermission('cards', 'can_edit'), async (req, res) => {
  const card = db.prepare('SELECT * FROM cards WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!card) return res.status(404).json({ error: 'Not found' });
  const synced = await syncOneCard(req.user.org_id, card);
  res.json({ synced, mockMode: giftcard.isMockMode(card.season_id) });
});

// Sweep every assigned/activated card at once — also runs automatically on a
// background interval (see index.js) so store spend stays live without
// anyone needing to click in.
router.post('/sync-all', requirePermission('cards', 'can_edit'), async (req, res) => {
  const result = await syncAllCards(req.user.org_id);
  // Sweeps every season's cards at once (syncAllCards resolves each card's
  // own season internally) — mockMode here is just the org-wide default for
  // the summary badge, not a per-card truth.
  res.json({ ...result, mockMode: giftcard.isMockMode(null) });
});

router.get('/:id/transactions', (req, res) => {
  const card = db.prepare('SELECT * FROM cards WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!card) return res.status(404).json({ error: 'Not found' });
  res.json({ transactions: db.prepare('SELECT * FROM card_transactions WHERE card_id = ? ORDER BY occurred_at DESC').all(card.id) });
});

// Shared by the list and the export: card transactions AND the charges that
// belong to no card of ours (customers not linked to any applicant — see
// services/spendTotals.js), filtered the same way.
function txnFilters(orgId, { type, store_id }) {
  let cardWhere = 'WHERE c.org_id = ?', unWhere = 'WHERE u.org_id = ?';
  const cardParams = [orgId], unParams = [orgId];
  if (type) { cardWhere += ' AND t.type = ?'; cardParams.push(type); unWhere += ' AND u.type = ?'; unParams.push(type); }
  if (store_id) { cardWhere += ' AND t.store_id = ?'; cardParams.push(store_id); unWhere += ' AND u.store_id = ?'; unParams.push(store_id); }
  return { cardWhere, cardParams, unWhere, unParams };
}

// Full-detail export of every transaction across the org, including the
// unattributed ones (unattributed = 1, with the disccardpromos customer).
router.get('/transactions/export', requirePermission('cards', 'can_export'), (req, res) => {
  const { cardWhere, cardParams, unWhere, unParams } = txnFilters(req.user.org_id, req.query);
  const cardRows = db.prepare(`SELECT t.*, a.first_name, a.last_name, c.card_number_masked, s.name as resolved_store_name
    FROM card_transactions t JOIN cards c ON c.id=t.card_id LEFT JOIN applicants a ON a.id=c.applicant_id LEFT JOIN stores s ON s.id=t.store_id
    ${cardWhere}`).all(...cardParams).map(r => ({ ...r, unattributed: 0 }));
  const unRows = db.prepare(`SELECT u.id, u.provider_txn_id, u.type, u.amount, u.store_name, u.store_id, u.occurred_at, u.customer_id, u.customer_name,
      a.first_name, a.last_name, s.name as resolved_store_name, 1 AS unattributed
    FROM unattributed_transactions u LEFT JOIN applicants a ON a.id=u.applicant_id LEFT JOIN stores s ON s.id=u.store_id
    ${unWhere}`).all(...unParams);
  const rows = [...cardRows, ...unRows].sort((x, y) => String(y.occurred_at || '').localeCompare(String(x.occurred_at || '')));
  sendXlsx(res, `transactions-${Date.now()}.xlsx`, rows);
});

// All transactions across the org — "see all transactions they make in stores,
// with all transaction info, balance, activation time, refunds — everything."
// `summary` is the org-wide spend total this list adds up to (unfiltered, not
// just this page): purchases and refunds on cards, plus the unattributed
// charges, which are INCLUDED in totalSpent.
router.get('/transactions/all', (req, res) => {
  const { page = 1, pageSize = 100 } = req.query;
  const orgId = req.user.org_id;
  const { cardWhere, cardParams, unWhere, unParams } = txnFilters(orgId, req.query);
  const total = db.prepare(`SELECT (SELECT COUNT(*) FROM card_transactions t JOIN cards c ON c.id=t.card_id ${cardWhere})
    + (SELECT COUNT(*) FROM unattributed_transactions u ${unWhere}) c`).get(...cardParams, ...unParams).c;
  const offset = (Math.max(1, +page) - 1) * +pageSize;
  const rows = db.prepare(`SELECT * FROM (
      SELECT t.id, t.card_id, t.provider_txn_id, t.occurred_at, t.type, t.amount, t.balance_after, t.store_name, t.store_id,
        a.first_name, a.last_name, c.card_number_masked, a.id AS linked_applicant_id, NULL AS customer_id, NULL AS customer_name, 0 AS unattributed
      FROM card_transactions t JOIN cards c ON c.id=t.card_id LEFT JOIN applicants a ON a.id=c.applicant_id ${cardWhere}
      UNION ALL
      SELECT u.id, NULL, u.provider_txn_id, u.occurred_at, u.type, u.amount, NULL, u.store_name, u.store_id,
        a.first_name, a.last_name, NULL, a.id, u.customer_id, u.customer_name, 1
      FROM unattributed_transactions u LEFT JOIN applicants a ON a.id=u.applicant_id ${unWhere}
    ) ORDER BY occurred_at DESC LIMIT ? OFFSET ?`).all(...cardParams, ...unParams, +pageSize, offset);
  const card = db.prepare(`SELECT COALESCE(SUM(CASE WHEN t.type != 'refund' AND t.amount < 0 THEN -t.amount ELSE 0 END), 0) purchases,
      COALESCE(SUM(CASE WHEN t.type = 'refund' THEN t.amount ELSE 0 END), 0) refunds
    FROM card_transactions t JOIN cards c ON c.id=t.card_id WHERE c.org_id = ?`).get(orgId);
  const unlinkedCustomers = db.prepare(`SELECT COUNT(DISTINCT customer_id) n FROM unattributed_transactions WHERE org_id = ? AND applicant_id IS NULL AND customer_id IS NOT NULL`).get(orgId).n;
  const un = unattributedNet(orgId);
  res.json({
    transactions: rows, total, page: +page, pageSize: +pageSize,
    summary: {
      purchases: Math.round(card.purchases * 100) / 100, refunds: Math.round(card.refunds * 100) / 100,
      unattributedNet: un.net, unattributedCount: un.count, unlinkedCustomers,
      totalSpent: totalSpend(orgId).total,
    },
  });
});

export default router;
