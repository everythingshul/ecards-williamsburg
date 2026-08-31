// MUST be imported before any router is dispatched (patches Express's Layer
// prototype): Express 4 does not catch a rejected/thrown promise from an
// `async (req, res) => {...}` route handler — an uncaught error in ANY async
// route (there are dozens across this app) crashes the whole Node process
// for every concurrent user instead of returning a JSON 500 to just the one
// request that hit it. Confirmed by hand: without this, an unguarded throw
// in an async handler never reaches the app.use((err, req, res, next) => ...)
// handler below at all — it's an unhandled rejection that kills the process.
import 'express-async-errors';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { initMail } from './services/mail.js';
import { sendDueTaskReminders } from './services/reminders.js';
import { syncAllCards } from './services/cardSync.js';
import { syncInboundSms, getOwnSmsNumber } from './services/sms.js';
import { runBackup } from './services/backup.js';
import { DEFAULT_ORG_ID } from './db.js';

import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import orgRoutes from './routes/orgs.js';
import seasonRoutes from './routes/seasons.js';
import settingsRoutes from './routes/settings.js';
import contractSettingsRoutes from './routes/contractSettings.js';
import siteContentRoutes from './routes/siteContent.js';
import shulRoutes from './routes/shuls.js';
import applicantRoutes from './routes/applicants.js';
import cardRoutes from './routes/cards.js';
import storeRoutes from './routes/stores.js';
import formRoutes from './routes/forms.js';
import dashboardRoutes from './routes/dashboard.js';
import taskRoutes from './routes/tasks.js';
import systemExportRoutes from './routes/systemExport.js';
import documentRoutes from './routes/documents.js';
import emailRoutes from './routes/emails.js';
import smsRoutes from './routes/sms.js';
import updateRoutes from './routes/updates.js';
import auditRoutes from './routes/audit.js';
import preferencesRoutes from './routes/preferences.js';
import contactRoutes from './routes/contact.js';
import analyticsRoutes from './routes/analytics.js';
import migrationRoutes from './routes/migration.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3002;
const FRONTEND_DIR = join(__dirname, '..', 'frontend');

// Render (like any host behind a reverse proxy) terminates the client
// connection itself and forwards the request here — without this, every
// single request looks like it came from Render's own proxy, so req.ip
// (and every IP-keyed rate limiter below) sees the ENTIRE SITE as one
// visitor. That's what was actually behind reports of sitewide login
// lockouts: once anyone, anywhere, made 20 combined login/reset/invite
// requests within 15 minutes, EVERY visitor got 429'd — including
// forgot-password requests, blocked before they ever reach
// sendMailChecked, which is why "can't sign in" and "no reset email"
// were being reported together. `1` trusts exactly the first hop
// (Render's proxy) and reads the real client IP from X-Forwarded-For —
// the standard setting for a single-reverse-proxy host.
app.set('trust proxy', 1);

// Standard hardening headers (HSTS, X-Frame-Options, X-Content-Type-Options,
// Referrer-Policy, etc.). contentSecurityPolicy/crossOriginEmbedderPolicy are
// off: every admin/portal page is server-rendered with inline <script> blocks
// and inline onclick= handlers throughout (no build step, no nonce
// plumbing), so helmet's default CSP would break the entire frontend. A real
// CSP here is a follow-up that needs those pages restructured first, not
// something to silently half-enable. crossOriginResourcePolicy is off too:
// helmet's default (same-origin) blocks the org logo / update attachment
// images under /img and /uploads/* from loading at all inside an email
// client (a different origin by definition) — it would silently break the
// branded email template and inline update images. These files are already
// served with no auth check (the URL itself is the only gate), so relaxing
// this adds no real exposure, just stops blocking legitimate embedding.
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false, crossOriginResourcePolicy: false }));
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || process.env.APP_URL || '*', credentials: true }));
app.use(express.json({ limit: '15mb' })); // e-signature PNGs are base64 in JSON bodies
app.use(express.urlencoded({ extended: true, limit: '15mb' }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 2000 }));
// Auth endpoints get their own much tighter limit — the blanket 2000/15min
// above is sized for normal app usage (list pages, dashboards polling), not
// for how many password/token guesses one IP should get. Scoped to just the
// four routes that are actually a credential-guessing surface (login,
// forgot-password, accept-invite, change-password) — GET /me is deliberately
// excluded: it's a routine "is my session still good" check that fires on
// every admin page load for logged-in staff/org_admin users (see app.js's
// refreshPermissions), not something a password guesser hits, and sharing
// this tight a budget with it was enough on its own to lock a normal
// browsing session out of login/forgot-password within minutes. /me stays
// covered by the blanket 2000/15min limit above instead.
const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait a few minutes and try again.' },
});
app.use('/api/auth/login', authRateLimit);
app.use('/api/auth/forgot-password', authRateLimit);
app.use('/api/auth/accept-invite', authRateLimit);
app.use('/api/auth/change-password', authRateLimit);

initMail();

// Public runtime config for the frontend — safe, publishable keys only.
// GOOGLE_MAPS_API_KEY should be restricted to this domain in Google Cloud Console.
app.get('/api/config', (req, res) => {
  res.json({
    googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY || '',
    appName: process.env.ORG_NAME || "Shmachas Rechag - Kupat Ha'ir",
  });
});

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/orgs', orgRoutes);
app.use('/api/seasons', seasonRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/contract-settings', contractSettingsRoutes);
app.use('/api/site-content', siteContentRoutes);
app.use('/api/shuls', shulRoutes);
app.use('/api/applicants', applicantRoutes);
app.use('/api/cards', cardRoutes);
app.use('/api/stores', storeRoutes);
app.use('/api/forms', formRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/system-export', systemExportRoutes);
app.use('/api/documents', documentRoutes);
app.use('/api/emails', emailRoutes);
app.use('/api/sms', smsRoutes);
app.use('/api/updates', updateRoutes);
app.use('/api/audit', auditRoutes);
app.use('/api/preferences', preferencesRoutes);
app.use('/api/contact', contactRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/migration', migrationRoutes);

// Signed/generated PDFs, uploaded logos, and update attachments.
app.use('/uploads/contracts', express.static(join(process.env.DATA_DIR || join(process.cwd(), 'data'), 'contracts')));
app.use('/uploads/logos', express.static(join(process.env.DATA_DIR || join(process.cwd(), 'data'), 'logos')));
app.use('/uploads/updates', express.static(join(process.env.DATA_DIR || join(process.cwd(), 'data'), 'updates')));
app.use('/uploads/forms', express.static(join(process.env.DATA_DIR || join(process.cwd(), 'data'), 'forms')));
app.use('/uploads/homepage', express.static(join(process.env.DATA_DIR || join(process.cwd(), 'data'), 'homepage')));

// Canonicalize old .html links/bookmarks to the extensionless URL (301, so
// search engines and browsers update their stored copy) — everything on the
// site now links extensionless (see the fallback below), but pre-existing
// bookmarks, emails already sent with a .html link, or anyone typing the old
// URL by hand should still land on a working, canonical page rather than a
// dead link. index.html is exempt: "/" is already its canonical form.
app.get(/^\/(?!api\/|uploads\/).*\.html$/, (req, res, next) => {
  if (req.path === '/index.html') return next();
  const clean = req.path.slice(0, -'.html'.length) || '/';
  res.redirect(301, clean + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''));
});

app.use(express.static(FRONTEND_DIR));

app.get('/', (req, res) => res.sendFile(join(FRONTEND_DIR, 'index.html')));

// SPA-ish fallback for clean admin URLs without extensions.
app.get(/^\/(?!api\/|uploads\/).*/, (req, res, next) => {
  if (req.path.includes('.')) return next(); // let express.static 404 real missing assets
  const candidate = join(FRONTEND_DIR, req.path + '.html');
  res.sendFile(candidate, (err) => { if (err) res.status(404).sendFile(join(FRONTEND_DIR, 'index.html')); });
});

app.use((err, req, res, next) => {
  console.error('[unhandled]', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => console.log(`[ecards] listening on :${PORT}`));

// Due-date task reminders — checked periodically (single-instance in-process
// interval; see services/reminders.js for why).
const REMINDER_INTERVAL_MS = 30 * 60 * 1000;
setInterval(() => { sendDueTaskReminders().catch(e => console.error('[reminders] check failed', e.message)); }, REMINDER_INTERVAL_MS);
setTimeout(() => { sendDueTaskReminders().catch(e => console.error('[reminders] check failed', e.message)); }, 15 * 1000);

// Automatic disccardpromos sync — pulls transactions for every active card so
// store spend, balances, and the transaction ledger stay live without an
// admin manually clicking "Sync Now" on each card. No-ops instantly while in
// mock mode (no credentials configured yet).
const CARD_SYNC_INTERVAL_MS = 15 * 60 * 1000;
setInterval(() => { syncAllCards(DEFAULT_ORG_ID).catch(e => console.error('[cardSync] sweep failed', e.message)); }, CARD_SYNC_INTERVAL_MS);
setTimeout(() => { syncAllCards(DEFAULT_ORG_ID).catch(e => console.error('[cardSync] sweep failed', e.message)); }, 20 * 1000);

// Automatic inbound-SMS sync — SimpleSender doesn't support webhooks yet, so
// this polls GET /v1/messages for new incoming replies instead. No-ops
// instantly in mock mode.
const SMS_SYNC_INTERVAL_MS = 15 * 60 * 1000;
setInterval(() => { syncInboundSms(DEFAULT_ORG_ID, getOwnSmsNumber(DEFAULT_ORG_ID)).catch(e => console.error('[sms] inbound sync failed', e.message)); }, SMS_SYNC_INTERVAL_MS);
setTimeout(() => { syncInboundSms(DEFAULT_ORG_ID, getOwnSmsNumber(DEFAULT_ORG_ID)).catch(e => console.error('[sms] inbound sync failed', e.message)); }, 25 * 1000);

// Rotating local DB backups (services/backup.js) — every 4 hours, 12 kept
// (48 hours of coverage) by default. Runs once shortly after boot too so a
// freshly-deployed instance isn't hours away from having any backup at all.
const BACKUP_INTERVAL_MS = 4 * 60 * 60 * 1000;
setInterval(() => { runBackup().catch(e => console.error('[backup] failed', e.message)); }, BACKUP_INTERVAL_MS);
setTimeout(() => { runBackup().catch(e => console.error('[backup] failed', e.message)); }, 30 * 1000);
