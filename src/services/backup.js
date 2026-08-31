// ---------------------------------------------------------------------------
// Local rotating backups of the SQLite database — protects against
// accidental deletion, a bad write, or app-level data corruption. This does
// NOT protect against losing the whole persistent disk (a backup stored on
// the same disk as the thing it's backing up is gone if that disk is), which
// is a real, separate risk on this platform (see db.js's seed-password
// comment about a disk that fails to attach). Real off-disk protection needs
// somewhere else to send backups to (S3/Backblaze/etc, or emailing them out)
// — that needs credentials this app doesn't have configured, so it isn't
// attempted here. The manual "Download Backup Now" action (settings.js) is
// the practical off-disk option in the meantime: it hands the admin a file
// they can save wherever they want, on demand.
// ---------------------------------------------------------------------------
import { join } from 'path';
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'fs';
import { db, DATA_DIR } from '../db.js';

export const BACKUP_DIR = join(DATA_DIR, 'backups');
if (!existsSync(BACKUP_DIR)) mkdirSync(BACKUP_DIR, { recursive: true });

// Retention is a count, not a time window, deliberately — this disk is only
// 1GB total (shared with uploaded contracts/logos/attachments), so an
// unbounded time-based policy risks filling it if the DB ever grows. 12
// snapshots at the default 4-hour interval covers 48 hours of history.
const RETENTION_COUNT = +process.env.BACKUP_RETENTION_COUNT || 12;
const FILENAME_RE = /^ecards-(\d{8}-\d{6})\.sqlite$/;

function backupFilename(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `ecards-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.sqlite`;
}

// Uses SQLite's own online-backup API (db.backup()) rather than copying the
// file directly — a plain fs copy of a live WAL-mode database can capture a
// torn/inconsistent snapshot mid-write; .backup() is the safe way to do this
// while the app keeps serving requests.
export async function runBackup() {
  const path = join(BACKUP_DIR, backupFilename());
  await db.backup(path);
  pruneOldBackups();
  return path;
}

function pruneOldBackups() {
  const files = listBackups();
  for (const f of files.slice(RETENTION_COUNT)) {
    try { unlinkSync(join(BACKUP_DIR, f.filename)); } catch { /* already gone */ }
  }
}

export function listBackups() {
  if (!existsSync(BACKUP_DIR)) return [];
  return readdirSync(BACKUP_DIR)
    .filter((f) => FILENAME_RE.test(f))
    .map((filename) => {
      const stat = statSync(join(BACKUP_DIR, filename));
      return { filename, sizeBytes: stat.size, createdAt: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// Resolves a backup filename to a safe absolute path, or null — the regex
// match is also the path-traversal guard (no '..', no '/', exact shape only).
export function backupPath(filename) {
  if (!FILENAME_RE.test(filename)) return null;
  const path = join(BACKUP_DIR, filename);
  return existsSync(path) ? path : null;
}
