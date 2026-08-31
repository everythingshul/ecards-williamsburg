// Login (routes/auth.js) always lowercases what the user types before
// looking the account up, and SQLite string comparison is case-sensitive —
// so a users.email stored with ANY uppercase (e.g. a gabai_email typed as
// "Moshe@Gmail.com" on the shul application) was an account that could
// never be signed into and never received a password-reset email. Every
// write or lookup against users.email must go through this.
export function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}
