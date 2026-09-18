// ---------------------------------------------------------------------------
// Off-site copies of the data — the "never lose my data" layer on top of
// services/backup.js's local rotating snapshots (which live on the same
// 1GB persistent disk as the database, so they protect against a bad write
// or an accidental delete, but NOT against losing the disk/service itself).
//
// Two independent channels, both driven by one nightly run at midnight
// New York time (the org's own time zone — see services/xlsx.js):
//
//  1. EMAIL — a gzip'd copy of the database is emailed to the "backup
//     email" address (Settings > Backups; falls back to the org's support
//     email, then the first super admin). Works with what's already
//     configured (Brevo) — no extra accounts. Brevo caps a transactional
//     email at ~10MB including the base64 overhead, so the attachment is
//     limited to EMAIL_MAX_BYTES; a copy bigger than that sends a notice
//     email saying exactly how big it was and what to do instead.
//
//  2. CLOUD BUCKET — any S3-compatible bucket (Backblaze B2, Cloudflare
//     R2, AWS S3, Wasabi, MinIO…) via BACKUP_S3_* env vars. Uploads the
//     same gzip'd database AND a full archive of DATA_DIR (every uploaded
//     PDF/signature/logo/attachment — the database alone doesn't hold
//     those). Signed with AWS Signature V4 by hand (crypto only, no SDK —
//     this app has a standing no-heavy-dependency rule) and sent with
//     https.request so a large archive streams from disk instead of being
//     buffered in memory. Unset env vars = channel off, silently.
//
// The run also happens at boot if today's (NY) run hasn't happened yet —
// so a server that was down at midnight catches up as soon as it's back,
// and a failed run is retried hourly until the day's copy is out.
// ---------------------------------------------------------------------------
import { createHash, createHmac } from 'crypto';
import { createGzip } from 'zlib';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, statfsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { pipeline } from 'stream/promises';
import { spawn } from 'child_process';
import https from 'https';
import http from 'http';
import { db, DATA_DIR, DEFAULT_ORG_ID } from '../db.js';
import { runBackup, listBackups } from './backup.js';
import { sendMailChecked } from './mail.js';
import { logApiCall } from './apiCallLog.js';

const TZ = 'America/New_York';
// Brevo's limit is ~10MB for the whole message; base64 adds a third, so
// 7MB of real bytes is the safe ceiling for the attachment itself.
export const EMAIL_MAX_BYTES = 7 * 1048576;
const TMP_DIR = join(DATA_DIR, 'tmp');
if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });

const MB = (n) => (n / 1048576).toFixed(1) + ' MB';

// ---- settings helpers -----------------------------------------------------
function getSetting(key) {
  return db.prepare(`SELECT value FROM settings WHERE org_id = ? AND key = ?`).get(DEFAULT_ORG_ID, key)?.value ?? null;
}
function setSetting(key, value) {
  db.prepare(`INSERT INTO settings (org_id, key, value) VALUES (?,?,?) ON CONFLICT(org_id, key) DO UPDATE SET value = excluded.value`)
    .run(DEFAULT_ORG_ID, key, value == null ? '' : String(value));
}

// The address the nightly copy goes to, and where it came from (so the
// Settings page can say "using the org support email" vs. an explicit one).
export function backupEmailTarget() {
  const explicit = (getSetting('backup_email_to') || '').trim();
  if (explicit) return { email: explicit, source: 'setting' };
  const org = db.prepare(`SELECT support_email FROM organizations WHERE id = ?`).get(DEFAULT_ORG_ID);
  if (org?.support_email) return { email: org.support_email, source: 'org' };
  const admin = db.prepare(`SELECT email FROM users WHERE org_id = ? AND role = 'super_admin' AND is_active = 1 ORDER BY created_at LIMIT 1`).get(DEFAULT_ORG_ID);
  if (admin?.email) return { email: admin.email, source: 'super_admin' };
  return { email: null, source: null };
}

export function s3Config() {
  const { BACKUP_S3_BUCKET: bucket, BACKUP_S3_ENDPOINT: endpoint, BACKUP_S3_ACCESS_KEY: accessKey, BACKUP_S3_SECRET_KEY: secretKey } = process.env;
  if (!bucket || !endpoint || !accessKey || !secretKey) return null;
  return {
    bucket, accessKey, secretKey,
    endpoint: endpoint.replace(/\/+$/, ''),
    region: process.env.BACKUP_S3_REGION || 'us-east-1',
    prefix: (process.env.BACKUP_S3_PREFIX || 'ecards-backups/').replace(/^\/+/, ''),
    keep: +process.env.BACKUP_S3_RETENTION_COUNT || 30,
  };
}

// ---- time helpers (New York calendar day) ---------------------------------
export function todayKey(d = new Date()) {
  return d.toLocaleDateString('en-CA', { timeZone: TZ }); // YYYY-MM-DD
}
function nyParts(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(d).map(x => [x.type, x.value]));
  return { h: +p.hour % 24, m: +p.minute, s: +p.second };
}
export function msUntilNextMidnightNY(d = new Date()) {
  const { h, m, s } = nyParts(d);
  const secondsIntoDay = h * 3600 + m * 60 + s;
  return (86400 - secondsIntoDay) * 1000 + 30 * 1000; // 30s past midnight, to be safe on DST edges
}

// ---- gzip the latest snapshot to a temp file ------------------------------
async function gzipFile(src, dest) {
  await pipeline(createReadStream(src), createGzip({ level: 9 }), createWriteStream(dest));
  return statSync(dest).size;
}

function freeDiskBytes() {
  try { const fs = statfsSync(DATA_DIR); return Number(fs.bavail) * Number(fs.bsize); } catch { return null; }
}

function stamp(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

// ---- S3 (Signature V4, path-style, hand-rolled) ---------------------------
const sha256Hex = (x) => createHash('sha256').update(x).digest('hex');
const hmac = (key, s) => createHmac('sha256', key).update(s).digest();
const uriEncode = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

async function fileSha256Hex(path) {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk);
  return h.digest('hex');
}

// Pure SigV4 signer (exported for the self-test in scripts/ — verified
// against AWS's published GET-object test vector). `headers` must already
// include host, x-amz-content-sha256 and x-amz-date.
export function signV4(cfg, method, url, headers, payloadHash, now = new Date()) {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const signedHeaderNames = Object.keys(headers).map(k => k.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()]));
  const canonicalHeaders = signedHeaderNames.map(k => `${k}:${lower[k]}\n`).join('');
  const signedHeaders = signedHeaderNames.join(';');
  const canonicalQuery = url.search ? url.search.slice(1) : '';
  const canonicalRequest = [method, url.pathname, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${dateStamp}/${cfg.region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac('AWS4' + cfg.secretKey, dateStamp), cfg.region), 's3'), 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  return `AWS4-HMAC-SHA256 Credential=${cfg.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

// One signed request. `body` is a Buffer/string or { path, size, sha256 }
// for a streamed file upload. Resolves { status, text } — never throws on a
// non-2xx (callers decide); throws only on a transport error.
function s3Request(cfg, method, key, { body = '', query = {}, timeoutMs = 10 * 60 * 1000 } = {}) {
  const url = new URL(`${cfg.endpoint}/${uriEncode(cfg.bucket)}/${key.split('/').map(uriEncode).join('/')}`);
  const qKeys = Object.keys(query).sort();
  url.search = qKeys.map(k => `${uriEncode(k)}=${uriEncode(String(query[k]))}`).join('&');
  const isFile = body && typeof body === 'object' && body.path;
  const payloadHash = isFile ? body.sha256 : sha256Hex(body);
  const contentLength = isFile ? body.size : Buffer.byteLength(body);
  const now = new Date();
  const headers = {
    host: url.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': now.toISOString().replace(/[:-]|\.\d{3}/g, ''),
    ...(method === 'PUT' ? { 'content-length': String(contentLength), 'content-type': 'application/octet-stream' } : {}),
  };
  headers.authorization = signV4(cfg, method, url, headers, payloadHash, now);
  const canonicalQuery = url.search ? url.search.slice(1) : '';

  const mod = url.protocol === 'http:' ? http : https;
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const req = mod.request(url, { method, headers, timeout: timeoutMs }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { if (text.length < 4000) text += c; });
      res.on('end', () => {
        logApiCall('s3-backup', { method, endpoint: url.pathname, requestSummary: isFile ? `upload ${MB(contentLength)}` : (canonicalQuery || null), statusCode: res.statusCode, success: res.statusCode < 300, responseSummary: res.statusCode < 300 ? null : text, errorMessage: res.statusCode < 300 ? null : `HTTP ${res.statusCode}`, durationMs: Date.now() - started });
        resolve({ status: res.statusCode, text });
      });
    });
    req.on('timeout', () => req.destroy(new Error(`timed out after ${timeoutMs / 1000}s`)));
    req.on('error', (e) => {
      logApiCall('s3-backup', { method, endpoint: url.pathname, success: false, errorMessage: e.message, durationMs: Date.now() - started });
      reject(e);
    });
    if (isFile) createReadStream(body.path).pipe(req);
    else req.end(body);
  });
}

async function s3Upload(cfg, key, path) {
  const size = statSync(path).size;
  const sha256 = await fileSha256Hex(path);
  const r = await s3Request(cfg, 'PUT', key, { body: { path, size, sha256 } });
  if (r.status >= 300) throw new Error(`upload of ${key} failed: HTTP ${r.status} ${r.text.slice(0, 300)}`);
  return size;
}

// Keeps the newest `keep` objects under prefix+kindPrefix, deletes the rest.
async function s3Prune(cfg, kindPrefix) {
  const r = await s3Request(cfg, 'GET', '', { query: { 'list-type': '2', prefix: cfg.prefix + kindPrefix, 'max-keys': '1000' } });
  if (r.status >= 300) throw new Error(`list failed: HTTP ${r.status}`);
  const objects = [...r.text.matchAll(/<Contents>.*?<Key>(.*?)<\/Key>.*?<LastModified>(.*?)<\/LastModified>.*?<\/Contents>/gs)]
    .map(m => ({ key: m[1], at: m[2] })).sort((a, b) => b.at.localeCompare(a.at));
  let deleted = 0;
  for (const o of objects.slice(cfg.keep)) {
    const d = await s3Request(cfg, 'DELETE', o.key);
    if (d.status < 300) deleted++;
  }
  return { kept: Math.min(objects.length, cfg.keep), deleted };
}

// Full DATA_DIR archive (everything except the local backups — those are
// copies of the same database — and tmp) to a temp file. Refuses when the
// disk can't comfortably hold it: this must never be the write that fills
// the disk (see backup.js for the same rule).
function buildFullArchive(dest) {
  return new Promise((resolve, reject) => {
    const entries = readdirSync(DATA_DIR).filter((n) => n !== 'tmp' && n !== 'backups');
    const tar = spawn('tar', ['czf', dest, '-C', DATA_DIR, ...entries]);
    let err = '';
    tar.stderr.on('data', (d) => { err += d.toString(); });
    tar.on('error', reject);
    tar.on('close', (code) => code === 0 ? resolve(statSync(dest).size) : reject(new Error(`tar exited ${code}: ${err.slice(0, 300)}`)));
  });
}

// ---- the nightly run ------------------------------------------------------
let running = null;
export function runNightlyProtection({ trigger = 'schedule' } = {}) {
  if (running) return running; // never two at once (manual button during the scheduled run)
  running = doRun(trigger).finally(() => { running = null; });
  return running;
}

async function doRun(trigger) {
  const status = { at: new Date().toISOString(), day: todayKey(), trigger, snapshot: null, email: null, offsite: null };
  const tmpGz = join(TMP_DIR, `nightly-${Date.now()}.sqlite.gz`);
  const tmpTar = join(TMP_DIR, `nightly-${Date.now()}.tar.gz`);
  try {
    // 1. Fresh local snapshot (SQLite online backup — consistent even while
    //    the app is writing). If the disk is too full for one, fall back to
    //    checkpointing the live file and compressing that.
    let src;
    try {
      src = await runBackup();
      status.snapshot = { ok: true, file: src.split('/').pop() };
    } catch (e) {
      try { db.pragma('wal_checkpoint(PASSIVE)'); } catch {}
      src = join(DATA_DIR, 'ecards.sqlite');
      status.snapshot = { ok: false, error: e.message, fallback: 'compressed the live database file directly' };
    }
    const rawBytes = statSync(src).size;
    const gzBytes = await gzipFile(src, tmpGz);
    status.snapshot = { ...status.snapshot, rawBytes, gzBytes };

    // 2. Email
    const target = backupEmailTarget();
    if (!target.email) {
      status.email = { ok: false, skipped: true, error: 'No backup email address — set one under Settings > Backups.' };
    } else if (gzBytes <= EMAIL_MAX_BYTES) {
      const name = `ecards-backup-${todayKey()}.sqlite.gz`;
      const content = readFileSync(tmpGz).toString('base64');
      const { emailError } = await sendMailChecked(DEFAULT_ORG_ID, target.email,
        `Nightly database backup — ${todayKey()}`,
        `<p>Attached is tonight's copy of the e-cards database (<strong>${name}</strong>, ${MB(gzBytes)} compressed, ${MB(rawBytes)} uncompressed).</p>
         <p>Keep it somewhere safe. To restore it one day: un-gzip it (it's a standard .gz file) to get <code>ecards.sqlite</code>, and place that file at <code>/data/ecards.sqlite</code> on a fresh service (or hand it to your developer). Signed PDFs and uploaded images are not inside the database — the cloud-bucket copy or Settings &gt; Backups &gt; Download Full Export covers those.</p>
         <p class="small">This email is sent automatically every night at midnight (New York time). It contains every applicant, shul, store, card and transaction record — treat it as confidential.</p>`,
        { attachments: [{ name, content }], relatedEntityType: 'backup' });
      status.email = emailError ? { ok: false, to: target.email, error: emailError } : { ok: true, to: target.email, bytes: gzBytes };
    } else {
      const { emailError } = await sendMailChecked(DEFAULT_ORG_ID, target.email,
        `Nightly backup too large to email — ${todayKey()}`,
        `<p>Tonight's database copy is <strong>${MB(gzBytes)}</strong> compressed (${MB(rawBytes)} uncompressed), above the ${MB(EMAIL_MAX_BYTES)} an email can carry, so it was <strong>not</strong> attached.</p>
         <p>Your options: (1) open Settings &gt; Backups and click <strong>Download Backup Now</strong> to keep a copy yourself today; (2) set up the cloud-bucket copy (any S3-compatible storage — Backblaze B2 has a free tier — via the BACKUP_S3_* environment variables on Render), which has no size limit and also includes every uploaded PDF and signature; (3) if the database has grown mostly from logs, restarting the service after the log prune shrinks it and the emailed copy usually fits again.</p>`,
        { relatedEntityType: 'backup' });
      status.email = { ok: false, to: target.email, tooLarge: true, bytes: gzBytes, error: `copy is ${MB(gzBytes)}, over the ${MB(EMAIL_MAX_BYTES)} email limit`, noticeSent: !emailError };
    }

    // 3. Cloud bucket
    const cfg = s3Config();
    if (!cfg) {
      status.offsite = { configured: false };
    } else {
      const day = todayKey();
      const result = { configured: true, bucket: cfg.bucket, db: null, full: null, prune: null };
      try {
        const key = `${cfg.prefix}db/ecards-${day}-${stamp()}.sqlite.gz`;
        await s3Upload(cfg, key, tmpGz);
        result.db = { ok: true, key, bytes: gzBytes };
      } catch (e) { result.db = { ok: false, error: e.message }; }
      const free = freeDiskBytes();
      if (free != null && free < rawBytes * 2 + 50 * 1048576) {
        result.full = { ok: false, skipped: true, error: `only ${MB(free)} free on the disk — not enough to build the full archive safely` };
      } else {
        try {
          const size = await buildFullArchive(tmpTar);
          const key = `${cfg.prefix}full/ecards-full-${day}-${stamp()}.tar.gz`;
          await s3Upload(cfg, key, tmpTar);
          result.full = { ok: true, key, bytes: size };
        } catch (e) { result.full = { ok: false, error: e.message }; }
      }
      try {
        const a = await s3Prune(cfg, 'db/');
        const b = await s3Prune(cfg, 'full/');
        result.prune = { ok: true, keptDb: a.kept, keptFull: b.kept, deleted: a.deleted + b.deleted };
      } catch (e) { result.prune = { ok: false, error: e.message }; }
      status.offsite = result;
    }
  } catch (e) {
    status.error = e.message;
    console.error('[offsite-backup] run failed:', e.message);
  } finally {
    for (const f of [tmpGz, tmpTar]) { try { if (existsSync(f)) unlinkSync(f); } catch {} }
  }
  const emailDone = status.email?.ok || status.email?.tooLarge; // a "too large" notice still counts as tonight's attempt
  const offsiteDone = !status.offsite?.configured || status.offsite?.db?.ok;
  status.ok = !status.error && (emailDone || status.email?.skipped) && offsiteDone;
  try {
    setSetting('backup_protection_status', JSON.stringify(status));
    if (status.ok) setSetting('backup_protection_last_day', status.day);
  } catch (e) { console.error('[offsite-backup] could not record status:', e.message); }
  console.log(`[offsite-backup] ${status.ok ? 'done' : 'INCOMPLETE'} (${trigger}) — email: ${status.email?.ok ? 'sent' : (status.email?.error || 'n/a')}; bucket: ${status.offsite?.configured ? (status.offsite.db?.ok ? 'uploaded' : status.offsite.db?.error) : 'not configured'}`);
  return status;
}

export function lastProtectionStatus() {
  try { return JSON.parse(getSetting('backup_protection_status') || 'null'); } catch { return null; }
}

// What Settings > Backups shows.
export function protectionOverview() {
  const target = backupEmailTarget();
  const cfg = s3Config();
  let dbBytes = null;
  try { dbBytes = statSync(join(DATA_DIR, 'ecards.sqlite')).size; } catch {}
  return {
    email: { to: target.email, source: target.source, explicit: (getSetting('backup_email_to') || '').trim(), maxBytes: EMAIL_MAX_BYTES },
    offsite: cfg ? { configured: true, bucket: cfg.bucket, endpoint: cfg.endpoint, keep: cfg.keep } : { configured: false },
    lastRun: lastProtectionStatus(),
    lastCompletedDay: getSetting('backup_protection_last_day') || null,
    nextRunAt: new Date(Date.now() + msUntilNextMidnightNY()).toISOString(),
    disk: { dbBytes, freeBytes: freeDiskBytes(), localSnapshots: listBackups().length },
  };
}

export function setBackupEmail(email) { setSetting('backup_email_to', (email || '').trim()); }

// Boot: schedule the midnight run, catch up if today's hasn't happened,
// and retry an incomplete day every hour.
export function startNightlyProtection() {
  const due = () => (getSetting('backup_protection_last_day') || '') !== todayKey();
  const tick = (trigger) => { if (due()) runNightlyProtection({ trigger }).catch(e => console.error('[offsite-backup]', e.message)); };
  const scheduleMidnight = () => setTimeout(() => { tick('schedule'); scheduleMidnight(); }, msUntilNextMidnightNY());
  scheduleMidnight();
  setTimeout(() => tick('boot-catch-up'), 90 * 1000);
  setInterval(() => tick('hourly-retry'), 60 * 60 * 1000);
}
