// Full-disk export/import — moves the ENTIRE DATA_DIR (the sqlite database
// plus every uploaded file: signed contract/document PDFs, drawn signature
// images, logos, store bill attachments, form images, update attachments)
// as one archive. This is a strict superset of the existing Settings >
// Backups "Download Backup Now" feature, which only ever captured the
// database file itself and explicitly documented that gap (see
// services/backup.js) — this closes it, and doubles as the account-to-
// account migration tool (export from the old Render service, import into
// a brand new one on a different account).
import { Router } from 'express';
import multer from 'multer';
import { spawn } from 'child_process';
import { existsSync, mkdirSync, unlinkSync, readdirSync } from 'fs';
import { join } from 'path';
import { db, DATA_DIR } from '../db.js';
import { auth, requireAdmin } from '../middleware/auth.js';

const router = Router();
router.use(auth, requireAdmin);

const TMP_DIR = join(DATA_DIR, 'tmp');
if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });

// diskStorage, not memoryStorage — this archive can approach the size of the
// whole persistent disk (up to 1GB per render.yaml), and buffering that in
// process memory on a small Render plan risks crashing the app. Written
// straight to a temp file instead.
const upload = multer({
  storage: multer.diskStorage({
    destination: TMP_DIR,
    filename: (req, file, cb) => cb(null, `restore-upload-${Date.now()}.tar.gz`),
  }),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },
});

// Streams a tar.gz of DATA_DIR straight from `tar`'s stdout to the response
// — nothing is buffered in memory regardless of archive size. A WAL
// checkpoint first folds any pending write-ahead-log content into the main
// .sqlite file so the exported database is fully self-contained (no
// dependency on -wal/-shm sidecar files carrying over correctly).
//
// Archives DATA_DIR's individual top-level entries (ecards.sqlite,
// uploads/, contracts/, ...) rather than `.` itself — live-tested
// 2026-08-20 against a real Render persistent-disk mount: archiving `.`
// records a directory entry for the mount root, and on extract GNU tar's
// final pass tries to restore that entry's own permissions/mtime to match
// the archive, which fails with EPERM because the mount root's own
// metadata isn't something this process is allowed to change (even though
// everything under it is writable). Never archiving a `./` entry in the
// first place sidesteps that restore attempt entirely on import.
router.get('/export', (req, res) => {
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (e) { console.error('[migration] wal checkpoint failed:', e.message); }
  res.setHeader('Content-Type', 'application/gzip');
  res.setHeader('Content-Disposition', `attachment; filename="kipas-hair-bp-full-data-${Date.now()}.tar.gz"`);
  const entries = readdirSync(DATA_DIR).filter((name) => name !== 'tmp');
  const tar = spawn('tar', ['czf', '-', '-C', DATA_DIR, ...entries]);
  tar.stdout.pipe(res);
  tar.stderr.on('data', (d) => console.error('[migration export] tar stderr:', d.toString()));
  tar.on('error', (e) => { console.error('[migration export] tar failed to start:', e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); });
});

// Restores an archive produced by /export into THIS service's DATA_DIR —
// meant for a brand new, still-empty service being bootstrapped from
// another account's data, not for a live instance. Refuses if real data
// already exists here (checked by shul/applicant counts) unless
// ?force=true is explicitly passed, so this can never be an accidental way
// to clobber a running production instance.
//
// Overwriting ecards.sqlite while this same process has it open is safe on
// Linux: tar replaces the directory entry rather than editing the file this
// process already has open, so this process keeps reading/writing its
// original (now-unlinked-but-still-live) file handle until it reopens the
// path — which is exactly why this ends with an exit() instead of trying
// to keep serving: Render's restart policy relaunches the process clean,
// and every connection (the db import included) opens fresh against the
// restored files.
router.post('/import', upload.single('archive'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No archive uploaded' });
  const force = req.query.force === 'true';
  const shulCount = db.prepare('SELECT COUNT(*) c FROM shuls').get().c;
  const applicantCount = db.prepare('SELECT COUNT(*) c FROM applicants').get().c;
  if (!force && (shulCount > 0 || applicantCount > 0)) {
    try { unlinkSync(req.file.path); } catch { /* best effort */ }
    return res.status(409).json({ error: `This service already has data (${shulCount} shul(s), ${applicantCount} applicant(s)) — refusing to overwrite it. Pass ?force=true only if you deliberately mean to replace it.` });
  }
  try {
    await new Promise((resolve, reject) => {
      const tar = spawn('tar', ['xzf', req.file.path, '-C', DATA_DIR, '--no-same-owner']);
      tar.stderr.on('data', (d) => console.error('[migration import] tar stderr:', d.toString()));
      tar.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`tar exited with code ${code}`)));
      tar.on('error', reject);
    });
  } catch (e) {
    return res.status(500).json({ error: `Extraction failed: ${e.message}` });
  } finally {
    try { unlinkSync(req.file.path); } catch { /* best effort */ }
  }
  res.json({ ok: true, message: 'Data restored. The service is restarting to load it — give it about a minute, then log in with the ORIGINAL account\'s admin credentials (they came along in the restored database).' });
  setTimeout(() => process.exit(0), 500);
});

export default router;
