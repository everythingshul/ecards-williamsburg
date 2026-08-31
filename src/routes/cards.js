import { Router } from 'express';
import { db, uuid } from '../db.js';
import { auth } from '../middleware/auth.js';
import { requirePermission, redact } from '../middleware/permissions.js';
import * as giftcard from '../services/giftcard.js';
import { sendXlsx } from '../services/xlsx.js';
import { syncOneCard, syncAllCards } from '../services/cardSync.js';
import { normalizePhone, isValidPhone } from '../utils/phone.js';

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
      COALESCE((SELECT SUM(CASE WHEN t.amount < 0 THEN -t.amount ELSE 0 END)
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
