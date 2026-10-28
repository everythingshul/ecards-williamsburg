# everythingshul e-cards platform

## What this is
Single-org season-based gift card assistance platform: shuls register + e-sign
a contract, admin approves and allocates applicant slots, shuls submit
applicants, admin approves applicants and issues gift cards via
disccardpromos.com, and participating stores apply/onboard and get a
self-service portal with billing. Deploy target: `ecards.everythingshul.com`.

This is a single-organization deployment — not a multi-tenant SaaS. An
earlier pass built (and then reverted) multi-org support; the `org_id`
columns remain in the schema for internal consistency but there is exactly
one row in `organizations`, seeded at first boot, and no UI to create more.

## Stack (mirrors the existing "Mamudem" product's conventions in this org)
- **Backend:** Node.js + Express (ES modules), SQLite via `better-sqlite3`
- **Frontend:** Vanilla HTML/CSS/JS, no framework/build step
- **PDF contracts:** `pdf-lib` — either a generated text-based PDF or an
  admin-uploaded PDF used as-is, with a signature stamped onto the last page
- **Email:** Brevo transactional API — one platform account, no per-org config
- **Gift cards:** disccardpromos.com — one platform account, no per-org config
- **Spreadsheet import/export:** `xlsx` (reads .csv/.xlsx; full system export
  writes a multi-sheet .xlsx)
- **Auth:** JWT, bcrypt password hashing

## Project structure
```
src/
  index.js               — Express entry, route mounting, static frontend serving,
                            background intervals (task reminders, card sync)
  db.js                  — Full SQLite schema + seed (default org + super admin)
  middleware/
    auth.js               — JWT auth, role guards
    permissions.js         — Field-level + page-level RBAC (see below)
  services/
    mail.js                — Brevo send + branded templates (footer: "Powered by everythingshul.com")
    pdf.js                  — Contract PDF generation/upload + e-signature stamping
    giftcard.js              — disccardpromos.com adapter (MOCK MODE until keys set)
    cardSync.js               — Shared sync logic (single card + sweep-all), used by the
                                 manual "Sync Now"/"Sync All Now" buttons AND the
                                 automatic 15-min background interval
    storeMatch.js              — Resolves a transaction's raw store name to a known store record
    duplicates.js               — Duplicate detection + account pause/unpause
    importer.js                  — CSV/XLSX parsing + template generation
    csv.js                        — Generic CSV writer used by every /export endpoint
    reminders.js                   — Due-date task reminder emails (in-process interval)
  routes/
    auth.js, users.js, orgs.js, seasons.js, settings.js,
    shuls.js, applicants.js, cards.js, stores.js, forms.js, dashboard.js, tasks.js,
    systemExport.js (GET /api/system-export — full multi-sheet .xlsx of everything)
frontend/
  css/theme.css           — Brand tokens (deep espresso brown + antique gold, from the org logo)
  js/app.js                — Auth/api/toast/modal/sidebar/signature-pad/compare-table/
                              quick-task/downloadAuthed helpers, shared by every page
  index.html, apply.html, apply-store.html, login.html, sign-contract.html,
  accept-invite.html, forgot-password.html, reset-password.html,
  form.html (generic public form renderer)
  admin/                  — Internal staff/admin app (dashboard, shuls, applicants, cards,
                             stores, tasks, forms, users, settings)
  shul-portal/            — Shul login: their own applicants, bulk upload, contract status
  store-portal/           — Store login: onboarding wizard, overview, billing
```

## Data model highlights
- **Seasons**: `seasons` table with `default_card_amount`; shuls/applicants/cards
  all carry a `season_id` so re-running a season never requires re-uploading
  existing shuls/applicants — only new ones need to be added.
- **Duplicate detection** (`services/duplicates.js`): on every shul/applicant
  create (form, admin, or mass upload), checked for name+location / phone /
  email collisions. A match creates a `duplicate_flags` row and pauses
  **both** records' accounts (`is_paused=1`) — logins are blocked (HTTP 423)
  and shul/applicant actions are rejected until an admin resolves or bypasses
  the flag. Shuls/Applicants > Duplicates panel can open a **full side-by-side
  comparison** (`renderCompareTable()` in `app.js`) before deciding.
- **One disccardpromos account per person** (`services/duplicates.js`
  `findProviderAccountConflict` / `flagProviderAccountConflict` / `sweepProviderAccountConflicts`):
  the same person legitimately spans several applicant rows (merge group, season carry-forward,
  same `external_id`) and shares one account by design; two *different* people must never.
  disccardpromos can return an existing customer at approval, so every auto-link in
  `services/providerAccount.js` (`ensureProviderAccount`, which the enforce job also uses, and the
  audit's relink-by-external-id) checks first: on a conflict nothing is linked, both applicants
  are paused, and a normal Duplicates flag "Same disccardpromos account (#id)" is opened
  (surfaced as `providerAccountError` on approve). **Recheck All** also sweeps existing bad data
  (manual only — deliberately not run at boot, since it pauses applicants and deactivates cards);
  a pair the admin bypassed for that exact account is not re-flagged.
- **Field-level RBAC** (`middleware/permissions.js`): each internal user gets a
  `permissions` row per resource (`shuls`, `applicants`, `cards`, `stores`,
  `forms`, `users`, `settings`, `dashboard`) with `can_view`/`can_edit`/
  `can_export`, a `scope` (`all` vs `assigned`-only), and a `hidden_fields`
  JSON array — e.g. a user can see applicants with `first_name`/`last_name`
  hidden. Enforced server-side via `redact()`, including on export endpoints.
  Admin > Users & Permissions is the UI.
- **Configurable required fields**: `form_field_settings` + Settings >
  Required Fields lets the admin toggle which shul/applicant fields are
  required, admin-only overridable, or visible at all.
- **Audit trail**: `audit_log` records create/update/approve/esign/etc with
  before/after JSON; nothing is ever hard-deleted (deactivate/reject flags only).
- **Tasks / to-do list**: internal-team only (staff/org_admin/super_admin).
  Assign to any user, due date + priority, optional link to a shul/applicant/
  store (`entity_type`/`entity_id` — "+ Add Task" from those detail views).
  Automatic email reminders (`services/reminders.js`, 30-min interval) for
  anything due today/tomorrow/overdue, throttled to one per task per 20h.

## Gift cards — disccardpromos.com (single platform account)
`src/services/giftcard.js` is the only file that talks to disccardpromos.com.
Set `DISCCARDPROMOS_API_BASE` / `DISCCARDPROMOS_API_KEY` to go live; until
both are set it runs in **MOCK MODE** (simulated card ids, activation, empty
transaction feed) so the rest of the product is fully usable today. The admin
Cards page shows a banner whenever mock mode is active.

**Sync is automatic**, not just manual: `services/cardSync.js` sweeps every
assigned/activated card every 15 minutes in the background (`index.js`),
pulling new transactions and resolving each one's store name to a known
store record (`storeMatch.js`) so per-store spend stays live without anyone
clicking in. A "Sync All Now" button on Admin > Cards triggers an immediate
sweep; "Sync Now" on the card detail modal does one card. `assignCard()` also
pushes the applicant's internal ID as `external_ref` when a card is created —
disccardpromos only ever learns the card/applicant *reference*, not personal
details; **this app remains the system of record for all applicant data**.

**Unattributed spend.** Card sync only reads customers linked to an applicant, so charges by
disccardpromos customers that *aren't* linked (and charges on a card we couldn't match) used to
be dropped, leaving Total Spent below disccardpromos' own figure. `syncUnlinkedCustomers()`
(run by every `syncAllCards`, from the bulk customer indexes it already pulls) stores them in
`unattributed_transactions` (customer id/name, vendor resolved to a store, same negative-purchase
/ positive-refund convention). A customer is skipped only if the per-applicant sync actually
processed it this sweep (it finds customers by `external_id`, so "some applicant holds this
account id" isn't enough), and a charge already in `card_transactions` is never also recorded
here — every charge is counted in exactly one table.

**Total Spent = disccardpromos' own figure (balance snapshot).** A running tally of the charges their feed lists can
never be trusted to equal their total: the feed is sometimes short (Spend Audit `feedGap`), voided/removed charges
stay in our table, and ledger tallies drift. So org-wide (no season filter, the default) `totalSpend()` returns the
**snapshot**: each sweep, from the bulk customer pull it already makes (`balances=true`), `recordSpendSnapshot()`
(`cardSync.js`) sums per customer `max(0, amount − Σ packages[].balance)` and stores one row in
`provider_spend_total`. It is replaced whole and ONLY by a pull that passes every check — all seasons' pulls
succeeded, `listAllCustomers` collected every customer disccardpromos reported (`reportedTotal`), ≤5% of customers
lack a readable amount/balance, and (if no total is reported) not <95% of last time's customer count; otherwise
the previous snapshot stands. A snapshot older than 6 h is ignored (ledger fallback). Per-season views always use
the ledger (a customer can span seasons, so balances can't be split by season); the dashboard note shows the
all-seasons provider figure next to a season's ledger figure. Settings > Organization > "Total Spent source"
(`total_spent_source` = `provider` | `ledger`) is the escape hatch. `totalSpend()` always also returns `ledger`,
`difference`, `source`, `asOf`; store/shul breakdowns, Cards > All Transactions and the Spend Audit stay on the
ledger. The sections below describe the ledger (still the detail, and the fallback).
**"Total Spent" has ONE definition**: `totalSpend()` in `services/spendTotals.js` = net
(purchases minus refunds) of *every* card transaction — any applicant, whatever their status now,
no merge adjustments — plus the unattributed charges. The Dashboard Total Spent tile
(`orgFundsSummary`), its Live Store Spend total, and Donor's Dash all read it, so they cannot
disagree, and it matches disccardpromos' own total. (It used to sum only *approved* applicants'
own spend, which silently dropped anyone later rejected/removed and any merge adjustment, so it
never reached disccardpromos' figure. Remaining = Total Loaded − Total Spent, as before.)
**Spend Audit** (Cards > Spend Audit, `GET /cards/spend-audit`, `auditProviderSpend()` in `cardSync.js`;
`?export=1` = Excel): one live pull of every disccardpromos customer (balances + charges) reconciled
against what is stored, per customer — charges disccardpromos lists that are NOT stored here
(`missing`: run Sync All Now), spend implied by its own balances (`amount` − `packages[].balance`)
that is NOT in the charge list it sends (`feedGap`: nothing a sync can ever add), unreadable entries
(no id/amount; also counted as `unlinkedMalformed` by the sweep instead of being dropped silently),
and what we hold that its list no longer returns. Read-only and audited; use it to name any gap
between Total Spent and disccardpromos' own total.
`unattributedByStore` feeds `topStores`, the donor Stores panel and the Stores list/export/
profile/history; Cards > All Transactions lists the unattributed rows (labelled with the
disccardpromos customer) with a Total spent summary and an "Unattributed spend — INCLUDED"
line, and Spent by Shul shows a "Not linked to any applicant" row. Season totals window
unattributed rows by the season's date range (they have no card to carry a season). When such a
customer is later linked, `syncApplicantCards` records the same `provider_txn_id`s as real card
transactions and deletes the unattributed copies (`dropUnattributed`) so nothing is counted twice.

Their docs host (docs.disccardpromos.com) blocked automated fetching from the
build environment, so the exact endpoint paths/payloads in `giftcard.js` are
a best-guess placeholder pending confirmation with their team — once
confirmed, only that file's request/response mapping changes.

## Performance (measured on a 154K-charge / 6.6K-applicant / 250 MB database)
The whole app is ONE Node thread and better-sqlite3 is synchronous, so any long query or loop freezes
every request. Rules that keep pages fast — keep them when touching these areas:
- **The sync sweep (`syncAllCards`, every 60s) must stay cheap and yield.** It used to take ~16s and froze
  the server ~12s per minute (re-resolving, re-serialising and re-inserting every stored charge each
  time). Now: one in-memory set of already-stored provider charge ids (`ctx.knownTxnIds`) skips them
  outright; unchanged cards aren't rewritten; `last_synced_at` is one `UPDATE` per sweep; balances for
  all merge-group anchors are computed once; the loops `await setImmediate` every 25/100 applicants (never
  hold a transaction across a yield); `index.js` skips a tick while a sweep is still running.
  `resolveStoreId` memoises vendor→store for 30s (`clearStoreMatchCache()` on link changes).
- **Whole-table spend aggregates are cached 20s** in `services/aggCache.js` (`memo`/`invalidateAggregates`):
  `attributedNet`, per-applicant spend (`getApplicantBalances` for >200 applicants), the dashboard's
  per-store net, Cards totals and Spent-by-Shul. Every `logAudit()` and every sync drops the cache, so
  approvals, gives, undos, merges and syncs show at once.
- **Covering indexes** `idx_txn_card_cover(card_id,type,amount)` and `idx_txn_store_cover(store_id,card_id,type,amount)`
  answer the spend sums from the index (~10x faster); `idx_txn_occurred` serves the newest-first list.
- **Big lists are paged server-side**: Cards > All Transactions (reads each table newest-first and stops,
  deterministic order) and Shul Transactions > Allocations (`?active=1&pageSize=&page=`, `renderSimplePager()`).
  Never return every allocation/transaction in one response.
- `compression` (gzip, >1 KB) is on for every response; static files: HTML `no-cache`, images 7 days,
  JS/CSS with `?v=` (bump it whenever `app.js` changes) 1 year immutable, otherwise 5 min.
- `synchronous = NORMAL` (WAL): a commit no longer fsyncs the log; the DB can't corrupt, only a power/OS
  failure in the last instant could drop the very latest commit.

## Mass fund return (Settings > Organization > "Return funds on untouched accounts")
Reverses every give (shul money AND org match) on every account that has had **no transaction at all**,
in one run — so $1K from shul A + $1K org match + $1K from shul B goes back as $1K / $1K / $1K.
Logic is `services/fundReturn.js`, routes `routes/fundReturn.js` (`/api/fund-return/*`), job rows in
`fund_return_jobs` (progress, per-shul totals, per-account results; powers the Excel report).
- **Permission `fund_return`** (Users & Permissions): super_admin always; everyone else needs an explicit
  grant (`RESOURCE_DEFAULT_OVERRIDES`). Every route needs `can_edit`; the Settings card is hidden without it.
- **Random code gate**: `/preview` issues a one-time 6-char letters+digits code (15 min, per user + season);
  `/start` refuses unless it is typed back exactly. The button stays disabled until the code matches.
- **"Untouched" is checked twice**: locally (no stored or unattributed charge for that person) and live
  against disccardpromos per account right before reversing (any spend / balance below what was loaded →
  skipped whole, never partially returned). Each give is reversed through the normal `reverseAllocation()`
  (audited, shul balance restored, card amount lowered). Approval-time `card_amount` is not reversed.
- One run at a time; Cancel stops before the next account (already-returned stays returned); a server
  restart marks a running job `interrupted` at boot. Re-running is safe — reversed gives are skipped.

### Second button: "Return What's Left on Single-Shul, Matched Accounts" (`mode: 'partial'`)
Same permission (`fund_return`), same typed-code gate (a separate code per button — one button's code never
confirms the other), same job table (`fund_return_jobs.mode`), runner, progress popup and Excel report.
For accounts that may already have **spent** something. Eligible only when ALL standing gives of the account
(`findPartialCandidates`): come from ONE shul and one season; total match == total shul money to the cent
(1:1); total received (shul + match) ≤ **2 × the applicant's match cap** (`resolveApplicantCap`: applicant
override else season `match_cap_per_applicant`; **no cap set = skipped**). The preview names how many accounts
were left out and why.
- **Amount**: at run time the LIVE disccardpromos balance is read (`computeRetrievable`; local ledger only if
  the account was never on the card). `spent = loaded − live`; `left = min(gives − spent, live)` — what was
  spent comes off the shul/match gives (so the approval-time `card_amount` is never returned); `left` is split
  in half in cents, **an odd cent goes to the shul**. $500 + $500 match, $100 spent → $450 shul / $450 org.
- **Ledger**: each give is closed through `reverseAllocation()` with an explicit `shulAmount`/`orgWriteoffAmount`
  split that sums to `left` (oldest give first; a give with nothing left is still closed for $0 so it can't be
  returned twice) and a `reversalNoteOverride` stating the real split. The spent part stays counted as used by
  the shul and the match cap. Nothing left on the card → skipped, nothing touched. Idempotent.
- Preview figures are an estimate from the local spend ledger; the run uses the live balance.

## Applicant profile "DiscCard" button
`openApplicant()` footer (after View Other Seasons), only when `provider_account_id` is set: opens
`https://disccardpromos.com/portal/org/customers/<id>/` in a new tab (id with any trailing `.0` stripped).
Frontend only, nothing sent to our server.

## Email — Brevo (single platform account)
`src/services/mail.js` sends via the Brevo transactional API
(`https://api.brevo.com/v3/smtp/email`), using `BREVO_API_KEY` /
`EMAIL_DEFAULT_SENDER` / `EMAIL_DEFAULT_SENDER_NAME`. No API key → dry-run
mode (logged to console, not sent) — fully testable without credentials.
Every email template footer reads "Powered by everythingshul.com" linking to
the site, matching the site's own footer treatment.

**Every `sendMail()` call site is awaited and wrapped in try/catch** — a
failure is logged server-side (`[mail] ... failed: <reason>`) and returned to
the frontend as `emailError` in the response, surfaced as a toast, instead of
failing silently. **Most common real-world cause of send failures**: Brevo
requires the sender identity (`EMAIL_DEFAULT_SENDER`) to be a verified sender
or domain in your Brevo account (Senders & IP) — an unverified sender fails
every send with an auth/sender error, which will now show up as that toast.

A live Brevo API key has been provided by the user for `BREVO_API_KEY` — it
must be set as an environment variable on the deploy platform (Render), never
committed to the repo. This sandbox's network policy blocks outbound requests
to `api.brevo.com`, so it could not be live-verified from here.

## Email Center (`/admin/emails.html`)
`sendMailChecked()` (`services/mail.js`) is the single choke point every
email in the app passes through (system-automatic and admin-composed alike),
so it's also where every send gets logged to the `emails_sent` table
(status `sent`/`failed`/`dry_run`, error message, optional
`related_entity_type`/`related_entity_id`/`sent_by`) — that's what backs the
Email Center's "Sent Emails" tab (`GET/GET :id/GET export /api/emails*`,
`requireAdmin`-gated like Tasks). The "Templates" tab is plain CRUD
(`email_templates` table, `{{variable}}` placeholders) via
`/api/emails/templates*`, and "Compose Email" (`POST /api/emails/send`)
substitutes `{{variable}}` from a `variables` object at send time — the
admin-composed "Email Builder" the user asked for, distinct from the
system's automatic emails.

## SMS Center (`/admin/sms.html`)
Same shape as Email Center but for SMS, and provider-agnostic since no
provider has been picked yet. `sendSmsChecked()` (`services/sms.js`) is the
single choke point every outbound SMS passes through, logging every attempt
to the `sms_messages` table (`direction` outbound/inbound, `status`
sent/failed/mock/received, error message, optional
`related_entity_type`/`related_entity_id`/`sent_by`).

`isSmsMockMode()` returns true whenever `SMS_API_BASE` or `SMS_API_KEY` is
unset — in mock mode every send is logged with `status: 'mock'` and a
console line instead of making a real HTTP call, mirroring the
Brevo-dry-run and disccardpromos-mock patterns elsewhere in the app. The
provider is SimpleSender (Developer > Docs & Keys in its dashboard for the
base URL + key): set `SMS_API_BASE` and `SMS_API_KEY` as Render environment
variables (never committed) and `sendSmsChecked()` POSTs `{ to, message }`
(digits-only `to`, no `from` — the account has one dedicated number) to
`${SMS_API_BASE}/v1/messages/send` with a Bearer token, treating a
`queued`/`sent` response status as success.

The "Templates" tab is plain CRUD (`sms_templates` table, `{{variable}}`
placeholders) via `/api/sms/templates*`. "Send Message"
(`POST /api/sms/send`) accepts either `to` (single phone number, with
`{{variable}}` substitution from a `variables` object) or `group` — one of
`shuls`/`stores`/`applicants`/`staff`, broadcasting the same message
unsubstituted to every phone number on file for that group. There's no
separate phonebook: group recipients are resolved from each entity's
existing phone fields (shuls' `gabai_cell`; stores'
`COALESCE(manager_phone, owner_phone)`; applicants'
`COALESCE(husband_cell, wife_cell, home_phone)`; staff's `users.phone`,
which previously existed as a dead column and is now wired into the
Users & Permissions invite/edit UI). Entities with no phone on file are
silently skipped.

"Inbox" reads inbound messages, logged via the public (unauthenticated)
`POST /api/sms/webhook/inbound` — point the provider's inbound-message
webhook there once one is configured. It accepts a few common field-name
variants (`from`/`From`/`sender`/`msisdn`, `body`/`Body`/`text`/`message`)
since the real provider's payload shape isn't known yet, and always
responds `200` so providers don't retry.

## Updates (`/admin/updates.html`, formerly the shul portal's "Contract" page)
Admin-broadcast announcements to specific shuls/stores or whole groups
(`all_shuls` / `all_stores`), with optional image/PDF attachments. Every
recipient gets both an email (`sendMailChecked`) and a portal notification —
`update_recipients` rows track per-recipient email status and `read_at`.
`POST /api/updates` accepts multipart form data (`title`, `body`,
`recipients` as a JSON string `{recipients:[{entity_type,entity_id}],
groups:[...]}`, and `files[]`); attachments are written to
`DATA_DIR/updates/` and statically served from `/uploads/updates/` (same
pattern as `/uploads/contracts` and `/uploads/logos` — no auth on the file
itself, only on the admin API that created it).

The shul portal's nav item that used to be "Contract" (a narrow
contract-status viewer at `shul-portal/contract.html`) is now "Updates"
(`shul-portal/updates.html`) — it still shows the contract-status card at
the top, with the Updates inbox below it. The store portal gets a matching
`store-portal/updates.html` with just the inbox (stores never had a
contract). Both portal pages call the shared `loadUpdatesInbox(containerId)`
helper in `app.js`, which hits `GET /api/updates/inbox/mine` and
`POST /api/updates/inbox/:recipientId/read`. The header nav shows an unread
count badge next to "Updates" for shul/store roles (`GET
/api/updates/inbox/unread-count`), computed on every `renderShell()` call.

## Downloads / exports — always use `downloadAuthed()`
This app has no cookie session, only a Bearer token in `localStorage`. A
plain `location.href = '/api/...'` navigation sends **no** Authorization
header and 401s silently — this was a real bug (found while adding exports;
"Download Import Template" had been broken since it was written). Every file
download in the frontend must go through `downloadAuthed(path, filename)` in
`app.js` (fetch with auth header → blob → save), never a raw `location.href`
or anchor `href` pointing at `/api/...`.

Every list page (Shuls, Applicants, Cards + Transactions, Stores, Tasks) has
an "Export CSV" button hitting `GET /api/<resource>/export` — full detail, no
pagination, respects current filters, gated behind `can_export` + field
redaction like everything else. `GET /api/system-export` (Settings >
Organization) downloads one Excel workbook with every table as its own sheet
— shuls, notes, contracts, applicants, notes, cards, transactions, stores,
billing, tasks, users, seasons, duplicate flags, audit log.

## Contract PDFs
Settings > Contract Template supports two modes:
1. **Uploaded PDF** (`POST/DELETE /api/settings/contract-pdf`, stored at
   `DATA_DIR/contracts/org-template.pdf`) — used verbatim as every shul's
   contract body.
2. **Generated text template** (fallback when no PDF is uploaded) — a simple
   in-process PDF built from the shul/season details + admin-editable clause
   text.

Either way, `stampSignature()` in `pdf.js` adds the signature (drawn PNG or
typed name) + signer/date/IP to the **last page**, inside an admin-configured
box (see below) — falling back to a hardcoded "~16% up from the bottom-left"
placement if the box was never configured, so existing orgs see no change
until they opt in.

### Signature placement editor
Settings > Documents has an "Edit Signature Placement" button per document
kind (shul/applicant/store) opening a drag/resize box editor
(`openSignatureBoxEditor()` in app.js). It renders a page-proportioned mockup
(NOT the live PDF content — deliberately, since overlaying on a native
multi-page PDF `<iframe>` is unreliable across browsers/zoom levels; the
mockup's aspect ratio always matches the real page via
`GET /api/settings/signature-box/:kind`'s `pageSize`, read from the actual
template PDF with pdf-lib, or 612x792 for the generated default). The box is
stored as `{x, y, width, height}` fractions (0-1) of the page, top-left
origin, in `settings` under key `signature_box_<kind>` —
`GET/PUT /api/settings/signature-box/:kind`. `stampSignature()` converts to
PDF points/bottom-left origin and lays out the line/image-or-typed-name/meta
text proportionally within that box.

## Generic documents (applicants + stores)
Same idea as the shul contract above, generalized to any applicant or store
via a parallel `documents` table/route (`src/routes/documents.js`) — the
shul `contracts` table/flow was left untouched to avoid regressions.

- **Settings > Documents** has three sections: Shul Contract (existing),
  Applicant Agreement, Store Agreement. Each independently supports an
  uploaded PDF (`POST/DELETE /api/settings/document-pdf/:entityType`,
  `entityType` is `applicant` or `store`, stored at
  `DATA_DIR/contracts/org-template-<entityType>.pdf`) or generated template
  text (`document_template_text_applicant` / `document_template_text_store`
  keys via the generic `PUT /api/settings`).
- Admin flow, from the applicant/store detail modal's **Documents** tab:
  `POST /api/documents/generate` (builds the unsigned PDF + a `pending` row)
  → `POST /api/documents/:id/send` (emails a signing link; `email` in the
  body overrides the default so a specific document can go to a specific
  person, not just the record's own email on file — the "Send To" field on
  each row) → the recipient always gets an emailed link
  (`sign-document.html?token=...`) regardless of who they are.
- Public signing: `GET /api/documents/sign/:token`,
  `GET /api/documents/sign/:token/pdf-preview`,
  `POST /api/documents/sign/:token/sign` — mirrors the shul
  `contract/:token*` endpoints, stamped via the same `stampSignature()`.
- `GET /api/documents/:id/pdf` (admin) serves the signed PDF once available,
  else the unsigned one.

## Store onboarding
Mirrors the shul flow: `apply-store.html` is a public application form
(`POST /api/stores/apply`, no auth) creating a `pending` store with
`source='application'` (vs `'admin'` for admin-added ones). An admin invites
either kind to the portal (`POST /stores/:id/invite`). A store with
incomplete onboarding (`onboarding_step < 3`) is routed to
`store-portal/onboarding.html` on first login — a 3-step wizard (confirm
info → owner/billing contact + agree to terms → done) that flips
`setup_status` from `pending` to `in_progress` (final `active` is an admin
call). Admin > Stores shows source, onboarding progress, and **live spend**
(purchases/refunds/transaction count, computed fresh from synced
transactions on every request — not cached). Dashboard has a "Live Store
Spend" panel with total spend + top-5 breakdown.

## Store Billing (`/admin/store-billing`, `routes/storeBilling.js`)
Stores bill the fund back (not the other way round). Admin issues a **billing period**
("please submit your invoice" email to chosen stores); a store may submit one invoice per
period it was invited to (store portal Billing tab, email-code verified); admin reviews it.
- **Approve for payment**: a pending invoice can be ticked "approved" with an editable
  amount (`approved_for_payment`/`approved_amount`/`approved_by`/`approved_at`); only pending
  invoices can be (un)approved. Mark Payment Sent prefills the approved amount, else the net
  payable. The page's four tiles come from `GET /invoices/summary` (registered before
  `/invoices/:id`): Paid, Outstanding (approved invoices count at their approved amount, others
  at net payable), Approved Awaiting Payment, Pending Review. The list has search + sortable
  headers, and the store name links to `/admin/stores?id=`.
- **Processing fee**: setting `store_billing_fee_percent` (Settings > Store Billing) is deducted
  at read time (`withPayable()`: `fee_amount`, `payable_amount`), so changing it re-prices every
  unpaid invoice. Per invoice it can be waived (`POST /invoices/:id/fee-waiver`, who/when
  recorded; an approval that equalled the old payable follows the change). The invoice popup's
  `renderInvoiceCalculator()` in `app.js` shows invoice / fee / total to pay.
- **Bank list**: the store portal's bank picker comes from `GET /store-billing/banks` — the
  admin's list (`store_billing_banks`, Settings > Store Billing > Bank List) or the bundled
  `frontend/js/usbanks.js`; "Other / Not Listed" is always forced last.
- **Download Store Bank Details (Excel)**: `GET /store-billing/stores/payment-info/export`,
  super_admin/org_admin only (like the per-store Reveal), audited as `export_payment_info`.
- Internal columns (`admin_notes`, approval and fee-override fields) are stripped from the
  store-facing `GET /my/invoices`.
- **Mark Payment Sent** (`openStoreCompletePayment(id)`): amount, date, **billing period dates** (a
  per-invoice correction in `bill_period_start/_end`, read everywhere as `COALESCE(b.bill_period_*,
  bp.*)`; the shared `billing_periods` row is never touched; `period` text is rewritten), an
  "email the store" checkbox, a **template picker**, and a rich-text message that already contains
  the real figures (`POST /invoices/:id/payment-email-preview`; auto-refreshes on amount/date/period
  unless the admin edited it, then a hint offers Reload). `POST /complete` takes
  `period_start/period_end`, `email_subject/email_body`, `send_email` and returns
  `email: {sent,to,error,skipped}`; no bank on file no longer blocks it. **Delete Payment**
  (`DELETE /invoices/:id/payment`, super_admin/org_admin, audited) returns a completed invoice to
  Pending and clears payment fields (approval, fee override, attachment, corrected period stay).
- **Payment emails** are rich-text templates (`payment_email_templates`, partial unique index = one
  default per org; Store Billing > Payment Emails tab). Fields: breakdown, storeName, amount,
  invoiceAmount, feePercent, feeAmount, period, paymentDate, bankName, last4, sentTo. The
  **breakdown** table (`buildBreakdown`) shows invoice − fee = total and says "Not deducted" /
  "Processing fee / adjustments" when the amount sent isn't invoice − policy fee. The old
  `storeInvoicePaymentSent` auto-email is gone from `SYSTEM_EMAIL_TEMPLATES`; a customized override
  row is only read once, to seed the first template.
- **Rich text, never HTML**: `createRichTextEditor(id, html, { fields })` turns `{{key}}` into
  non-editable pills (`.rte-field`) and adds an Insert-field menu; `renderFieldChips()` renders the
  same pills read-only. Used by Issue Billing Email, payment templates and Settings > Auto Emails.
  `utils/sanitizeEmailHtml.js` cleans saved/sent rich text (templates, system email templates,
  billing-period body, composed payment email).
- **Enter Portal admin bypass**: the impersonation redeem (`POST /auth/impersonate/:token`) signs the
  JWT with `impersonatedBy`; `auth()` sets `req.impersonatedBy` only while that admin is still an
  active internal user. In the store billing routes that skips email verification, required payment
  fields (blank fields keep what is on file), the attachment, the confirmation checkbox, the
  invited-to-period and one-invoice-per-period rules (any period or none; amount still required);
  `/my/status` returns every period with an `invited` flag and `impersonating`. A store's own login
  is unchanged. `closeModal()` now closes the topmost stacked modal (`closeAllModals()` closes all).

## Address autocomplete (Google Places)
`attachPlacesAutocomplete(inputId, fields)` in app.js is a from-scratch
fetch-and-render dropdown built on the new Places API's
`google.maps.places.AutocompleteSuggestion.fetchAutocompleteSuggestions()` +
`PlacePrediction.toPlace().fetchFields()` — deliberately *not* Google's
`PlaceAutocompleteElement` custom element or the legacy
`google.maps.places.Autocomplete` widget. Two reasons:
1. The legacy widget needs the legacy **"Places API"** enabled in Google
   Cloud Console in addition to "Places API (New)" — a separate toggle
   that's easy to miss, and the actual cause the one time this broke in
   production (`LegacyApiNotActivatedMapError` in the console).
2. `PlaceAutocompleteElement` replaces the `<input>` with a custom element,
   which would need form-association handling to keep working with the
   plain `new FormData(form)` collection this app uses everywhere. Building
   the dropdown by hand keeps every existing `<input>` a normal form field.

Implementation notes: the input gets dynamically wrapped in its own
`position: relative` div at attach-time (existing markup doesn't
consistently wrap inputs, so anchoring the dropdown to some ancestor like
the whole `<form>` would misplace it) · debounced 250ms · a monotonic
request-id guards against a slow earlier keystroke's response overwriting a
newer one · a session token is created per typing session and rotated after
each completed selection, per Google's billing-optimization guidance.
Verified against the real API surface by fetching and grepping the actual
`maps/api/js` bundle server-side (`curl`) since this sandbox's Chromium
can't complete a live connection to `maps.googleapis.com` (`curl` can) — so
if Google changes this API's shape again, that's the fastest way to check
before guessing from docs.

## Required external setup to go fully live
1. **Brevo** — `BREVO_API_KEY` (provided by the user, needs to be set in the
   deploy environment) + a verified sender identity in the Brevo dashboard.
2. **Google Maps** — `GOOGLE_MAPS_API_KEY` (restrict to your domain; **"Places
   API (New)"** must be enabled — not the legacy "Places API"; billing must
   be active on the project or every request fails). Without a working key,
   address autofill is skipped — forms remain fully usable with manual
   entry, and `loadGoogleMaps()`/`attachPlacesAutocomplete()` in app.js log
   a `[places]` console warning/error explaining exactly why (missing key,
   script load failure, Google auth rejection) — check the browser console
   first if autocomplete "isn't working".
3. **disccardpromos.com** — `DISCCARDPROMOS_API_BASE` / `DISCCARDPROMOS_API_KEY`.
4. **DNS** — point `ecards.everythingshul.com` at the Render service.
5. Change the seeded super admin password immediately (`SEED_ADMIN_EMAIL` /
   `SEED_ADMIN_PASSWORD` env vars control the seed).

## Key architecture decisions
- **SQLite on persistent disk** — `render.yaml` mounts `/data`; schema is
  create-if-not-exists / guarded `ALTER TABLE`, never destructive.
- **ES modules** everywhere, matching the sibling Mamudem product.
- **No build step** — plain HTML files under `frontend/`, one shared
  `js/app.js`.
- **Single organization, single set of credentials for every integration** —
  this was tried both ways (per-org Brevo/disccardpromos, then reverted to
  platform-wide) and platform-wide is the current, intentional, final state.
  Don't reintroduce per-org credential tables without checking first.
- **Permissions are enforced server-side**, not just hidden in the UI — every
  protected route runs through `requirePermission()` and `redact()`, exports included.
- **Every `<script>` block on a page is a single parse unit** — one syntax
  error anywhere in it (e.g. a mis-escaped quote) silently blanks the entire
  page, since nothing in that block runs, not even `renderShell()`. This bit
  us twice (Applicants, Cards pages). Run the frontend syntax audit below
  after editing any `<script>` block before considering the change done.
- **Layout is a horizontal header, not a sidebar.** `renderShell()` in
  `app.js` renders one `<header class="app-header">` (brand, a
  horizontally-scrollable nav strip, user email + sign out) followed by
  `.content` — there is no `.sidebar`/`.main` split anymore (that was tried
  first and replaced once the nav grew past ~10 items). On narrow screens
  the nav collapses behind a hamburger (`#header-menu-btn` toggles `.open`
  on `#header-nav`). `NAV_ITEMS`/`SHUL_NAV`/`STORE_NAV` are still the single
  source of truth for what shows up, per role.

## Brand assets & two-palette theming
Real logo files are checked in at `frontend/img/`: `org-logo.png` (the
organization's shield logo — espresso/gold, used verbatim; `org-logo-full.png`
is the original high-res source) and `everythingshul-logo.png` (the
everythingshul wordmark — navy/cyan). Favicons (`favicon-32.png`,
`favicon-192.png`, `apple-touch-icon.png`) were generated from the shield.

The site intentionally runs **two color palettes** sharing one set of CSS
variables (`theme.css`):
- **Public marketing pages** (homepage, apply/apply-store, sign-*, login,
  form) use the default espresso-brown/antique-gold palette in `theme.css`,
  sampled from the org shield logo.
- **The logged-in portal** (`admin/*`, `shul-portal/*`, `store-portal/*`)
  additionally loads `css/portal-theme.css` after `theme.css`, which
  redefines the same variable names (`--brand-bg`, `--brand-gold*`,
  `--sidebar-*`, etc.) with navy/cyan values sampled from the everythingshul
  wordmark. Every shared component (buttons, sidebar, tabs, tables) is
  written against those variables, so the override is a drop-in recolor —
  no component CSS is duplicated. If you add a new hardcoded color anywhere
  in `theme.css`, it silently won't theme in the portal; add it as a
  variable instead (see `--sidebar-link`/`--sidebar-active-1/2` for the
  pattern this bit us with once already).

`renderPublicFooter()` (app.js) and the email footer (`mail.js`) both use
`<img src=".../img/everythingshul-logo.png">` for the "Powered by" mark —
the email version needs `APP_URL` set to build an absolute URL, and falls
back to plain text if it isn't.

## Not yet built / explicitly out of scope this pass
- Real disccardpromos.com endpoint confirmation (mock mode — see above).
- Logo file upload UI (organizations.logo_url exists; no upload endpoint —
  the org/everythingshul logos are checked into `frontend/img/` as static
  files instead, since this is a single-org platform).
- A dedicated audit-log viewer UI (data is fully captured in `audit_log`, just
  no page renders it yet).
- CSV template for "XCLS" specifically — `xlsx` reads both `.xlsx` and `.csv`;
  treated as a likely typo for XLS/XLSX.

## Deployment
1. `npm install`
2. Set env vars from `render.yaml` (BREVO_API_KEY, JWT_SECRET, APP_URL,
   DISCCARDPROMOS_API_BASE/KEY, GOOGLE_MAPS_API_KEY, etc.)
3. `npm start` (or `render.yaml` on Render — same pattern as the Mamudem service)

**Node version**: Render's `NODE_VERSION` env var (dashboard > Environment, mirrored in `render.yaml`) must be a
patched release — 22.23.4 or later (Render's Oct 2026 advisory: eMudhra CA compromise, TLS hostname-check and
Brotli flaws; patched lines are 22.23.4 / 24.22.1 / 26.12.1). It was 20.11.0 (no patched 20.x was listed).
`package.json` `engines` is `22.x`. Changing it only takes effect on the next deploy.
After changing the Node version, Render's restored build cache keeps the OLD `node_modules`; `npm install` says
"up to date" and never recompiles `better-sqlite3`, so the server dies with `NODE_MODULE_VERSION 115 ... requires 127`.
Fix (in the repo, independent of the dashboard's Build Command and cache): `package.json` has a `postinstall` that
tries to open a `better-sqlite3` in-memory DB and runs `npm rebuild better-sqlite3` only if that fails (a stale
binary built for another Node). Root `postinstall` runs even when `npm install` reports "up to date". "Clear build
cache & deploy" and `npm ci` also work.

## Sanity checks worth re-running after any frontend/backend edit
```bash
# Backend syntax
for f in $(find src -name '*.js'); do node --check "$f" || echo "SYNTAX ERROR in $f"; done

# Every inline <script> block on every page actually parses (catches the
# "whole page goes blank" bug class — see above)
for f in $(find frontend -name '*.html'); do
  python3 -c "
import re
content = open('$f').read()
for i, s in enumerate(re.findall(r'<script(?:\s+src=[^>]*)?>(.*?)</script>', content, re.S)):
    if s.strip(): open(f'/tmp/audit_{i}.js','w').write(s)
"
  for jsf in /tmp/audit_*.js; do [ -f "$jsf" ] && node --check "$jsf"; rm -f "$jsf"; done
done
```
