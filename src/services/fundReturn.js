// Mass "return funds on untouched accounts".
//
// An account that has received money (shul gives + the org's match) but has
// not had a single transaction yet can have everything handed back to where it
// came from: each shul's own money back to that shul's balance, the org's
// match released back to the org. The accounting for ONE give is exactly what
// the per-give "Undo" already does (services/matching.js reverseAllocation:
// reads the live card balance, pulls the money back off the card, writes an
// equal-and-opposite reversal row — base_amount back to the shul, match_amount
// released — and audits it). This module only finds the accounts that qualify,
// double-checks each one against the LIVE card balance before touching it, and
// runs reverseAllocation for every give on it.
//
// "Account" = the person's one disccardpromos account: every applicant row
// sharing a provider_account_id, a merge group, or just itself (a season
// carry-forward and a merge group share one real account, so a charge on any
// of them touches the account).
import { randomInt } from 'crypto';
import { db, uuid } from '../db.js';
import { reverseAllocation, computeRetrievable } from './matching.js';
import { getApplicantBalances } from './applicantBalance.js';
import { logAudit } from './audit.js';

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// ---- confirmation codes -------------------------------------------------
// A preview issues a random code the admin must retype to start. Held in
// memory per user, single use, 15 minutes.
const CODE_TTL_MS = 15 * 60 * 1000;
const pending = new Map(); // userId -> { code, seasonId, expires }
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I to retype
function newCode() {
  for (;;) {
    let c = '';
    for (let i = 0; i < 6; i++) c += ALPHABET[randomInt(ALPHABET.length)];
    if (/[A-Z]/.test(c) && /[2-9]/.test(c)) return c;   // always letters AND numbers
  }
}
export function issueConfirmCode(userId, seasonId) {
  const code = newCode();
  pending.set(userId, { code, seasonId: seasonId || '', expires: Date.now() + CODE_TTL_MS });
  return { code, expiresInMinutes: CODE_TTL_MS / 60000 };
}
// true only for the exact code issued to this user for this scope; consumed on success
export function consumeConfirmCode(userId, seasonId, typed) {
  const p = pending.get(userId);
  if (!p || p.expires < Date.now() || p.seasonId !== (seasonId || '')) return false;
  if (String(typed || '').trim().toUpperCase() !== p.code) return false;
  pending.delete(userId);
  return true;
}

// ---- who qualifies ------------------------------------------------------
// Local view (no live calls): every account that has at least one give still
// standing, split into those with no transaction at all ("untouched") and the
// rest. The live balance of each untouched account is re-checked at run time.
export function findCandidates(orgId, seasonId) {
  const gives = db.prepare(`SELECT sa.id, sa.shul_id, sa.applicant_id, sa.season_id, sa.base_amount, sa.match_amount, sa.total_amount, sa.created_at,
      a.provider_account_id, a.merge_group_id, a.first_name, a.last_name, a.external_id, sh.name_en AS shul_name
    FROM shul_allocations sa JOIN applicants a ON a.id = sa.applicant_id LEFT JOIN shuls sh ON sh.id = sa.shul_id
    WHERE sa.org_id = ? AND sa.reversed_at IS NULL AND sa.reversal_of IS NULL AND sa.total_amount > 0${seasonId ? ' AND sa.season_id = ?' : ''}
    ORDER BY sa.created_at`).all(...(seasonId ? [orgId, seasonId] : [orgId]));

  // applicant rows grouped into accounts
  const apps = db.prepare('SELECT id, provider_account_id, merge_group_id FROM applicants WHERE org_id = ?').all(orgId);
  const byProvider = new Map(), byGroup = new Map();
  for (const a of apps) {
    if (a.provider_account_id) { const k = String(a.provider_account_id).replace(/\.0+$/, ''); (byProvider.get(k) || byProvider.set(k, []).get(k)).push(a.id); }
    if (a.merge_group_id) (byGroup.get(a.merge_group_id) || byGroup.set(a.merge_group_id, []).get(a.merge_group_id)).push(a.id);
  }
  const membersOf = (g) => {
    const set = new Set([g.applicant_id]);
    if (g.provider_account_id) for (const id of byProvider.get(String(g.provider_account_id).replace(/\.0+$/, '')) || []) set.add(id);
    if (g.merge_group_id) for (const id of byGroup.get(g.merge_group_id) || []) set.add(id);
    return set;
  };

  // anyone with a real transaction (anything but the activation / load bookkeeping rows)
  const touchedApplicants = new Set(db.prepare(`SELECT DISTINCT c.applicant_id FROM card_transactions t JOIN cards c ON c.id = t.card_id
    WHERE c.org_id = ? AND t.type NOT IN ('activation', 'load')`).all(orgId).map(r => r.applicant_id));
  const touchedCustomers = new Set();
  for (const r of db.prepare(`SELECT DISTINCT applicant_id, customer_id FROM unattributed_transactions WHERE org_id = ?`).all(orgId)) {
    if (r.applicant_id) touchedApplicants.add(r.applicant_id);
    if (r.customer_id) touchedCustomers.add(String(r.customer_id).replace(/\.0+$/, ''));
  }

  const accounts = new Map();
  for (const g of gives) {
    const key = g.provider_account_id ? `p:${String(g.provider_account_id).replace(/\.0+$/, '')}` : (g.merge_group_id ? `m:${g.merge_group_id}` : `a:${g.applicant_id}`);
    let acc = accounts.get(key);
    if (!acc) {
      const members = membersOf(g);
      const touched = [...members].some(id => touchedApplicants.has(id))
        || (g.provider_account_id && touchedCustomers.has(String(g.provider_account_id).replace(/\.0+$/, '')));
      acc = { key, touched, name: `${g.first_name || ''} ${g.last_name || ''}`.trim() || `#${g.external_id}`, externalId: g.external_id, gives: [] };
      accounts.set(key, acc);
    }
    acc.gives.push(g);
  }
  return [...accounts.values()];
}

export function previewReturn(orgId, seasonId) {
  const all = findCandidates(orgId, seasonId);
  const untouched = all.filter(a => !a.touched), touched = all.filter(a => a.touched);
  const perShul = new Map();
  let org = 0, gives = 0;
  for (const acc of untouched) for (const g of acc.gives) {
    const s = perShul.get(g.shul_id) || { shul_id: g.shul_id, shul_name: g.shul_name || '(unknown shul)', base: 0, accounts: new Set() };
    s.base += g.base_amount; s.accounts.add(acc.key); perShul.set(g.shul_id, s);
    org += g.match_amount; gives++;
  }
  const shuls = [...perShul.values()].map(s => ({ shul_id: s.shul_id, shul_name: s.shul_name, base: round2(s.base), accounts: s.accounts.size })).sort((a, b) => b.base - a.base);
  const base = round2(shuls.reduce((t, s) => t + s.base, 0));
  return {
    eligibleAccounts: untouched.length, gives, toShuls: base, toOrg: round2(org), total: round2(base + org), shuls,
    leftAloneAccounts: touched.length,
    leftAloneAmount: round2(touched.reduce((t, a) => t + a.gives.reduce((s, g) => s + g.total_amount, 0), 0)),
    sample: untouched.slice(0, 25).map(a => ({ name: a.name, externalId: a.externalId, gives: a.gives.length, total: round2(a.gives.reduce((s, g) => s + g.total_amount, 0)) })),
  };
}

// ---- running it ---------------------------------------------------------
const cancelFlags = new Set();
let runningJobId = null;
export const currentJobId = () => runningJobId;
export function cancelJob(jobId) { cancelFlags.add(jobId); }
const yieldNow = () => new Promise(resolve => setImmediate(resolve));

// A server restart mid-run leaves a 'running' row nobody is running any more.
export function markInterruptedJobs() {
  db.prepare(`UPDATE fund_return_jobs SET status = 'interrupted', finished_at = datetime('now') WHERE status = 'running'`).run();
}

export function startReturnJob({ orgId, userId, seasonId, ip }) {
  if (runningJobId) throw Object.assign(new Error('A fund return is already running. Wait for it to finish (or cancel it).'), { status: 409 });
  const accounts = findCandidates(orgId, seasonId).filter(a => !a.touched);
  const id = uuid();
  db.prepare(`INSERT INTO fund_return_jobs (id, org_id, started_by, season_id, status, accounts_total) VALUES (?,?,?,?, 'running', ?)`).run(id, orgId, userId, seasonId || null, accounts.length);
  logAudit(orgId, userId, 'mass_fund_return_start', 'fund_return', id, null, { season_id: seasonId || null, accounts: accounts.length }, ip);
  runningJobId = id;
  runJob({ jobId: id, orgId, userId, accounts, ip }).catch(e => console.error('[fundReturn] job crashed:', e));
  return id;
}

async function runJob({ jobId, orgId, userId, accounts, ip }) {
  const results = [];
  const perShul = new Map();
  const t = { done: 0, returned: 0, skipped: 0, failed: 0, partial: 0, gives: 0, shul: 0, org: 0 };
  const save = (status = 'running', error = null) => db.prepare(`UPDATE fund_return_jobs SET status = ?, accounts_done = ?, accounts_returned = ?, accounts_skipped = ?, accounts_failed = ?,
      gives_reversed = ?, shul_returned = ?, org_returned = ?, per_shul_json = ?, results_json = ?, error = ?, finished_at = CASE WHEN ? = 'running' THEN NULL ELSE datetime('now') END WHERE id = ?`)
    .run(status, t.done, t.returned, t.skipped, t.failed, t.gives, round2(t.shul), round2(t.org),
      JSON.stringify([...perShul.values()].map(s => ({ ...s, base: round2(s.base) }))), JSON.stringify(results.slice(0, 5000)), error, status, jobId);
  let finalStatus = 'done';
  try {
    for (const acc of accounts) {
      if (cancelFlags.has(jobId)) { finalStatus = 'cancelled'; break; }
      const res = { name: acc.name, externalId: acc.externalId, status: 'returned', reason: '', gives: 0, toShuls: 0, toOrg: 0 };
      try {
        const first = acc.gives[0];
        // LIVE re-check, before anything is touched: the card must still hold
        // everything that was loaded onto it (nothing spent). computeRetrievable
        // reads the live disccardpromos balance and throws if it can't confirm.
        const live = await computeRetrievable(orgId, first.id);
        const loaded = getApplicantBalances(orgId, [first.applicant_id]).get(first.applicant_id)?.loaded;
        const liveBalance = live.rawDiagnostic?.liveBalance;
        if (live.shortfall > 0.01) { res.status = 'skipped'; res.reason = `part of the money was already spent (card holds $${round2(live.retrievable)} of $${round2(first.total_amount)})`; }
        else if (liveBalance != null && loaded != null && liveBalance < loaded - 0.01) { res.status = 'skipped'; res.reason = `card holds $${round2(liveBalance)} but $${round2(loaded)} was loaded — something was spent`; }
        else {
          for (const g of acc.gives) {
            const r = await reverseAllocation({ orgId, userId, allocationId: g.id, ip });
            res.gives++;
            const base = -Number(r.base_amount || 0), match = -Number(r.match_amount || 0);
            res.toShuls += base; res.toOrg += match;
            const s = perShul.get(g.shul_id) || { shul_id: g.shul_id, shul_name: g.shul_name || '(unknown shul)', base: 0 };
            s.base += base; perShul.set(g.shul_id, s);
            if (r.shortfall > 0.01) { res.status = 'partial'; res.reason = `$${round2(r.shortfall)} had been spent and could not be returned`; }
            if (r.giftcard_status === 'failed') res.reason = (res.reason ? res.reason + '; ' : '') + "disccardpromos wasn't updated yet (it retries automatically)";
          }
        }
      } catch (e) { res.status = 'failed'; res.reason = e.message; }
      res.toShuls = round2(res.toShuls); res.toOrg = round2(res.toOrg);
      t.done++; t.gives += res.gives; t.shul += res.toShuls; t.org += res.toOrg;
      if (res.status === 'returned') t.returned++; else if (res.status === 'partial') { t.returned++; t.partial++; } else if (res.status === 'skipped') t.skipped++; else t.failed++;
      results.push(res);
      if (t.done % 5 === 0) save();
      await yieldNow();
    }
  } catch (e) { finalStatus = 'failed'; console.error('[fundReturn] run failed:', e); save('failed', e.message); }
  if (finalStatus !== 'failed') save(finalStatus);
  logAudit(orgId, userId, 'mass_fund_return_finish', 'fund_return', jobId, null, { status: finalStatus, accounts: t.done, returned: t.returned, skipped: t.skipped, failed: t.failed, gives: t.gives, toShuls: round2(t.shul), toOrg: round2(t.org) }, ip);
  cancelFlags.delete(jobId);
  runningJobId = null;
}
