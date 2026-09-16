import { Router } from 'express';
import { db, uuid } from '../db.js';
import { auth } from '../middleware/auth.js';
import { requirePermission, redact } from '../middleware/permissions.js';
import * as giftcard from '../services/giftcard.js';
import { sendXlsx } from '../services/xlsx.js';
import { syncOneCard, syncAllCards } from '../services/cardSync.js';
import { normalizePhone, isValidPhone } from '../utils/phone.js';
import { resolveFundingAnchor } from '../services/providerAccount.js';
import { getApplicantBalances } from '../services/applicantBalance.js';

const router = Router();
router.use(auth, requirePermission('cards'));

router.get('/', (req, res) => {
  const { search, status, season_id, page = 1, pageSize = 50 } = req.query;
  let where = 'WHERE c.org_id = ?';
  const params = [req.user.org_id];
  if (status) { where += ' AND c.status = ?'; params.push(status); }
  if (season_id) { where += ' AND c.season_id = ?'; params.push(season_id); }
  if (search) {
    where += ` AND (a.first_name LIKE ? OR a.last_name LIKE ? OR c.card_number_masked LIKE ?)`;
    const like = `%${search}%`;
    params.push(like, like, like);
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
    where += ` AND (a.first_name LIKE ? OR a.last_name LIKE ? OR c.card_number_masked LIKE ?)`;
    const like = `%${search}%`;
    params.push(like, like, like);
  }
  const rows = db.prepare(`SELECT c.*, a.first_name, a.last_name, a.email, s.name_en as shul_name
    FROM cards c LEFT JOIN applicants a ON a.id=c.applicant_id LEFT JOIN shuls s ON s.id=a.shul_id
    ${where} ORDER BY c.created_at DESC`).all(...params);
  sendXlsx(res, `cards-${Date.now()}.xlsx`, redact(rows, req.permission.hidden_fields));
});

// Per-shul rollup: how much of the money loaded onto that shul's applicants'
// cards has actually been spent so far. Must be registered before /:id (same
// reason as /export above — otherwise Express matches "by-shul" as an :id).
// "Allocated" here means card value loaded (SUM(cards.amount)), matching the
// org-wide "Total Loaded" stat on the dashboard — not slots_allocated, which
// is a headcount, not a dollar figure. "Spent" mirrors the existing
// store-spend convention elsewhere (negative card_transactions.amount = a purchase).
router.get('/by-shul', (req, res) => {
  const { season_id } = req.query;
  let where = 'WHERE c.org_id = ?';
  const params = [req.user.org_id];
  if (season_id) { where += ' AND c.season_id = ?'; params.push(season_id); }
  const rows = db.prepare(`
    SELECT s.id AS shul_id, s.name_en AS shul_name,
      COALESCE(SUM(c.amount), 0) AS allocated,
      COALESCE((SELECT SUM(CASE WHEN t.type = 'refund' THEN -t.amount WHEN t.amount < 0 THEN -t.amount ELSE 0 END)
        FROM card_transactions t WHERE t.card_id IN (
          SELECT c2.id FROM cards c2 JOIN applicants a2 ON a2.id = c2.applicant_id WHERE a2.shul_id = s.id AND c2.org_id = ?
        )), 0) AS spent
    FROM shuls s
    JOIN applicants a ON a.shul_id = s.id
    JOIN cards c ON c.applicant_id = a.id
    ${where}
    GROUP BY s.id
    HAVING allocated > 0
    ORDER BY allocated DESC`).all(req.user.org_id, ...params);
  res.json({ shuls: rows.map(r => ({ ...r, remaining: r.allocated - r.spent })) });
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

// Full-detail CSV export of every transaction across the org.
router.get('/transactions/export', requirePermission('cards', 'can_export'), (req, res) => {
  const { type, store_id } = req.query;
  let where = 'WHERE c.org_id = ?';
  const params = [req.user.org_id];
  if (type) { where += ' AND t.type = ?'; params.push(type); }
  if (store_id) { where += ' AND t.store_id = ?'; params.push(store_id); }
  const rows = db.prepare(`SELECT t.*, a.first_name, a.last_name, c.card_number_masked, s.name as resolved_store_name
    FROM card_transactions t JOIN cards c ON c.id=t.card_id LEFT JOIN applicants a ON a.id=c.applicant_id LEFT JOIN stores s ON s.id=t.store_id
    ${where} ORDER BY t.occurred_at DESC`).all(...params);
  sendXlsx(res, `transactions-${Date.now()}.xlsx`, rows);
});

// All transactions across the org — "see all transactions they make in stores,
// with all transaction info, balance, activation time, refunds — everything."
router.get('/transactions/all', (req, res) => {
  const { page = 1, pageSize = 100, type, store_id } = req.query;
  let where = 'WHERE c.org_id = ?';
  const params = [req.user.org_id];
  if (type) { where += ' AND t.type = ?'; params.push(type); }
  if (store_id) { where += ' AND t.store_id = ?'; params.push(store_id); }
  const total = db.prepare(`SELECT COUNT(*) c FROM card_transactions t JOIN cards c ON c.id=t.card_id ${where}`).get(...params).c;
  const offset = (Math.max(1, +page) - 1) * +pageSize;
  const rows = db.prepare(`SELECT t.*, a.first_name, a.last_name, c.card_number_masked
    FROM card_transactions t JOIN cards c ON c.id=t.card_id LEFT JOIN applicants a ON a.id=c.applicant_id
    ${where} ORDER BY t.occurred_at DESC LIMIT ? OFFSET ?`).all(...params, +pageSize, offset);
  res.json({ transactions: rows, total, page: +page, pageSize: +pageSize });
});

export default router;
