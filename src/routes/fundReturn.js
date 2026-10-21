import { Router } from 'express';
import { db } from '../db.js';
import { auth } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import { sendXlsx } from '../services/xlsx.js';
import { getActiveSeasonId } from '../utils/formSchedule.js';
import { previewReturn, previewPartial, issueConfirmCode, consumeConfirmCode, startReturnJob, cancelJob, currentJobId, MODES } from '../services/fundReturn.js';

// Mass "return funds on untouched accounts" — Settings > Organization. Gated
// behind its own explicit-grant permission (fund_return, see
// middleware/permissions.js): super_admin always, everyone else only when
// specifically granted in Users & Permissions. A run needs a freshly issued
// random code typed back (preview issues it), so it can't be fired by a stray
// click or a replayed request.
const router = Router();
router.use(auth, requirePermission('fund_return', 'can_edit'));

// Two buttons share everything (permission, code gate, job runner, report): 'untouched' (accounts
// with no transactions, every give reversed in full) and 'partial' (single-shul, dollar-for-dollar
// matched accounts, what is left split half shul / half org).
const modeOf = (v) => (MODES.includes(v) ? v : 'untouched');

function jobView(j, withResults = false) {
  if (!j) return null;
  const out = { ...j, per_shul: JSON.parse(j.per_shul_json || '[]') };
  delete out.per_shul_json;
  if (withResults) out.results = JSON.parse(j.results_json || '[]');
  delete out.results_json;
  return out;
}

// What it would do, plus the code to type to confirm. Local data only — the
// live card balance of every account is re-checked when it actually runs.
router.post('/preview', (req, res) => {
  const mode = modeOf(req.body?.mode);
  const seasonId = req.body?.season_id === 'all' ? '' : (req.body?.season_id || getActiveSeasonId(req.user.org_id) || '');
  const preview = mode === 'partial' ? previewPartial(req.user.org_id, seasonId) : previewReturn(req.user.org_id, seasonId);
  res.json({ mode, seasonId: seasonId || 'all', ...preview, ...issueConfirmCode(req.user.id, seasonId, mode) });
});

router.post('/start', (req, res) => {
  const mode = modeOf(req.body?.mode);
  const seasonId = req.body?.season_id === 'all' ? '' : (req.body?.season_id || '');
  if (!consumeConfirmCode(req.user.id, seasonId, req.body?.code, mode)) {
    return res.status(400).json({ error: 'That confirmation code is wrong or has expired. Preview again to get a new one.' });
  }
  try {
    const jobId = startReturnJob({ orgId: req.user.org_id, userId: req.user.id, seasonId, ip: req.ip, mode });
    res.status(202).json({ jobId });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// The running job if any, else the most recent one of the asked-for type — lets the page pick the
// progress view back up after a reload.
router.get('/current', (req, res) => {
  const mode = modeOf(req.query.mode);
  const running = currentJobId();
  let j = running ? db.prepare('SELECT * FROM fund_return_jobs WHERE id = ?').get(running) : null;
  if (!j) j = db.prepare('SELECT * FROM fund_return_jobs WHERE org_id = ? AND mode = ? ORDER BY started_at DESC LIMIT 1').get(req.user.org_id, mode);
  res.json({ job: jobView(j) });
});

router.get('/jobs/:id', (req, res) => {
  const j = db.prepare('SELECT * FROM fund_return_jobs WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!j) return res.status(404).json({ error: 'Not found' });
  res.json({ job: jobView(j, true) });
});

router.post('/jobs/:id/cancel', (req, res) => {
  const j = db.prepare('SELECT * FROM fund_return_jobs WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!j) return res.status(404).json({ error: 'Not found' });
  if (j.status !== 'running') return res.status(400).json({ error: 'This run is not running.' });
  cancelJob(j.id);     // stops before the next account; anything already returned stays returned
  res.json({ ok: true });
});

router.get('/jobs/:id/export', (req, res) => {
  const j = db.prepare('SELECT * FROM fund_return_jobs WHERE id = ? AND org_id = ?').get(req.params.id, req.user.org_id);
  if (!j) return res.status(404).json({ error: 'Not found' });
  const rows = JSON.parse(j.results_json || '[]').map(r => ({
    'Applicant': r.name, 'ID': r.externalId, 'Result': r.status, 'Gives reversed': r.gives, 'Returned to shuls': r.toShuls, 'Returned to org': r.toOrg, 'Note': r.reason,
  }));
  sendXlsx(res, `fund-return-${(j.started_at || '').slice(0, 10)}.xlsx`, rows);
});

export default router;
