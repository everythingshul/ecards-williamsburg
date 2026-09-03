// Every applicant gets a random 4-digit ID, used as the external reference
// sent to the disccardpromos gift-card provider (see services/giftcard.js).
// 4 digits only gives 10,000 possible values, so this is meant for a
// single-org platform where the applicant count stays well under that.
export function generateApplicantExternalId(db) {
  const exists = db.prepare('SELECT 1 FROM applicants WHERE external_id = ?');
  for (let attempt = 0; attempt < 50; attempt++) {
    const candidate = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
    if (!exists.get(candidate)) return candidate;
  }
  throw new Error('Could not generate a unique 4-digit applicant ID — the pool of 10,000 IDs may be exhausted.');
}

// Same idea as generateApplicantExternalId, for shuls — a human-readable
// 4-digit "Shul ID", distinct from the shuls.id UUID primary key. Not sent
// to any external provider (shuls aren't gift-card recipients); it exists
// purely so an admin's mass applicant-upload sheet can reference a shul
// unambiguously by ID instead of matching on name (see routes/applicants.js
// POST /import), and so a shul can identify itself/be identified at a
// glance in the admin and shul-portal UI.
export function generateShulNumber(db) {
  const exists = db.prepare('SELECT 1 FROM shuls WHERE shul_number = ?');
  for (let attempt = 0; attempt < 50; attempt++) {
    const candidate = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
    if (!exists.get(candidate)) return candidate;
  }
  throw new Error('Could not generate a unique 4-digit shul ID — the pool of 10,000 IDs may be exhausted.');
}
