import { db, uuid } from '../db.js';

const norm = (s) => (s || '').toString().trim().toLowerCase().replace(/[^a-z0-9]/g, '');

// Fields an admin can pick a per-field winner for when merging a confirmed
// applicant duplicate (see mergeApplicants below) — real identity/contact/
// demographic data only, not status/shul/source/system fields, which aren't
// something to "merge" (each member keeps its own shul_id, approval_status,
// etc. — only the primary's copy of these actual data fields changes).
const MERGE_FIELDS = ['first_name', 'last_name', 'marital_status', 'home_phone', 'husband_cell', 'wife_cell', 'email',
  'address', 'city', 'state', 'zip', 'preferred_contact_method', 'preferred_number', 'num_children', 'home_for_yomtov',
  'comments', 'card_amount'];

// Same idea for shuls (see mergeShuls below) — real identity/contact data
// only, never status/slots_allocated/source/portal_user_id, which aren't
// something to "merge" (the surviving record keeps its own).
const SHUL_MERGE_FIELDS = ['name_en', 'name_he', 'address', 'city', 'state', 'zip',
  'ruv_first_name', 'ruv_last_name', 'ruv_phone', 'ruv_address', 'ruv_city', 'ruv_state', 'ruv_zip',
  'gabai_first_name', 'gabai_last_name', 'gabai_cell', 'gabai_email', 'gabai_address', 'gabai_city', 'gabai_state', 'gabai_zip'];

// Freezes ONLY the newly-created/just-edited record (entityId) — never the
// existing record it matched against (matchedId), which stays fully active
// and usable. A duplicate catch means "this new account needs a human to
// look at it before it goes any further," not "stop whatever the already-
// active account is doing" — the existing account was already trusted
// before this match ever happened, and freezing it (blocking its shul's
// login, deactivating an applicant's already-issued card) would punish the
// wrong side of the pair for a problem it didn't cause. Approval/spending
// on the new side stays blocked via its own is_paused=1 (see routes/
// applicants.js POST /:id/approve and the shul-login 423 in middleware/
// auth.js) until an admin resolves or bypasses the flag.
function pauseAccountsFor(entityType, entityId) {
  if (entityType === 'shul') {
    db.prepare('UPDATE shuls SET is_paused = 1 WHERE id = ?').run(entityId);
    db.prepare(`UPDATE users SET is_paused = 1 WHERE shul_id = ?`).run(entityId);
  } else {
    db.prepare('UPDATE applicants SET is_paused = 1 WHERE id = ?').run(entityId);
    // Applicants don't log in directly, but pause their own card use —
    // never the matched (already-active) applicant's card.
    db.prepare(`UPDATE cards SET status = 'deactivated' WHERE applicant_id = ? AND status != 'deactivated'`).run(entityId);
  }
}

// Checks a shul against existing shuls in the same org (any season — "shouldn't
// need to upload everyone again", so duplicates are detected across seasons too).
// Matches on: normalized name+city, or same Rav phone, or same Gabai email.
// excludeIds lets a caller rule out a specific candidate that's known to be
// the same record on purpose (e.g. carry-forward's own source shul, which
// necessarily matches every field of the row it just generated) rather than
// a genuine second entry of the same real-world shul.
export function checkShulDuplicate(orgId, shul, excludeIds = []) {
  const ids = [shul.id, ...excludeIds];
  const candidates = db.prepare(`SELECT * FROM shuls WHERE org_id = ? AND id NOT IN (${ids.map(() => '?').join(',')})`).all(orgId, ...ids);
  for (const c of candidates) {
    let reason = null;
    if (norm(c.name_en) === norm(shul.name_en) && norm(c.city) === norm(shul.city) && norm(shul.name_en)) reason = 'Same shul name + city';
    else if (shul.ruv_phone && norm(c.ruv_phone) === norm(shul.ruv_phone)) reason = 'Same Rav phone number';
    else if (shul.gabai_email && norm(c.gabai_email) === norm(shul.gabai_email)) reason = 'Same Gabai email';
    if (reason) return { matchedId: c.id, reason };
  }
  return null;
}

// A full first+last name match is a duplicate on its own — no longer
// requires a matching zip too — and so is a match on any single phone
// number (home, husband cell, or wife cell), the email address, or the
// full mailing address (street+city+state+zip together, not just zip
// alone — two applicants sharing a zip code isn't meaningful, but sharing
// an actual street address is).
const fullAddress = (a) => norm([a.address, a.city, a.state, a.zip].filter(Boolean).join('|'));
// Scoped to the applicant's own season, unlike checkShulDuplicate above —
// a shul only exists once and reuses the same row across seasons via
// carry-forward, so matching it against its own past self would be a false
// positive worth catching; an applicant legitimately reapplies fresh every
// season (a new row each time), so matching last season's version of the
// same person is expected, normal behavior, not a duplicate.
// Every field-based reason `a` currently matches candidate `c` on, in the
// same priority order the old single-reason version used to short-circuit
// on — kept as an ordered list (not just a boolean) so checkApplicantDuplicate
// below can report "reasonsNow[0]" for plain creation-time checks (identical
// behavior to before) while also being able to diff the full set against a
// prior state for the continuous re-check case.
function matchReasons(a, aAddress, c) {
  const reasons = [];
  const sameName = norm(a.first_name) && norm(a.last_name) && norm(c.first_name) === norm(a.first_name) && norm(c.last_name) === norm(a.last_name);
  if (sameName) reasons.push('Same first and last name');
  if (a.home_phone && norm(c.home_phone) === norm(a.home_phone)) reasons.push('Same home phone number');
  if (a.husband_cell && norm(c.husband_cell) === norm(a.husband_cell)) reasons.push('Same husband cell number');
  if (a.wife_cell && norm(c.wife_cell) === norm(a.wife_cell)) reasons.push('Same wife cell number');
  if (a.email && norm(c.email) === norm(a.email)) reasons.push('Same email address');
  if (a.address && aAddress === fullAddress(c)) reasons.push('Same address');
  return reasons;
}
// previousApplicant (optional): the record's own field values immediately
// before whatever save is being checked — passed by callers that re-check
// on every edit (not just first-time creation), so a match caused ENTIRELY
// by data that was already there on both sides before this save doesn't
// get re-flagged; only a reason that wasn't already true against this same
// candidate counts as new. Omitted (or null) for a genuinely new record —
// nothing "already existed" for it, so every match is new by definition,
// same as the original one-time creation-only check.
// 'draft' (shul-portal bulk upload, not yet submitted) and 'incomplete'
// (carried-forward, awaiting re-enrollment) rows are excluded from the
// candidate pool entirely — not "real" submissions yet, so they never
// count as either side of a match: two drafts that happen to share a name
// don't flag each other, and an already-active applicant never gets
// flagged just because some unrelated draft shares a field with them. A
// draft/incomplete row being checked can still match — and get flagged
// against — a genuinely active (non-draft/incomplete) applicant, since
// this only narrows the CANDIDATE side, not which row is doing the
// checking.
export function checkApplicantDuplicate(orgId, applicant, previousApplicant) {
  const candidates = db.prepare(`SELECT * FROM applicants WHERE org_id = ? AND season_id = ? AND id != ? AND approval_status NOT IN ('draft', 'incomplete')`).all(orgId, applicant.season_id, applicant.id);
  const applicantAddress = fullAddress(applicant);
  const previousAddress = previousApplicant ? fullAddress(previousApplicant) : null;
  for (const c of candidates) {
    // Already confirmed the same real person (see mergeApplicants) — a
    // later edit to either one's own fields shouldn't re-flag a pair
    // that's already been resolved as one identity.
    if (applicant.merge_group_id && c.merge_group_id === applicant.merge_group_id) continue;
    const reasonsNow = matchReasons(applicant, applicantAddress, c);
    if (!reasonsNow.length) continue;
    if (previousApplicant) {
      const reasonsBefore = new Set(matchReasons(previousApplicant, previousAddress, c));
      const newReasons = reasonsNow.filter(r => !reasonsBefore.has(r));
      if (!newReasons.length) continue;
      return { matchedId: c.id, reason: newReasons[0] };
    }
    return { matchedId: c.id, reason: reasonsNow[0] };
  }
  return null;
}

// Runs the appropriate check, and if found: flags it, pauses the NEW/edited
// account only (see pauseAccountsFor above), and returns the flag row.
// If not found: returns null and leaves the record active. excludeIds (shul only,
// see checkShulDuplicate) lets a caller rule out a record known to be the same
// entity on purpose, like carry-forward's own source shul. previousEntity
// (applicant only) is the record's own pre-save state — see
// checkApplicantDuplicate's matching comment — passed by callers that
// re-check on every edit rather than just at first-time creation.
export function detectAndFlag(orgId, entityType, entity, excludeIds = [], previousEntity) {
  const match = entityType === 'shul' ? checkShulDuplicate(orgId, entity, excludeIds) : checkApplicantDuplicate(orgId, entity, previousEntity);
  if (!match) return null;
  // Never stack a second open flag on the same pair — an edit that
  // introduces one newly-matching field on top of an already-open flag
  // (from an earlier, different reason) doesn't need its own separate row;
  // there's already one sitting there for an admin to resolve.
  const existingOpen = db.prepare(`SELECT * FROM duplicate_flags WHERE org_id = ? AND entity_type = ? AND status = 'open'
      AND ((entity_id = ? AND matched_entity_id = ?) OR (entity_id = ? AND matched_entity_id = ?))`)
    .get(orgId, entityType, entity.id, match.matchedId, match.matchedId, entity.id);
  if (existingOpen) return existingOpen;
  const id = uuid();
  db.prepare(`INSERT INTO duplicate_flags (id, org_id, entity_type, entity_id, matched_entity_id, reason, status)
    VALUES (?,?,?,?,?,?,'open')`).run(id, orgId, entityType, entity.id, match.matchedId, match.reason);
  if (entityType === 'shul') db.prepare(`UPDATE shuls SET duplicate_status = 'flagged', duplicate_of_shul_id = ? WHERE id = ?`).run(match.matchedId, entity.id);
  else db.prepare(`UPDATE applicants SET duplicate_status = 'flagged', duplicate_of_applicant_id = ? WHERE id = ?`).run(match.matchedId, entity.id);
  pauseAccountsFor(entityType, entity.id);
  return db.prepare('SELECT * FROM duplicate_flags WHERE id = ?').get(id);
}

// Which fields count as "a phone number" for the never-bypass-if-matched
// rule below — checked as a set against a set, so a cell on one side
// matching the OTHER side's home phone (not just the same field) still
// counts; only an actual phone-to-phone match blocks bypass, never an
// address/name coincidence.
const PHONE_FIELDS = ['home_phone', 'husband_cell', 'wife_cell'];
function phoneSet(a) { return new Set(PHONE_FIELDS.map(f => norm(a[f])).filter(Boolean)); }
export function applicantsSharePhone(a, b) {
  const setA = phoneSet(a);
  for (const p of phoneSet(b)) if (setA.has(p)) return true;
  return false;
}

// Admin resolves an applicant duplicate flag one of two ways:
//  - bypass: these are actually two different people who happened to share
//    one non-phone detail (address, name, ...) — un-pauses both, leaves
//    both records exactly as they are. Refused outright if the two records
//    share an actual phone number — that's never a coincidence, so bypass
//    isn't offered as an option; mergeApplicants() below is the only path.
//  - shul duplicates (entity_type 'shul') additionally keep the original
//    simple bypass/resolve actions on top of mergeShuls() below — either
//    "these are genuinely two different shuls" (bypass) or "handled some
//    other way, not by merging" (resolve), for the cases where a real merge
//    (moving one shul's applicants onto the other, one surviving record)
//    isn't actually what happened.
export function resolveFlag(flagId, resolvedByUserId, action) {
  const flag = db.prepare('SELECT * FROM duplicate_flags WHERE id = ?').get(flagId);
  if (!flag) return null;
  if (flag.status !== 'open') throw new Error('This flag was already resolved');
  if (flag.entity_type === 'applicant') {
    if (action !== 'bypass') throw new Error('Applicant duplicates can only be bypassed here — resolving one as the same person is done through the merge action instead');
    const a = db.prepare('SELECT * FROM applicants WHERE id = ?').get(flag.entity_id);
    const b = db.prepare('SELECT * FROM applicants WHERE id = ?').get(flag.matched_entity_id);
    if (a && b && applicantsSharePhone(a, b)) throw new Error('These records share a phone number, so they can\'t be bypassed as different people — resolve this as a merge instead.');
    db.prepare(`UPDATE duplicate_flags SET status = 'bypassed', resolved_by = ?, resolved_at = datetime('now') WHERE id = ?`).run(resolvedByUserId, flagId);
    db.prepare('UPDATE applicants SET is_paused = 0, duplicate_status = ? WHERE id IN (?, ?)').run('bypassed', flag.entity_id, flag.matched_entity_id);
    return db.prepare('SELECT * FROM duplicate_flags WHERE id = ?').get(flagId);
  }
  db.prepare(`UPDATE duplicate_flags SET status = ?, resolved_by = ?, resolved_at = datetime('now') WHERE id = ?`)
    .run(action === 'bypass' ? 'bypassed' : 'resolved', resolvedByUserId, flagId);
  db.prepare('UPDATE shuls SET is_paused = 0, duplicate_status = ? WHERE id IN (?, ?)')
    .run(action === 'bypass' ? 'bypassed' : 'resolved', flag.entity_id, flag.matched_entity_id);
  db.prepare(`UPDATE users SET is_paused = 0 WHERE shul_id IN (?, ?)`).run(flag.entity_id, flag.matched_entity_id);
  return db.prepare('SELECT * FROM duplicate_flags WHERE id = ?').get(flagId);
}

// Finds every applicant that's part of the same real-world-person cluster as
// any of `startIds` — a duplicate isn't always just a pair; the same family
// can get submitted by three, four, five different shuls in one season.
// Chains through open flags (a flag A<->B plus a separate flag B<->C
// surfaces A, B, and C together) and through any merge_group_id an id
// already carries (so flagging a new 5th shul's applicant against one
// member of an already-merged group pulls in the whole existing group).
export function getMergeGroupIds(orgId, startIds) {
  const ids = new Set(startIds);
  let grew = true;
  while (grew) {
    grew = false;
    const list = [...ids];
    const placeholders = list.map(() => '?').join(',');
    const groupRows = db.prepare(`SELECT merge_group_id FROM applicants WHERE id IN (${placeholders}) AND merge_group_id IS NOT NULL`).all(...list);
    const groupIds = [...new Set(groupRows.map(r => r.merge_group_id))];
    if (groupIds.length) {
      const gp = groupIds.map(() => '?').join(',');
      for (const m of db.prepare(`SELECT id FROM applicants WHERE merge_group_id IN (${gp})`).all(...groupIds)) {
        if (!ids.has(m.id)) { ids.add(m.id); grew = true; }
      }
    }
    for (const f of db.prepare(`SELECT entity_id, matched_entity_id FROM duplicate_flags
        WHERE org_id = ? AND entity_type='applicant' AND status='open' AND (entity_id IN (${placeholders}) OR matched_entity_id IN (${placeholders}))`)
        .all(orgId, ...list, ...list)) {
      if (!ids.has(f.entity_id)) { ids.add(f.entity_id); grew = true; }
      if (!ids.has(f.matched_entity_id)) { ids.add(f.matched_entity_id); grew = true; }
    }
  }
  return [...ids];
}

// Forced resolution for an applicant duplicate: admin has confirmed these
// really are the same person across however many shuls submitted them.
// `values` is the admin's chosen composite (per-field, mixed and matched
// from whichever member's data is correct) — written onto the primary
// record only; every other member's own row is left completely untouched,
// so each shul still sees exactly what THEY submitted (shul-blind, per
// spec — a shul only ever sees its own applicant, never that the same
// person is enrolled elsewhere). Every member gets merge_group_id set to
// the primary's id (== how a "is this the primary" check works elsewhere),
// duplicate_status='merged', and unpaused. Every open flag connecting two
// members of the resolved group is marked resolved.
export function mergeApplicants(orgId, userId, { primaryId, values, memberIds } = {}) {
  if (!primaryId) throw new Error('primaryId is required');
  const fullGroupIds = getMergeGroupIds(orgId, [primaryId]);
  // memberIds lets an admin merge only PART of a larger connected group in
  // this pass (see the compare view's per-member Dismiss button — a group
  // can be 3, 4, 5+ records once duplicate flags chain together, and not
  // every pair in it is necessarily the same person just because they're
  // all transitively connected to each other). Whatever's left out stays
  // exactly as it is — still an open duplicate flag, unmerged — so it can
  // be resolved separately later instead of being forced into one merge.
  // Falls back to the full transitive group when omitted, same as before.
  const groupIds = Array.isArray(memberIds) && memberIds.length
    ? [...new Set(memberIds.filter(id => fullGroupIds.includes(id)).concat(primaryId))]
    : fullGroupIds;
  const placeholders = groupIds.map(() => '?').join(',');
  const members = db.prepare(`SELECT * FROM applicants WHERE id IN (${placeholders}) AND org_id = ?`).all(...groupIds, orgId);
  if (members.length < 2) throw new Error('Need at least two related records to merge');
  const primary = members.find(m => m.id === primaryId);
  if (!primary) throw new Error('Primary record not found in this group');
  // A soft-rejected record (see routes/applicants.js's POST /:id/soft-reject)
  // has no shul by definition — that's what the status means. Picking one as
  // primary would "resolve" the flag into a record nobody can actually act
  // on, silently losing whatever shul was trying to re-enroll this person.
  // The correct resolution for that case is the other direction: pick the
  // ACTIVE record (the one with a real shul) as primary, which naturally
  // folds the old soft-rejected identity into it below — the frontend's
  // merge view disables picking a soft-rejected member as primary for
  // exactly this reason, this is just the backend backstop.
  if (!primary.shul_id) throw new Error('This record has no shul — pick the other record as Primary instead.');

  const sets = Object.keys(values || {}).filter(k => MERGE_FIELDS.includes(k));
  const setSql = sets.length ? `, ${sets.map(k => `${k} = ?`).join(', ')}` : '';
  db.prepare(`UPDATE applicants SET merge_group_id = ?, duplicate_status = 'merged', is_paused = 0, updated_at = datetime('now')${setSql} WHERE id = ?`)
    .run(primaryId, ...sets.map(k => values[k]), primaryId);
  for (const m of members) {
    if (m.id === primaryId) continue;
    // A losing member that was soft-rejected is now permanently subsumed
    // into the primary (not just "orphaned and recoverable" anymore, which
    // is what 'soft_rejected' means) — 'rejected' is the correct terminal
    // state for it, and keeps it out of the Soft Reject filter/queue going
    // forward. Every other loser keeps whatever status it already had, same
    // as before.
    const loserStatus = m.approval_status === 'soft_rejected' ? `, approval_status = 'rejected'` : '';
    db.prepare(`UPDATE applicants SET merge_group_id = ?, duplicate_status = 'merged', is_paused = 0, updated_at = datetime('now')${loserStatus} WHERE id = ?`).run(primaryId, m.id);
  }
  const flagIds = db.prepare(`SELECT id FROM duplicate_flags WHERE org_id = ? AND entity_type='applicant' AND status='open'
      AND entity_id IN (${placeholders}) AND matched_entity_id IN (${placeholders})`).all(orgId, ...groupIds, ...groupIds).map(r => r.id);
  if (flagIds.length) {
    const fp = flagIds.map(() => '?').join(',');
    db.prepare(`UPDATE duplicate_flags SET status='resolved', resolved_by=?, resolved_at=datetime('now') WHERE id IN (${fp})`).run(userId, ...flagIds);
  }
  // One real disccardpromos account for the whole group, from this moment
  // on — routes/applicants.js's POST /:id/approve already does this
  // propagation, but only reactively (whichever member happens to be
  // approved next inherits whatever account exists at that time). Doing it
  // here too means a group where one member was already approved (and so
  // already has a real account) shows that same account on every member's
  // profile immediately, not just after the next approval.
  const distinctAccounts = [...new Set(members.map(m => m.provider_account_id).filter(Boolean))];
  let accountConflict = false;
  if (distinctAccounts.length === 1) {
    db.prepare(`UPDATE applicants SET provider_account_id = ? WHERE id IN (${placeholders}) AND provider_account_id IS NULL`).run(distinctAccounts[0], ...groupIds);
  } else if (distinctAccounts.length > 1) {
    // More than one member was independently approved before being merged,
    // so more than one real (and possibly funded) disccardpromos account
    // already exists — there's no confirmed API to merge two live accounts
    // (see services/giftcard.js's header), so this is surfaced for a human
    // to reconcile manually rather than guessed at automatically.
    accountConflict = true;
  }
  return { primaryId, memberIds: groupIds, accountConflict };
}

// Same idea as getMergeGroupIds above, but for shuls: chains through open
// shul flags AND through duplicate_of_shul_id (shuls have no dedicated
// merge_group_id column — this reuses the same field a flag already sets,
// since after a merge it means the same thing: "this record's real,
// surviving self is that other one"), so re-flagging a shul against one
// already-merged member pulls the whole existing group back in.
export function getShulMergeGroupIds(orgId, startIds) {
  const ids = new Set(startIds);
  let grew = true;
  while (grew) {
    grew = false;
    const list = [...ids];
    const placeholders = list.map(() => '?').join(',');
    for (const r of db.prepare(`SELECT duplicate_of_shul_id FROM shuls WHERE id IN (${placeholders}) AND duplicate_of_shul_id IS NOT NULL`).all(...list)) {
      if (!ids.has(r.duplicate_of_shul_id)) { ids.add(r.duplicate_of_shul_id); grew = true; }
    }
    const list2 = [...ids];
    const placeholders2 = list2.map(() => '?').join(',');
    for (const r of db.prepare(`SELECT id FROM shuls WHERE duplicate_of_shul_id IN (${placeholders2})`).all(...list2)) {
      if (!ids.has(r.id)) { ids.add(r.id); grew = true; }
    }
    for (const f of db.prepare(`SELECT entity_id, matched_entity_id FROM duplicate_flags
        WHERE org_id = ? AND entity_type='shul' AND status='open' AND (entity_id IN (${placeholders}) OR matched_entity_id IN (${placeholders}))`)
        .all(orgId, ...list, ...list)) {
      if (!ids.has(f.entity_id)) { ids.add(f.entity_id); grew = true; }
      if (!ids.has(f.matched_entity_id)) { ids.add(f.matched_entity_id); grew = true; }
    }
  }
  return [...ids];
}

// Forced resolution for a shul duplicate: admin has confirmed two (or more,
// chained) shul records are really the same real-world shul. `primaryId`
// picks which record survives going forward; `values` is the admin's
// per-field composite (mixed and matched from whichever member's data is
// correct), written onto the primary only. Every other member's own
// applicants — the ones actually in the primary's season, since an
// applicant can never be reassigned across seasons (see applicants.js
// PUT /:id's identical rule) — are moved onto the primary so nothing
// submitted under the duplicate is orphaned; the duplicate row itself is
// left in place (never deleted) as a historical record, marked
// duplicate_status='merged' and pointed at the primary via
// duplicate_of_shul_id, unpaused along with its portal login.
// `memberIds` mirrors mergeApplicants' same-named param (see the compare
// view's per-member Dismiss button) — a chained group can have a member
// that isn't actually the same shul as the rest, and leaving it off
// memberIds keeps it, and its flag(s) against the merged members, exactly
// as they were: still open, still flagged. Falls back to the full
// transitive group when omitted.
export function mergeShuls(orgId, userId, { primaryId, values, memberIds } = {}) {
  if (!primaryId) throw new Error('primaryId is required');
  const fullGroupIds = getShulMergeGroupIds(orgId, [primaryId]);
  const groupIds = Array.isArray(memberIds) && memberIds.length
    ? [...new Set(memberIds.filter(id => fullGroupIds.includes(id)).concat(primaryId))]
    : fullGroupIds;
  const placeholders = groupIds.map(() => '?').join(',');
  const members = db.prepare(`SELECT * FROM shuls WHERE id IN (${placeholders}) AND org_id = ?`).all(...groupIds, orgId);
  if (members.length < 2) throw new Error('Need at least two related records to merge');
  const primary = members.find(m => m.id === primaryId);
  if (!primary) throw new Error('Primary record not found in this group');

  let applicantsReassigned = 0;
  for (const m of members) {
    if (m.id === primaryId) continue;
    const result = db.prepare(`UPDATE applicants SET shul_id = ?, updated_at = datetime('now') WHERE shul_id = ? AND season_id = ?`)
      .run(primaryId, m.id, primary.season_id);
    applicantsReassigned += result.changes;
    db.prepare(`UPDATE shuls SET duplicate_of_shul_id = ?, duplicate_status = 'merged', is_paused = 0, updated_at = datetime('now') WHERE id = ?`).run(primaryId, m.id);
    db.prepare(`UPDATE users SET is_paused = 0 WHERE shul_id = ?`).run(m.id);
  }
  const sets = Object.keys(values || {}).filter(k => SHUL_MERGE_FIELDS.includes(k));
  const setSql = sets.length ? `, ${sets.map(k => `${k} = ?`).join(', ')}` : '';
  db.prepare(`UPDATE shuls SET duplicate_status = 'merged', is_paused = 0, updated_at = datetime('now')${setSql} WHERE id = ?`)
    .run(...sets.map(k => values[k]), primaryId);
  db.prepare(`UPDATE users SET is_paused = 0 WHERE shul_id = ?`).run(primaryId);

  const flagIds = db.prepare(`SELECT id FROM duplicate_flags WHERE org_id = ? AND entity_type='shul' AND status='open'
      AND entity_id IN (${placeholders}) AND matched_entity_id IN (${placeholders})`).all(orgId, ...groupIds, ...groupIds).map(r => r.id);
  if (flagIds.length) {
    const fp = flagIds.map(() => '?').join(',');
    db.prepare(`UPDATE duplicate_flags SET status='resolved', resolved_by=?, resolved_at=datetime('now') WHERE id IN (${fp})`).run(userId, ...flagIds);
  }
  return { primaryId, memberIds: groupIds, applicantsReassigned };
}
