# MEMORY.md — AUCP project handover

> Read this first, then inspect the files named below. Keep it current (rules at the bottom).
> **Never put secrets here.** Credentials live only in the git-ignored `.env`.
> Last updated: 2026-10-20 (all facts below were verified on that date unless marked UNVERIFIED).

## 1. What this is
**Ananta Universal Commercial Portal (AUCP / "UCP")** — internal web app that automates the commercial
(export-documentation) workflow of Ananta Garments Ltd (AGL) selling to H&M. One export order flows through:

```
H&M Order Package email + 3 PDFs
  → 1 Sales Contract → 2 Week-wise Shipment Schedule → 3 Customs Invoice → 4 PDF Rename (FCR / Bill of Export)
                              └→ 5 Booking Correction (Damco)
  6 H&M Portal · 7 Bangladesh Bank EXP portal · 8 Damco portal · 9 Common requirements (RBAC, audit, rules)
```
Shared keys across modules: OrderNo (e.g. `644637-8756`), Contract Ref `AGL/H&M/<NN>/<YYYY>`, Invoice Number, market code.
Fuller explanation: `docs/source-analysis/CROSS_MODULE_WORKFLOW_MAP.md`, `docs/FINAL_REPORT.md`.

## 2. Stack & architecture
- Next.js 14.2.33 (App Router) + TypeScript modular monolith · React 18 · Tailwind · Zod · Prisma 5.22 + **SQLite (dev)**
  (Postgres-portable) · bcryptjs + JWT (jose) sessions · exceljs (.xlsx export) · pdf-parse · Vitest 2.1.5.
- Layering: pure extraction/parse → normalize → deterministic validate → reconcile → **intake services (only code that writes DB)**
  → **adapters (only code that touches external systems)**. Server actions always check permissions server-side.
- Integrations: adapter interface with modes `mock` (default) | `dryrun` | `live`. **`live` fails closed.** Nothing external is ever contacted by default.
- Append-only tables: `SalesContractRow`, `JobStageEvent`, `AuditEvent`.
- ADR: `docs/architecture/architecture-decisions/ADR-0001-stack.md`. Project rules: `CLAUDE.md` (read it).

## 3. Paths & layout (project root = this folder)
- Absolute path: `D:\UCP — REQUIRED DATA & FILES\AUCP` (git repo root is **this** folder).
- Parent folder `D:\UCP — REQUIRED DATA & FILES\` holds the read-only **source evidence** (folders `1.`–`9.` + checklist .docx).
  **Never modify or commit those.** The checklist .docx contains plaintext portal passwords → must be rotated (user informed).
- `src/app/(portal)/**` UI pages · `src/app/actions/**` server actions · `src/app/api/**` (healthz, readyz, export/*, booking/*)
- `src/server/<module>/**` domain code: `sales-contract`, `shipment-schedule`, `customs-invoice`, `pdf-rename`,
  `booking-correction`, `handoffs`, `export`, `integrations` (`ucp-adapter.ts`, `damco-adapter.ts`, `damco-portal.ts`), `modules/catalog.ts`
- `src/lib/**` env (zod-validated), db, auth, permissions (RBAC), audit, csv · `src/components/**` forms/UI
- `prisma/schema.prisma`, `prisma/migrations/**`, `prisma/seed.ts`, `prisma/dev.db` (git-ignored)
- `tests/**` Vitest · `docs/**` analysis + architecture + `runbooks/OPERATIONS.md` · `var/` runtime storage (git-ignored)

## 4. Commands (Windows; run from this folder)
**Use PowerShell. Git Bash crashed with a Cygwin `add_item` fatal error in this environment (2026-10-19).**
The path contains spaces + an em-dash, so npm `.bin` shims break; package.json scripts call `node <entrypoint>` directly.
```
npm install
Copy-Item .env.example .env        # then set AUTH_SECRET (32+ chars) and BOOTSTRAP_ADMIN_PASSWORD
npm run db:migrate                 # apply migrations (SQLite)
npm run db:seed                    # roles, permissions, modules, admin user, reference data
npm run dev                        # or: node node_modules/next/dist/bin/next dev -p 3300
npm run test                       # vitest run
npm run typecheck                  # tsc --noEmit
npm run build                      # next build
```
- Dev URL used in testing: `http://localhost:3300` (launch config `.claude/launch.json` name `aucp-dev`). Health: `/api/healthz`, `/api/readyz`.
- Admin login email: `admin@ananta.com.bd`; password = `BOOTSTRAP_ADMIN_PASSWORD` in local `.env` (not recorded here).
- Dev server: servers started as agent background tasks kept ending on their own, so it was started in a Terminal panel tab titled "AUCP dev server"
  (tab c1, `next dev -p 3300`, readyz 200, CSS 200) — it stays up until that tab is closed / Ctrl-C. If it is down, start it with the PowerShell command above;
  check `Get-NetTCPConnection -LocalPort 3300` first.

## 5. Config (`.env.example` is the reference; `.env` is git-ignored)
`DATABASE_URL`, `AUTH_SECRET`, `SESSION_TTL_HOURS`, `BOOTSTRAP_ADMIN_*`, `STORAGE_ROOT`, `INTEGRATION_MODE=mock`, `AUTO_SUBMIT=false`,
`OCR_ENABLED=false`, `RENAME_INPUT_DIR` (blank = apply disabled), portal URLs, and (new, uncommitted) `DAMCO_USERNAME/PASSWORD`,
`DAMCO_LIVE_ENABLED=false`, `DAMCO_DEFAULT_COMPANY/BUYER`, `BOOKING_MAX_FILES=25`, `BOOKING_MAX_FILE_MB=20`,
`BOOKING_CONCURRENCY=4`, `BOOKING_GROSS_WEIGHT_TOLERANCE_KG=0.5`.

## 6. Database
- SQLite `prisma/dev.db`; **8 migrations, DB schema up to date** (`prisma migrate status`, verified 2026-10-19). Latest:
  `20261019071632_add_booking_batch` (uncommitted). Earlier: init, add_rename_item, add_shipment_schedule_line,
  add_customs_invoice, add_booking_correction, add_crossmodule_links, add_rename_applied.
- Models: User, Role, Permission, RolePermission, Module, SourceDocument, Job, JobStageEvent, PoExtractionRow, SalesContractRow,
  RenameItem, ShipmentScheduleLine, CustomsInvoice, BookingCorrection, BookingBatch, BookingDocument, BookingDocEvent,
  ReviewTicket, AuditEvent, ReferenceData, IntegrationAdapter, **SalesContractBatch, SalesContractBatchItem, ShipmentScheduleLineEdit (new, Oct-2026 addendum)**.
- New migration (uncommitted): `20261019115647_add_sales_batch_and_schedule_edit` (SalesContractBatch/Item + ShipmentScheduleLineEdit + schedule-line editState/editedBy/editedAt fields).
- New permissions (seeded): `schedule.edit`, `schedule.approve` (ADMIN+COMMERCIAL; MERCHANDISER has schedule.edit).
- Dev DB contains test data from manual/live smoke testing (contract 644637-8756, schedule Week 43, invoice 66000 OW, rename job `cmvdgfu8…`).
- Money stored as float in SQLite (→ `NUMERIC(14,2)` when moving to Postgres).

## 7. Module status (verified against code/tests where noted)
| # | Module | Status |
|---|---|---|
| 1 | Sales Contract | Implemented. **NEW (Oct-2026 addendum §3): bulk multi-PDF batch** — upload many PDFs → one row per PO/document, per-file extract (never invents), cross-match existing contracts (reuse, no duplicate), block new-contract creation while numbering/Buyer-Code rules unresolved (AC-03). Plus original single Order-Package intake. Real PO-PDF layout parsing still pending (non-PO PDFs route to NEEDS_REVIEW honestly) |
| 2 | Shipment Schedule | Implemented build + .xlsx export. **NEW (Oct-2026 addendum §4.2): in-portal editing** — role-gated field-level edits, validation, append-only edit history (original→edited, editor, time, reason), Save/Submit/Approve states; source PDF never altered. Pending: PDF upload/update comparison (§4.1), booking-confirmation PDF parsing, port/country lookup |
| 3 | Customs Invoice | Implemented build + .xlsx (INVOICE+SUMMARY+BL DRAFT). Pending: numbering + consignee master data |
| 4 | PDF Rename | Implemented plan + gated on-disk apply (copy, originals kept). Pending: canonical filename rule |
| 5 | Booking Correction | Field-level diff + approval gate (committed). **Batch Damco workflow — see §8 (uncommitted, in progress)** |
| 6–8 | H&M / Bangladesh Bank / Damco portals | **Blocked** — source folders 6–8 are empty; need field lists/screenshots + authorised least-privilege credentials |
| 9 | Common requirements | Partial: RBAC, audit, reference data, idempotency, review queue done; full mapping/calc rules, retention, notifications pending |
| — | Cross-module pipeline | Done: confirm contract → schedule-from-contracts → invoice-from-line (links `scheduledJobId`/`invoicedJobId` prevent double-processing). Handoffs 3 (invoice→PDF rename) and 4 (booking) specified, **not wired** |

## 8. TASK IN PROGRESS — Booking Correction "batch Damco workflow" (uncommitted)
**State found 2026-10-19:** a sizeable feature exists in the working tree but is **not committed or pushed**. The session that wrote this
handover did **not** author it and does not know who/when; it was discovered via `git status`. Treat it as real but unreviewed.

What it does (from `src/server/modules/catalog.ts` diff + code): batch-upload packing-list PDFs (multi-select, type/size/count limits, sha256
de-dup, originals preserved) → layered extraction of Gross Weight / Total Cartons / Total Quantity + PO & country with confidence and
NEEDS_REVIEW → reviewer correction UI (audited, reprocessed) → Damco search (PO + country), non-blind booking selection, 3-value match
(gross weight within tolerance, exact cartons/qty) → CONFIRMED-status validation (heading + status field; REQUESTED/inconsistent never
reported confirmed) → generated booking PDF, per-doc and batch-ZIP downloads, failed-report, retry, audit trail.
Live Damco automation is **fail-closed**: `damco-portal.ts` live mode returns `PORTAL_AUTH_REQUIRED`; no Playwright/live driver is wired.

Uncommitted files (git status):
- Modified: `.env.example`, `prisma/schema.prisma`, `prisma/seed.ts`, `src/app/(portal)/modules/[key]/page.tsx`, `src/lib/env.ts`,
  `src/lib/permissions.ts` (adds `booking.review`, `booking.export`), `src/server/modules/catalog.ts` (booking-correction → "implemented"), `vitest.config.ts` (adds `tests/setup.ts`)
- New: migration `20261019071632_add_booking_batch/`, `src/app/(portal)/booking/[batchId]/page.tsx`, `src/app/api/booking/**` (zip, failed-report, doc original/generated),
  `src/app/actions/booking-batch.ts`, `src/components/{BookingBatchUpload,ExtractionReview}.tsx`,
  `src/server/booking-correction/{batch,batch-types,extract,match,pdf-writer,status,zip}.ts`, `src/server/integrations/damco-portal.ts`,
  `tests/{booking-damco,booking-extract,booking-match,booking-pdf-zip,booking-status}.test.ts`, `tests/setup.ts`

Also added this session (uncommitted): `src/types/pdf-parse-lib.d.ts` — ambient declaration re-exporting `pdf-parse` types for the deep import
`pdf-parse/lib/pdf-parse.js` used in `extract.ts` (fixes the former TS7016 typecheck errors).

### Verification results (2026-10-19, re-run after the fix)
| Check | Result |
|---|---|
| `npm run test` | **PASS — 90/90, 15 files** (was 59/59 before the booking batch work) |
| `npm run typecheck` | **PASS — exit 0** (was failing with 2× TS7016 before `src/types/pdf-parse-lib.d.ts`) |
| `npm run build` | **PASS** — all routes compiled incl. `/booking/[batchId]` and `/api/booking/*` |
| `prisma migrate status` | PASS — 8 migrations, DB up to date |
| `npm run db:seed` | PASS — ran against dev DB (upserts roles/permissions incl. `booking.review/export`, admin bootstrap) |
| `/api/healthz`, `/api/readyz` | PASS (200, db ok) on port 3300 (dev server restarted after build) |
| Extraction on the 7 REAL packing-list PDFs (`..\5. Booking Correction\PACKING LIST\`) | **PASS** — PO/country/market + Gross Weight + Cartons + Quantity now extract correctly on ALL 7 (total-row parser; see findings below); no manual correction needed |
| Full pipeline end-to-end (createBookingBatch → processBatch on all 7 real PDFs) | **PASS** (tsx smoke, 2026-10-19): 2 MATCHED→CONFIRMED→COMPLETED on clean extraction; after inline review-corrections all branches exercised — REQUESTED→PORTAL_AUTH_REQUIRED, gross MISMATCH, no-results SEARCH_FAILED, multiple-candidate resolution by country+values, valid batch ZIP (completed PDFs only) |
| Booking batch UI in browser (admin login → batch dashboard → downloads) | **PASS** — signed in as admin, `/booking/<batchId>` renders full results table + match tables + review editor + integrity messaging; in-page fetch of `/generated`, `/zip`, `/failed-report` → 200 with application/pdf, application/zip, text/csv |
| Live Damco | **AUTO-LOGIN VERIFIED (2026-10-20)** — real visible-browser login against the production portal succeeded; see §8a |

**Real-PDF findings (2026-10-19, UPDATED after carton/qty fix):** PO, country, market code and Gross Weight extract correctly on all 7.
Cartons/Quantity are concatenated on the "Ctns/Col | Qty/Col" total row (e.g. `Total6151`); `parseCtnsQtyTable` now splits them
reliably — Total Cartons = the total-row carton figure (Solid + Asst), Total Quantity = the numeric suffix the total row shares with the
article row. **Verified auto-extraction (no manual correction) on all 7:** 613625=15/263, 614275=6/151, 698757 CN=29/581, PH=8/103,
VN=7/114, 729708=16/312, 729715=1/14. Full-pipeline smoke (2026-10-19): 4 COMPLETED, plus the mock business scenarios
(613625 REQUESTED→PORTAL_AUTH_REQUIRED, 729708 gross MISMATCH, 729715 no-results SEARCH_FAILED). `CARTON_QTY_AMBIGUOUS` now only
fires on layouts the parser cannot resolve. Also: `pdf-parse` calls are serialized + retried once (`parsePdf`) to avoid the old pdf.js
shared-state "bad XRef entry" flakiness under batch concurrency (that is why 614275 previously failed to extract). Tests: 97/97.
**Improvement idea (optional):** positional text via `pagerender` for multi-article tables; current parser targets the single-article total row.

## 8a. LIVE DAMCO automation — visible browser auto-login (2026-10-20, IN PROGRESS)
Authorised by the user (full permission from the authority; high-volume daily processing). Live mode now drives a REAL,
VISIBLE local browser and logs in automatically from server-side env credentials. No mock/fake data on the live path.

**New files (uncommitted):**
- `src/server/integrations/damco-browser.ts` — launches ONE visible local browser (Brave/Chrome/Edge via `DAMCO_BROWSER_PATH`,
  auto-detects Brave) with a persistent profile (`var/damco-session/profile`, git-ignored) + loopback-only DevTools port
  (`DAMCO_CDP_PORT`, default 9333). Playwright attaches over CDP. Window is never hidden, never auto-closed mid-run.
- `src/server/integrations/damco-auth.ts` — `ensureAuthenticated()`: reuses an existing session, else fills the real ADFS login
  form and submits, verifies via an authenticated-page indicator. Detects CAPTCHA/MFA/errors and reports (never bypasses).
  Credentials read ONLY from env; never logged/returned/screenshotted.
- `scripts/damco/{browser,inspect,login-check,search-probe}.ts` — dev tools for launching + read-only DOM discovery.

**Env (in `.env`, git-ignored; added to `.env.example` as blanks):** `DAMCO_USERNAME`, `DAMCO_PASSWORD`, `DAMCO_LIVE_ENABLED=true`,
`DAMCO_BROWSER_PATH`, `DAMCO_CDP_PORT`, `DAMCO_SESSION_DIR`, `DAMCO_NAV_TIMEOUT_MS`. `env.ts` updated (removed headless flag — live is always visible).
Playwright 1.49.1 installed (+ bundled Chromium, unused — its launch hit a Windows side-by-side error, so we drive the installed Brave instead).

**Migration (applied):** `add_damco_live_run` — `BookingBatch.{liveStatus,liveStep,liveDocId,liveMessage,liveStartedAt,liveUpdatedAt}`
and `BookingDocument.{liveStep,searchCriteria,portalValuesJson,portalPdfPath,portalPdfSha256}`. 10 migrations total, DB up to date.

**Real-portal evidence (2026-10-20):**
- Auto-login: `scripts/damco/login-check.ts` → `OUTCOME: AUTHENTICATED`, URL `…/ViewDashboardAction.action`, title "Dashboard".
  Credentials filled from env, form submitted, reached authenticated Dashboard. NO CAPTCHA/MFA observed for this account.
- Portal is ADFS-federated: entry URL → `auth.damco.com/adfs/ls`. Login selectors (verified):
  `#ctl00_ContentPlaceHolder1_UsernameTextBox`, `…PasswordTextBox`, `…SubmitButton`.
- Dashboard (verified): Shipper dropdown `#finalShipperList` (options incl. `ANANTA GARMENTS LIMITED [BDANANTAGAVDR]`,
  `ANANTA SPORTSWEAR LIMITED [BDANANTASPVDR]`), Consignee `#finalConsigneeList`, doc-type `#searchDocumentType`
  (incl. "Booking / Booking Confirmation"). NOTE: the real portal DOES have `SearchAction.action` (the earlier "no SearchAction
  deep-link" note was wrong for the real site).
- Search page `SearchAction.action` (verified): PO `#searchPO_PO_No`, Place-of-delivery `#searchPO_POD`,
  Booked-status `#searchPO_booked_status`, shipper/consignee dropdowns, records `#recordToShow`, Search `#searchPObtn`
  (onclick `validateShipperPO('userType')`), Clear `#cancelbtn`, More filters `#moreBtn`.
- Typecheck of new modules: exit 0.

**BLOCKER (needs user):** running the actual PO search / results-read / PDF-download against the live portal was DENIED by the
Claude Code auto-mode classifier ("Security Weaken") when attempted via `scripts/damco/search-probe.ts`. Auto-login ran; the
follow-on automated search did not. To proceed, the user must either add a PowerShell permission rule (or run outside auto mode),
or run the probe themselves. Until then the results-table + booking-detail + Generate-PDF selectors are NOT yet discovered, so the
live search→compare→PDF path is NOT wired. The mock pipeline remains fully working for tests.

### Next actions (in order)
0. (NEW, 2026-10-20) Unblock the live search probe (permission rule / non-auto run) → run `scripts/damco/search-probe.ts <PO>`
   to capture the results-table headers/rows + the booking-open + Generate-PDF controls. Then build `damco-live.ts` driver
   (select shipper/consignee → PO* + POD* search → read booking values → open booking → download the genuine portal PDF),
   wire it into `batch.ts` live mode behind a single-run queue, add the Start-DAMCO-Processing action + live progress UI,
   then run the mandatory acceptance test (1 booking, then a 10–15 batch incl. mismatch + session-expiry).
1. ✅ DONE (2026-10-19): end-to-end pipeline smoke on the 7 real PDFs + browser login + batch dashboard + authenticated
   downloads all verified (see table above). Only remaining UI gap: driving the drag/drop file picker in-browser (the
   programmatic file-dialog is awkward to automate) — the upload path was instead verified via `createBookingBatch`/`processBatch`.
2. ✅ DONE: docs refreshed — `README.md`, `IMPLEMENTATION_STATUS.md`, `src/server/modules/catalog.ts`, and new
   `docs/modules/booking-correction.md` (full guide: workflow, env vars, modes, permissions, commands, portal limitations).
   Still stale: `docs/FINAL_REPORT.md` (pre-dates this feature).
3. Commit and push (USER HAS NOT ASKED YET — ask first). Stage explicitly (never `.env`, `var/`, `dev.db`):
   `MEMORY.md`, `CLAUDE.md`, `src/types/pdf-parse-lib.d.ts`, `docs/modules/booking-correction.md`, and all files in the lists above.
4. Optional improvement: positional-text extraction (pdf-parse `pagerender`) so "Ctns/Col" and "Qty/Col" totals come out as
   separate columns instead of concatenated — would cut the carton/qty review rate. Then the roadmap in §9.

## 9. Pending / roadmap
- Business decisions blocking real integrations: `docs/source-analysis/BUSINESS_DECISIONS_REQUIRED.md` — key: Q-SC-11/12 (UCP API vs browser; auto-submit vs draft),
  Q-SC-01/02 (unit price / delivery rules), Q-SS-01 (invoice allocation/cut-off), Q-CI-01 (consignee master), Q-PR-01 (rename pattern), Q-PORT-01 (portal scope, field maps, authorisation).
- Wire handoffs 3 (invoice/export → PDF rename) and 4 (booking).
- Real PO-PDF / `.msg` parsing; OCR policy; booking-confirmation PDF parsing for schedules.
- Hardening before production: Postgres + money precision + advisory locks, CSRF tokens, security headers, rate limiting, WORM/retention, least-privilege service accounts.

## 10. Known issues / caveats
- Typecheck/test/build all green as of 2026-10-19 (see §8). No open code errors known.
- Do not run `next build` while the dev server is running — both use `.next`. Stop the dev server first (as done 2026-10-19), then restart.
  **After a `next build`, always delete `.next` before starting `next dev`**: on 2026-10-19 the dev server started on top of the production build
  output and every page lost its CSS (`/_next/static/css/app/layout.css` → 404, unstyled Times New Roman page). Fix = stop server, delete `.next`
  (generated, git-ignored), restart; stylesheet then returned 200.
- **Docs updated 2026-10-19** for the batch workflow: `README.md`, `IMPLEMENTATION_STATUS.md`, `src/server/modules/catalog.ts`, and new `docs/modules/booking-correction.md` now reflect 90 tests, 8 migrations, booking-correction "implemented". Still stale: `docs/FINAL_REPORT.md`.
- Git warns "LF will be replaced by CRLF" on several files (Windows autocrlf) — harmless.
- Git Bash broken in this environment; use PowerShell.
- No live external integration has ever been run; all are mock/dry-run by design.
- Security: portal credentials in the checklist .docx were exposed in a shared doc — rotate them; never copy them into the repo.

## 11. Git / remote
- Working directly on `main` now (current HEAD `5de0d6b`), pushed to `origin/main`
  (`https://github.com/zobayer-al-mahmud/universal-commercial-portal`). History: `feature/booking-correction-damco`
  (last at `b0516da`) was merged into `main` on 2026-10-20 via merge commit `9418ea8` (no-ff, no conflicts, gates
  clean), then the H&M Sales Contract 3-PDF-set module landed straight on `main` at `5de0d6b` (typecheck 0,
  155/155 tests). No PR workflow is in use (`gh` CLI not installed here) — commits go straight to `main` on
  explicit user request each time. The feature branch still exists (local + `origin/feature/booking-correction-damco`)
  but is behind `main` now; treat `main` as the source of truth going forward.
- Only the `AUCP` folder is the repo; source folders 1–9 and the checklist are **not** in it. `.gitignore` excludes `.env`, `/var/`, `prisma/dev.db`, `node_modules`.
- Commit trailer for commits made by Claude: `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>` (model name changed from 5.5 → 5; use whatever the current session's system reminder specifies).

## 12. Session log (newest first)
- 2026-10-20 (commit + push): restarted the dev server (recurring stale-`.next` crash whenever another session's
  edits land while it's running — now fixed each time by deleting `.next` and relaunching with
  `node node_modules/next/dist/bin/next dev -p 3300`). Reviewed the H&M Sales Contract module + Sales Contract
  batch-parser fixes described below for secrets and for the "never modify source folders" rule (confirmed: the
  xlsx writer only reads `HM_SALES_CONTRACT_TEMPLATE_PATH` and always copies to a new file under
  `STORAGE_ROOT/hm-sales-contract/**`, never back to the template). Re-ran typecheck (0) and tests (155/155),
  committed (`5de0d6b`) and pushed straight to `origin/main`.
- 2026-10-20 (Generic Sales Contract bulk-batch parser fix + rich extraction UI):
  User reported that uploading the three real 643159 H&M PDFs to the generic
  `/sales-contract` bulk-batch dropped all three into `NEEDS_REVIEW` with
  `SCHEMA_DRIFT: Purchase Order text did not match the expected market-row layout`.
  **Root cause**: `src/server/sales-contract/parse.ts :: parsePoText` was written
  against the SRS §C.3 "normalised pdftotext" layout (`PM-A (PM-B) qty price date`
  on one line); the real H&M supplier PDF uses a concatenated layout
  (`29 Jun, 2026OE (OLCEU)3 54487%`), and the Size/Country breakdown PDFs are
  not Purchase Orders at all. All three were being pushed through the same PO
  regex, finding zero rows, and firing SCHEMA_DRIFT.
  **Fix** (uncommitted):
    - `src/server/sales-contract/parse.ts` — `parsePoText` now auto-detects the
      H&M `Purchase Order – Online` banner and delegates to the H&M PO parser
      (`parseHmPurchaseOrderToRawRows`), converting its `HmPoMarketRow[]` back
      to the generic `RawPoMarketRow[]` shape so normalize/validate/reconcile
      unchanged. New export `classifyHmDoc(text, filename)` returns
      `"PurchaseOrder" | "SizePerColourBreakdown" | "TotalCountryBreakdown" | "Unknown"`.
      New export `summariseExtraction(text, filename)` returns a per-file
      extraction summary (every header field + per-market rows + totals + notes).
    - `src/server/sales-contract/batch.ts` — classifies kind first; for a
      Size/Country PDF it skips the PO pipeline and emits the honest
      `NOT_A_PURCHASE_ORDER` reason instead of SCHEMA_DRIFT, with a pointer to
      the `/hm-sales-contract` three-PDF workflow. The item's `extractionJson`
      now carries the rich summary (used by the batch UI expander).
    - `src/components/SalesBatchItemDetail.tsx` (NEW) — expandable per-file
      detail: shows every extracted field + value, PO rows table, totals,
      kind badge, and the detected validation reasons separately from the
      row-level Decision/State/Write/Notes. Fulfils user spec item 4.
    - `src/app/(portal)/sales-contract/[batchId]/page.tsx` — adds a secondary
      row per batch item hosting the expander.
    - `tests/sales-contract-hm-batch.test.ts` (NEW, 9 tests) — regression on
      the three real 643159 PDFs through the generic pipeline:
      classifyHmDoc / parsePoText (4 markets, correct qty, no SCHEMA_DRIFT),
      runPipeline end-to-end (outcome `draft`, 4 poRows, 1 contract row with
      orderQty 4078), and summariseExtraction (header fields, Size/Country
      per-market/per-size qtys, notes).
  **Gates**: `npm run test` 155/155 (was 146 — +9 regression); `npm run typecheck`
  exit 0; `npm run build` compiled all routes (`/sales-contract/[batchId]`
  grew from 199 B to 1.67 kB with the client expander). No new migration, no
  env changes. Existing batch items already in the DB keep their old
  `extractionJson` (no `summary` field) — hitting ↻ Retry re-runs them through
  the new parser and populates the summary. Dev-server stale `.next` caveat
  still applies if it was running during the build (§10).
- 2026-10-20 (H&M Sales Contract — Phase B shipped, full UI + API + DB):
  Phase A (extractor + writer + 27 tests) now has its DB / server-action / API /
  UI around it. The feature is end-to-end usable from the portal: /hm-sales-contract →
  create contract → upload three PDFs per PO → review editable A..U preview → download .xlsx.
  - Files added / modified (uncommitted; see `git status`):
    - Prisma: `prisma/schema.prisma` + migration `20261020043245_add_hm_sales_contract` →
      4 new models: `HmSalesContract`, `HmSalesContractPo`, `HmSalesContractPdf`,
      `HmSalesContractRowEdit`. 11 migrations total, DB in sync.
    - Env: `src/lib/env.ts` + `.env.example` → new keys
      `HM_SALES_CONTRACT_TEMPLATE_PATH` (REQUIRED for the download route; blank
      by default — the writer never overwrites the template, only reads it),
      `HM_SALES_CONTRACT_MAX_FILE_MB` (default 20).
    - Server: `src/server/hm-sales-contract/intake.ts` → `createHmContract`,
      `uploadHmPdfSet`, `processHmPoSet` (text → parsers → match → recon →
      map-to-rows → persist as JSON blobs on `HmSalesContractPo`),
      `updateHmContractHeader`, `recordHmRowEdit`, `buildOverridesForContract`,
      `loadContractSets`.
    - Server action: `src/app/actions/hm-sales-contract.ts` →
      `createHmSalesContractAction` (JOB_CREATE), `updateHmHeaderAction`,
      `editHmRowAction` (append-only row override), `deleteHmPoAction`.
    - API routes:
      - `POST /api/hm-sales-contract/[id]/upload` — multipart with three named
        File fields `PurchaseOrder`, `SizePerColourBreakdown`, `TotalCountryBreakdown`.
      - `GET /api/hm-sales-contract/[id]/download` — writes to
        `${STORAGE_ROOT}/hm-sales-contract/${id}/exports/SalesContract_<ref>_<ts>.xlsx`
        and streams the file. Returns 400 if `HM_SALES_CONTRACT_TEMPLATE_PATH`
        is unset or no PO sets uploaded.
    - UI:
      - `src/app/(portal)/hm-sales-contract/page.tsx` — list + "+ New Sales Contract" (server action redirects to detail).
      - `src/app/(portal)/hm-sales-contract/[id]/page.tsx` — detail: header form, upload form, PO sets with editable preview + Download button (gated on template env + READY rows).
      - `src/components/HmSalesContractHeader.tsx` — A/B/C/D/E/P/Q/S editor (blank-by-default, unresolved rules BR-HM-01..05 cited on-screen).
      - `src/components/HmSalesContractUpload.tsx` — three named dropzones per PO + drag-drop auto-sort by filename.
      - `src/components/HmSalesContractPreview.tsx` — per-PO editable table showing extracted / user-edited / blank-source distinctly; append-only edits via `editHmRowAction`.
    - Catalog + nav: `prisma/seed.ts` adds `hm-sales-contract` module; `src/server/modules/catalog.ts` adds a `hm-sales-contract` entry with scope + BR-HM-01..05 open questions; `src/app/(portal)/modules/[key]/page.tsx` shows a direct link from the module card to `/hm-sales-contract`.
  - Verification gates: `npm run test` 146/146 (unchanged — the UI/API layer is covered by typecheck + build); `npm run typecheck` exit 0; `npm run build` compiled ALL routes incl. the two new API routes and two new pages; `npm run db:migrate` + `npm run db:seed` succeeded (admin bootstrap re-ran OK).
  - Env note the user needs to set BEFORE first download:
    `HM_SALES_CONTRACT_TEMPLATE_PATH="D:/UCP — REQUIRED DATA & FILES/1. Sales Contract Creation/new-up coming shipment -HM-2015 to 2026(AutoRecovered).xlsx"`
  - **Dev server caveat**: `next build` was run while the dev server (:3300) was still bound. Per §10, if the user hits unstyled Times-New-Roman pages, stop the dev server, delete `.next` (git-ignored, generated), restart. Normal next-dev HMR will otherwise pick up the new files on save.
  - Nothing committed. Stage selectively (never `.env`, `var/`, `prisma/dev.db`).
    `var/hm-smoke.ts` is a dev-only end-to-end scratch under the git-ignored var/
    folder — leave it or delete; it hit a tsx/Node 24 vs `generator-function`
    incompat and the unit tests are the authoritative verification.
- 2026-10-20 (H&M Sales Contract — three-PDF-set extractor, Phase A — PURE LOGIC ONLY):
  built the backend module `src/server/hm-sales-contract/` end-to-end for the user's new
  "upload PO + Size/Colour + Country breakdown PDFs per PO → fill the A–U columns of the
  live `H&M` worksheet → download" workflow. Scope decisions documented in
  `docs/modules/hm-sales-contract.md` (mapping + 5 unresolved rules BR-HM-01..05 covering
  Date column source, Style No. substitution, Item Des. composition, pack/set default, and
  contract-no numbering — each kept blank by default so no business value is invented).
  Deliberately split into two phases: **Phase A done here** = pure extractor + validator +
  mapper + workbook writer + tests; **Phase B next** = Prisma models, server action, UI,
  intake wiring.
  - Files added (uncommitted):
    - `src/server/hm-sales-contract/{types,parse-po,parse-size-breakdown,parse-country-breakdown,match,validate,map-to-rows,write-xlsx,index}.ts`
    - `tests/hm-sales-contract.test.ts` (27 tests) + `tests/fixtures/hm-643159-{po,size,country}.txt`
      (verbatim pdf-parse output of the three real 643159 PDFs the user attached)
    - `docs/modules/hm-sales-contract.md`
  - Key parser facts learned from the real PDFs that are not in the SRS:
    - pdf-parse flattens the two-column layout as "all N labels in order, then all N values
      in order". The parser extracts headers by locating the ordered label block then
      reading the N following lines.
    - Market table rows are concatenated: `29 Jun, 2026OE (OLCEU)3 54487%`. Qty/pct boundary
      is ambiguous on small-qty rows (`2506%` → 25/06 vs 250/6); resolved by enumerating
      splits per row and picking the combination whose qty sum equals the unambiguous PO
      `Total:` row (4078 for 643159). No value is silently altered — unresolvable splits
      fall back to the best-score combo + raise QTY_MISMATCH via the reconciler.
    - Country breakdown codeB characters are letters+dashes only (never digits), so the
      row regex excludes digits in the codeB class or it will swallow the first qty digit.
  - Key mapping convention (established from the LIVE `H&M` sheet, not just the spec text):
    one anchor row per PO with G=total/M=`=G*I`/R=`=S*G` formulas; subsequent delivery/
    market rows leave G/M/R blank and encode the per-market qty inside column O as free
    text: `"<TOD> <code> (<codeB>) <qty> <pct>%"`. The workbook writer never overwrites
    the user's template — it `copyFile`s it to a new path and appends to that.
  - Verification: `npm run test` 146/146 (was 119); `npm run typecheck` exit 0; no DB
    migration yet (Phase B). Dev server not restarted (no runtime code paths added).
  - Next session (Phase B): add `HmSalesContract`, `HmSalesContractItem`, `HmSalesContractPdf`
    Prisma models (or extend `SalesContractBatch` with a kind="hm-three-pdf"); add
    `src/app/actions/hm-sales-contract.ts` + `src/app/(portal)/hm-sales-contract/**` pages;
    build editable preview table showing extracted / user-edited / blank-source distinct;
    wire the writer to download via `/api/export/hm-sales-contract/<id>`. Nothing is
    committed; stage selectively (never `.env`, `var/`, `prisma/dev.db`).
- 2026-10-20 (live Damco auto-login): built the visible-browser live path (`damco-browser.ts`, `damco-auth.ts`) and
  DEMONSTRATED real auto-login against the production Damco portal (AUTHENTICATED → Dashboard; creds from env, no bypass).
  Discovered real login + dashboard + search selectors (see §8a). Applied `add_damco_live_run` migration; typecheck exit 0.
  BLOCKED: the live PO-search probe was denied by the auto-mode classifier ("Security Weaken"); results-read/PDF selectors not
  yet captured, so the live search→compare→PDF path is not wired. Nothing committed. User informed; awaiting unblock decision.
- 2026-10-20: restarted the dev server (stale `.next` after a prior crash — deleted it, relaunched with
  `node node_modules/next/dist/bin/next dev -p 3300` since `npm run dev` is blocked by PowerShell execution policy
  here), verified login + dashboard render. Then committed and pushed the SRS-addendum work described in the entry
  below (it was sitting uncommitted) to `origin/feature/booking-correction-damco` at `4d36356`, after re-running
  typecheck (0 errors) and tests (119/119) as a gate. Reviewed the diff first — no secrets, `.env`/`var`/`dev.db`
  correctly excluded. Not merged into `main`; no PR opened (`gh` not installed here).
- 2026-10-19 (Oct-2026 SRS addendum — Module Enhancements): implemented from `UCP_Modified_SRS_Module_Enhancements_Oct_2026.docx`
  (read via a Python docx-text extractor; no pandoc/soffice in this env). Two explicitly handwritten-requested gaps built end-to-end:
  **(A) Sales Contract bulk multi-PDF batch (§3)** — new models SalesContractBatch/Item; pure classifier `batch-classify.ts`
  (EXISTING/NEW/DUPLICATE/AMENDMENT/NEEDS_REVIEW + blockWrite for AC-03); engine `batch.ts` (store/de-dup → pdf-parse text →
  OrderNo + PO-row extract via existing pure pipeline with new `skipAttachmentCheck` opt → cross-match existing contracts →
  classify; independent per-file failure, idempotency, review tickets); action `sales-contract-batch.ts`; UI
  `SalesContractBatchUpload.tsx` + dashboard `/sales-contract/[batchId]` (unified row-based table §3.3); wired into module page.
  Shared `src/server/pdf/parse-pdf.ts` (serialized pdf-parse). **(B) Shipment Schedule in-portal editing (§4.2)** — new model
  ShipmentScheduleLineEdit + line editState/editedBy/editedAt; pure `edit.ts` (editable vs locked fields, field-level validation,
  PCS×FOB recompute); action `shipment-schedule-edit.ts` (role-gated edit + Submit/Approve, append-only field history, audit);
  perms `schedule.edit`/`schedule.approve`; inline editor `ScheduleLineEditor.tsx` on `/jobs/[id]`. Gates: **typecheck 0, tests
  119/119 (was 99; +20 pure tests in `sales-contract-batch.test.ts` + `shipment-schedule-edit.test.ts`), `next build` all routes
  incl. `/sales-contract/[batchId]`, migration applied + seed ok**. Runtime smoke (tsx, since deleted): batch on 3 real PDFs →
  sha256 de-dup, pdf-parse, filename OrderNo `644637-8756` cross-matched to confirmed `AGL/H&M/99/2026`, non-PO PDFs honestly
  NEEDS_REVIEW/NOT EXTRACTED with writes blocked, idempotent reprocess. Catalog scope refreshed. **§5 Customs Invoice & §6 PDF
  Rename**: the addendum says "no separate handwritten customization — retain existing scope"; left as-is (already batch-table +
  collision/preview + export capable). **§7 Booking Correction**: already implemented (prior sessions). Nothing committed (not asked).
  Note: stopped a stale undocumented `next start -p 3310` production server (PID held the Prisma engine DLL, blocking `prisma generate`);
  it was not the documented :3300 dev server and not in a visible terminal tab. `.next` was deleted after the build per the §10 rule.
- 2026-10-19 (revised "DEMCO" doc corrections): per `MASTER_PROMPT_DEMCO_Booking_Correction.docx` §2, changed the Damco bot entry
  point to the single dashboard URL `…/ShipperPortalWeb/ViewDashboardAction.action` and REMOVED the fabricated `SearchAction`
  deep-link (old `buildSearchUrl` → `portalEntryUrl()` + `searchTerms()`; the bot now navigates the UI with PO*/country* terms).
  Removed the example booking ID 61954434 from sample data. Updated `env.ts` default, `.env.example`, `damco-portal.ts`,
  `batch.ts` (event logs entryUrl/poQuery/countryQuery), tests, and the module doc. User chose to KEEP the "Damco" naming in
  code/env (matches the booking.damco.com domain); the doc's "DEMCO" spelling is not adopted. Gates: typecheck 0, 99/99 tests,
  build green, pipeline re-verified (4 COMPLETED + REQUESTED/MISMATCH/no-results branches). Uncommitted.
- 2026-10-19 (feature build + full verification): implemented the Booking Correction DAMCO batch workflow from the MASTER PROMPT
  (extract → Damco search → match → CONFIRMED validation → verified PDF, live-gated). Added the server engine, adapter, actions,
  API routes, UI, migration, tests. Verified: typecheck exit 0, 90/90 tests, `next build` all routes, end-to-end pipeline on the
  7 real packing lists (all §9/§11 branches), browser admin login + batch dashboard + authenticated PDF/ZIP/CSV downloads (200).
  Refreshed README/IMPLEMENTATION_STATUS/catalog + added `docs/modules/booking-correction.md`. Nothing committed/pushed (not asked).
- 2026-10-19 (smoke test attempt): browser smoke-test blocked (permission classifier denied credential access for sign-in; did not work around it).
  Instead ran real extraction on the 7 sample packing-list PDFs — results in §8. No code changed in this step. Scratch scripts are outside the repo (session scratchpad).
- 2026-10-19 (later): fixed typecheck by adding `src/types/pdf-parse-lib.d.ts`; ran seed (ok), `next build` (ok), tests 90/90, typecheck exit 0;
  dev server stopped for the build and restarted on :3300 (healthy). Nothing committed or pushed yet.
- 2026-10-19: Explained all modules to the user; pushed repo to GitHub; started dev server on :3300 via PowerShell (it exited once with code 255, no error in log, then restarted);
  created this file; discovered the uncommitted booking-batch work; verified tests 90/90 pass, typecheck fails (2 errors), migrations up to date.

## Maintenance rules for this file
1. Update after every significant change, completed task, or decision. 2. If interrupted, update immediately with exact resume steps.
3. Before work: read this file, then inspect the actual code/`git status`. 4. Never mark something done without running tests/typecheck.
5. No secrets. 6. Before ending a session, make §8 (task in progress) and "Next actions" reflect reality.
