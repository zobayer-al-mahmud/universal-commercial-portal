# MEMORY.md — AUCP project handover

> Read this first, then inspect the files named below. Keep it current (rules at the bottom).
> **Never put secrets here.** Credentials live only in the git-ignored `.env`.
> Last updated: 2026-10-22 (new PDF Combiner module — see §12 topmost entry). All facts below were verified on that date unless marked UNVERIFIED.

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
- Absolute path: **`D:\UCP\universal-commercial-portal`** as of 2026-10-20 (fresh checkout; no spaces/em-dash, so Git Bash works here).
  Previously `D:\UCP — REQUIRED DATA & FILES\AUCP`. The source-evidence folders are NOT next to this new path — paths in this file
  pointing at `..\5. Booking Correction\…` or `D:/UCP — REQUIRED DATA & FILES/…` (e.g. `HM_SALES_CONTRACT_TEMPLATE_PATH`) refer to the old location.
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
| 2 | Shipment Schedule | **v2 implemented (2026-10-20)**. One `ShipmentSchedule` per week + any number of `ShipmentScheduleCutoff` rows (default "1st cut off"/"2nd cut off") + per-market `ShipmentScheduleRow`. Upload booking-confirmation PDFs under a chosen cut-off; filename `<OrderNo> <Market+Sub>.pdf` drives OrderNo + market codes; PDF content parsed for BCN, BRef, Status, ports, mode, PCS, cartons, gross wt, cbm; OrderNo cross-matched against `HmSalesContractPo` → hydrates Buyer Code / Cont.No. / Date / Style / FOB / Composition / PCS (never invented). Excel-like preview grouped by cut-off. **Per-cut-off .xlsx download** (sample layout: orange title + green 15-col header + `=Ex*Gx` Value formula). **Row-wise inline edit** of every field (sales-contract-sourced + PDF-sourced + manual invoiceNo) with append-only history in `ShipmentScheduleRowEdit`. Old `ShipmentScheduleLine*` tables stay in schema but unreferenced. Pending: invoice-number auto-allocation, ambiguous-match resolver UI |
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
- 2026-10-22 (NEW module: PDF Combiner, uncommitted):
  Spec (user): upload a master Excel where each row lists file names to merge; select 8–10 of the 10–15 folders on a server;
  Run → bot reads the Excel, finds each file inside the selected folders (nested sub-folders at any depth) and builds ONE PDF per row.
  Built:
    - `src/server/pdf-combiner/{master,resolve,folders,merge,read-master,run}.ts` (master/resolve/merge pure; `run.ts` is the only writer).
    - Master format: optional header; optional "Output PDF Name" column (else `Row_<n>.pdf`); SL column ignored; file cells merged left→right;
      `.pdf` optional; case-insensitive; `Folder/sub/name.pdf` disambiguates. .xlsx or .csv. Template: `/api/pdf-combiner/template`.
    - Fail closed per row: missing / ambiguous (same name in 2+ places) / unreadable-encrypted file → NO PDF for that row, reason shown.
    - Folders = immediate sub-folders of `PDF_COMBINER_ROOT` (new env; blank = disabled); selection validated against the live listing (no path traversal).
      Source folders are read-only. Outputs: `var/storage/pdf-combiner/<runId>/output/*.pdf`.
    - Prisma: `PdfCombineRun`, `PdfCombineOutput` (migration `20261022040608_add_pdf_combiner`). Permission `pdf.combine` (ADMIN, COMMERCIAL). Module seeded.
    - UI: `/modules/pdf-combiner` (form + recent runs), `/pdf-combiner/[runId]` (per-row results, view/download, ZIP). Component `PdfCombinerForm.tsx`.
    - Dependency: `pdf-lib@1.17.1`. `next.config.mjs`: `serverActions.bodySizeLimit = "50mb"` (default 1 MB rejected uploads) + pdf-lib external.
    - Local `.env` now has `PDF_COMBINER_ROOT="./var/pdf-combiner-demo"` (12 demo folders with generated PDFs) — replace with the real server share path.
  Verified: tests 217/217 (new `tests/pdf-combiner.test.ts`, 15), typecheck exit 0; browser E2E on dev :3300 — 8 folders, 5-row master →
    3 COMPLETED (4/4/2 pages), 1 missing, 1 ambiguous; per-PDF, ZIP and template downloads 200 with valid PDF/ZIP/XLSX bytes. `npm run build` not run.
  Open: partial-PDF-on-missing policy, default naming, write-back to a server folder (see catalog openQuestions).
- 2026-10-20 (Customs Invoice Generation — rebuilt from scratch, uncommitted):
  User asked to delete all previous customs-invoice work and rebuild per new spec:
    - Use country-wise templates from `D:/oct-2026/automation docs/New folder/3. Customs Invoice Generation/Customs Invoice templates and sample files/`
      (54 .xlsx files, filename pattern `<invoiceNo> <countryCode>.xlsx`
      — e.g. `45237 OB.xlsx`, `45248 OF-(IT).xlsx`, `45260 OU-068.xlsx`).
    - Detect country code and pick the matching template.
    - Pull data from Sales Contract (HmSalesContractPo) + Shipment Schedule
      (ShipmentScheduleRow) by Order No; one invoice per unique Order No.
    - Every field editable; PDF upload per invoice auto-extracts labelled fields;
      download the completed invoice as .xlsx.

  Files DELETED (uncommitted):
    - `src/server/customs-invoice/{build,intake,types}.ts`
    - `src/server/export/customs-invoice-workbook.ts` and the whole `src/server/export/` dir
      (schedule-workbook.ts was already orphaned from the earlier Shipment Schedule wipe)
    - `src/app/actions/customs-invoice.ts` (old version)
    - `src/components/CustomsInvoiceForm.tsx`
    - `src/app/api/export/customs-invoice/` route
    - `tests/customs-invoice.test.ts` (old) and `tests/export.test.ts`

  Prisma schema REBUILT (`20261020113846_rebuild_customs_invoice` migration applied):
    - Dropped the old `CustomsInvoice` model (job-scoped, invoice-key based).
    - New `CustomsInvoice`: one row per unique Order No (`@unique`), with
      `countryCode` + `templateFile` resolved from market codes, every editable
      header/parties/goods/weights column, status enum (draft/ready/exported).
    - New `CustomsInvoicePdf`: per-invoice attached PDF with sha256 dedup +
      extractedJson for audit.
    - New `CustomsInvoiceEdit`: append-only edit history, source =
      user/pdf-extract/prefill.
    - Removed `Job.customsInvoices` relation (no longer job-scoped).
    - 11 migrations total, DB up to date.

  Files ADDED (uncommitted):
    - `src/server/customs-invoice/templates.ts` — filename parser + folder scan +
      `resolveTemplate(marketCode, marketSubCode)`. Handles OB / OE (variant) /
      OF-(IT) / OU-068 / LH- PL and other variants in the real folder.
    - `src/server/customs-invoice/types.ts` — `InvoiceFields` (flat view), labels,
      string/int/float field groupings, default exporter/buyer strings.
    - `src/server/customs-invoice/pull-data.ts` — `shortOrderKey()` (6-digit
      join key), `listOrderNosWithPrefill()` merges HmSalesContractPo (contract,
      style, unit price, qty from poJson) + ShipmentScheduleRow (market codes,
      ports, booking, cartons, weights); `buildPrefill()` for one Order No.
    - `src/server/customs-invoice/intake.ts` — `createInvoiceForOrder` (prefill
      → insert, `@unique orderNo` dedup, `customs-invoice.created` audit),
      `updateInvoiceFields` (diff against stored row, Prisma `$transaction` of
      update + per-field `CustomsInvoiceEdit` inserts, `customs-invoice.edited`
      audit), `deleteInvoice`.
    - `src/server/customs-invoice/parse-pdf.ts` — serialised pdf-parse (same
      chain pattern as booking-correction) + a labelled-regex extractor for
      Invoice No / Dates / Order No / Contract Ref / EXP / Ports / Vessel /
      Terms / Buyer code / Style / HS code / Category / Qty / Unit Price /
      Cartons / Weights / Measurement / Dimension. Never invents values.
    - `src/server/customs-invoice/write-xlsx.ts` — loads the matched template
      file (NEVER modifies the originals), adds a `UCP OVERRIDES` sheet with
      every field label+value, best-effort patches the PAYMENT INVOICE sheet's
      input row (last 25 rows, finds the row whose cell contains an AGL/H&M
      contract-ref string). Falls back to a plain fresh workbook when no
      template matches.
    - `src/app/actions/customs-invoice.ts` — `createInvoiceAction`,
      `updateInvoiceAction` (reads all editable fields from FormData with
      correct string/int/float coercion), `deleteInvoiceAction`.
    - `src/app/api/customs-invoice/[id]/upload/route.ts` — multipart POST,
      sha256 dedup, writes to `${STORAGE_ROOT}/customs-invoice/<invId>/`, runs
      extractor, applies non-empty fields via `updateInvoiceFields` with
      source=pdf-extract.
    - `src/app/api/customs-invoice/[id]/download/route.ts` — GET returns the
      .xlsx (template or fresh), filename `CustomsInvoice_<order>_<country>.xlsx`.
    - `src/app/(portal)/customs-invoice/page.tsx` — list of every Order No
      found (SC / SS source badges) + create / open buttons. Shows resolved
      template per row.
    - `src/app/(portal)/customs-invoice/[id]/page.tsx` — detail/edit page:
      PageHeader with download + back links, template warning when none
      matches, PDF upload card, editable form, append-only edit history table.
    - `src/components/CustomsInvoiceCreate.tsx` — per-row inline "Create
      invoice" button (useFormState + redirect on success).
    - `src/components/CustomsInvoiceEditor.tsx` — 6-section grouped editor
      covering all 40 fields with per-kind inputs (text / number step=any /
      textarea for addresses).
    - `src/components/CustomsInvoicePdfUpload.tsx` — client-side fetch to the
      upload route (plain file input, no useFormState body-size cap), surfaces
      the extracted labels + duplicate / updated counters.
    - `tests/customs-invoice.test.ts` — 17 unit tests: shortOrderKey,
      parseTemplateFilename (every real variant in the folder), resolveTemplate
      (exact + variant-suffix + fallback), extractInvoiceFieldsFromPdf (empty
      buffer), writeInvoiceXlsx (fresh fallback + template-mode UCP OVERRIDES
      sheet via `describe.skipIf`).

  Files edited (uncommitted):
    - `src/lib/env.ts` — added `CUSTOMS_INVOICE_TEMPLATE_DIR` (default points
      at the Oct-2026 drop) + `CUSTOMS_INVOICE_MAX_FILE_MB`.
    - `.env.example` — documented both vars.
    - `src/lib/audit.ts` — added `"customs-invoice"` to the entityType union.
    - `src/server/modules/catalog.ts` — replaced the stale customs-invoice
      entry with the new scope (data pull, country-wise template, editable
      fields, PDF upload) and open questions.
    - `src/app/(portal)/modules/[key]/page.tsx` — swapped the inline manual
      `CustomsInvoiceForm` for a Link to `/customs-invoice`; removed the import.
    - `src/app/(portal)/jobs/[id]/page.tsx` — removed `customsInvoices` from the
      Prisma include and dropped the whole in-job "Customs Invoice" section
      (invoices are no longer job-scoped).

  Verification gates:
    - `npm run typecheck` — exit 0.
    - `npm run test` — **194/194** (was 178 before; +17 new customs-invoice,
      -2 export.test.ts, -6 old customs-invoice.test.ts; the booking-batch
      tests are stable). The real-template integration test confirms the writer
      produces a `UCP OVERRIDES` sheet on the matched NH template.
    - Dev server not restarted here (another chat holds :3300 — see §10 rule);
      the new routes compile under typecheck, UI verification pending.
  Nothing committed. Stage selectively (never `.env`, `var/`, `prisma/dev.db`).

- 2026-10-20 (Week-wise Shipment Schedule — per-cut-off .xlsx + row-wise edit, uncommitted):
  Follow-up to the v2 build. User asked for two more features:
  (a) each cut-off downloadable as its own Excel, (b) row-wise edit+save for
  every field (both PDF-extracted and manual).
  Files added (uncommitted):
    - `src/server/shipment-schedule/write-xlsx.ts` — pure workbook writer for ONE
      cut-off. Layout matches the sample: orange title row (merged across 15
      cols), green 15-column header, data rows with Value as a live `=E{row}*G{row}`
      formula (blank when either pcs or fob missing — never invents).
    - `src/server/shipment-schedule/edit.ts` — pure validators + `computeValue`.
      Int fields (pcs, pdfPcs, cartons) accept blank-as-null; float fields
      (fob, grossWeightKg, measurementCbm) same; string code fields (bcn,
      bookingRef, orderNo, marketCode, marketSubCode, invoiceNo) reject
      newlines/tabs; all other string fields are trimmed.
    - `src/app/api/shipment-schedule/[id]/cutoff/[cutoffId]/download/route.ts` —
      GET route; filename `<WeekTitle>__<CutoffLabel>.xlsx`.
    - `src/components/ShipmentScheduleRowEditor.tsx` — whole-row inline form (all
      27 editable fields, grouped: sales-contract / booking / cut-off meta).
      One Save → one server-action call → batched write + per-field
      ShipmentScheduleRowEdit entries.
  Files edited (uncommitted):
    - `src/app/actions/shipment-schedule.ts` — new `editRowAction` (useFormState)
      that collects every editable field from FormData, validates, diffs vs
      stored row, applies as a Prisma `$transaction` (row.update + N
      ShipmentScheduleRowEdit inserts), audits.
    - `src/components/ShipmentScheduleCutoffs.tsx` — added Rows column + per-row
      `⬇ Download .xlsx` link (hidden when row count is 0).
    - `src/components/ShipmentScheduleGrid.tsx` — per-cut-off section header now
      has a `⬇ Download this cut-off as .xlsx` link; each data row has an
      `✎ Edit` button that swaps the row for `ShipmentScheduleRowEditor`.
    - `src/app/(portal)/shipment-schedule/[id]/page.tsx` — computes
      `rowCountsByCutoff` and passes it to the cut-off manager.
    - `tests/shipment-schedule.test.ts` — +11 tests (edit validators,
      computeValue, write-xlsx round-trip: title row content, 15-column
      header labels, data cells, `E3*G3` Value formula, null-fob leaves Value
      blank, sheet-name sanitisation).
  Verification:
    - `npm run typecheck` — exit 0.
    - `npm run test` — **178/178** (was 167; +11).
    - Dev server :3300 (tab c1) absorbed the new files via HMR; final compile
      810 modules, zero errors. User already created a schedule and uploaded
      PDFs (log shows `POST /api/shipment-schedule/<id>/upload 200`).
  Nothing committed. Stage selectively.
- 2026-10-20 (Week-wise Shipment Schedule — v2 built end-to-end, uncommitted):
  User spec (from the sample workbook `Week 43 1st cut off 19.10.2026 2nd 23.10.2026.xlsx`
  + 42 real booking-confirmation PDFs under `D:/oct-2026/automation docs/New folder/
  2. Week Wise Shipment Schedule Creation/41/{1,2}/`):
    "User gets a dashboard with a PDF upload option and a cut-off selector. Pick a
     cut-off → upload PDFs → press Process → PDF data + matching Sales-Contract
     fields (by OrderNo) land in that cut-off as rows. Cut-offs can be
     manually created / updated / selected. Each PDF's row goes under whichever
     cut-off it was uploaded to. UI must look like the Excel sample."
  Sample Excel layout (15 columns): Buyer Code | Cont.No. | Date | OrderNo. | PCS |
    STYLE | FOB | COMPOSITION | CAT | HTS | Value | INVOICE | Market+Sub | Market | Mode.
  Filename pattern: `<6+ digits> <Market+Sub>.pdf`, e.g. `569959 AUW118.pdf` →
    OrderNo prefix 569959, market AU, sub AUW118.
  Booking PDF carries: BCN (ID), BRef (CTG…), Status (CONFIRMED), Port of Loading,
    Port of Discharge, Place of Delivery, Service (CFS/CY → SEA / AIR), PO Number
    (569959/3-2026), SKU/ITEM (AU/5686), Categories (AUW118), PCS, Cartons,
    Gross weight (kg), Measurement (cbm).
  New Prisma models (`add_shipment_schedule_v2` migration applied, 11 total):
    - `ShipmentSchedule` (one per week; weekTitle + weekNo + createdBy)
    - `ShipmentScheduleCutoff` (scheduleId + label + date + sortOrder, cascade on schedule delete)
    - `ShipmentScheduleRow` (scheduleId + cutoffId + sales-contract fields + PDF fields
      + sha256/path + matched/matchReason)
    - `ShipmentScheduleRowEdit` (append-only edit history, ready for Phase 2)
    - Old `ShipmentScheduleLine*` tables LEFT IN PLACE (not referenced any more).
  Files added (uncommitted):
    - `src/server/shipment-schedule/{types,parse-filename,parse-booking-pdf,
      match-sales-contract,intake}.ts` — pure extraction + persistence service.
      `parse-booking-pdf` handles the pdf-parse concatenated layout (labels like
      "Export Licence No.Port of Loading" that run two columns together; "AU/5686SKU"
      without space between SKU and the label).
    - `src/app/actions/shipment-schedule.ts` — create schedule, update title, add /
      edit / delete cut-off, move row to cut-off, delete row. Permissions-gated
      (JOB_CREATE). On create, redirects to the detail page.
    - `src/app/api/shipment-schedule/[id]/upload/route.ts` — multipart upload
      (cutoffId + many `files`), returns per-PDF result (match status, booking status,
      PCS, cartons). sha256-dedup: re-uploading the same PDF updates its row's
      cut-off instead of creating a duplicate.
    - `src/app/(portal)/shipment-schedule/page.tsx` — list page with
      `CreateShipmentScheduleForm` + per-schedule row list.
    - `src/app/(portal)/shipment-schedule/[id]/page.tsx` — detail page: title editor
      + cut-off manager + PDF upload card + Excel-like grid.
    - `src/components/{CreateShipmentScheduleForm,ShipmentScheduleHeaderEditor,
      ShipmentScheduleCutoffs,ShipmentScheduleUpload,ShipmentScheduleGrid}.tsx` —
      the UI components. Upload uses plain fetch() against the API route to avoid
      the useFormState body-size cap and keep file inputs mounted (so FormData
      never loses files on DOM swap).
    - `tests/shipment-schedule.test.ts` — 12 pure tests: filename parsing,
      PDF parsing against two real sample PDFs (`569959 AUW118.pdf` and
      `583635 PEW153.pdf`), OrderNo-prefix matching (matched / no_sales_contract_po /
      ambiguous / not_ready).
  Files edited (uncommitted):
    - `src/server/modules/catalog.ts` — re-added `shipment-schedule` entry with the
      new workflow scope + 4 open questions (invoice allocation, Mode source,
      partial-PCS handling, duplicate OrderNo×Market).
    - `prisma/seed.ts` — re-added `shipment-schedule` module to MODULES; removed
      the deleteMany line from the previous wipe.
    - `src/app/(portal)/modules/[key]/page.tsx` — replaced the "Being rebuilt"
      banner with a link to `/shipment-schedule`.
    - `src/lib/audit.ts` — added `"shipment-schedule"` to the entityType union.
  Verification:
    - `npm run db:migrate` — `add_shipment_schedule_v2` applied; `prisma generate`
      renamed the TS types fine (new models visible); the Windows DLL rename failed
      (another chat's dev server locked `query_engine-windows.dll.node`), but the
      SAME DLL already handles SQLite reads so runtime still works and tmp files
      were cleaned up.
    - `npm run db:seed` — OK; `shipment-schedule` row restored in Module table.
    - `npm run typecheck` — exit 0.
    - `npm run test` — **167/167** (was 155; +12 from
      `tests/shipment-schedule.test.ts`). Includes real-PDF extraction tests.
    - `npm run build` — SKIPPED (another chat's dev server bound to :3300, §10 rule).
    - Browser verification SKIPPED for the same reason.
  Known gaps (Phase 2 todo):
    - .xlsx export matching the sample layout (title row + 15-column green header
      + per-cut-off section + per-row Value formula PCS×FOB).
    - In-portal inline editing of row cells (model + table already in place via
      `ShipmentScheduleRowEdit`).
    - Invoice-number allocation per cut-off (manual today).
    - If the PDF filename does not follow `<digits> <Market+Sub>.pdf` the row is
      created with `matchReason=bad_filename:...` and left for the reviewer.
    - If multiple HmSalesContractPo rows share the same 6-digit prefix,
      `matchReason=ambiguous` and the first candidate's fields are shown; the
      reviewer resolves manually (no UI dropdown yet).
  Nothing committed. Stage selectively (never `.env`, `var/`, `prisma/dev.db`).
- 2026-10-20 (Week-wise Shipment Schedule — module code wiped, rebuilding, uncommitted):
  User asked to delete all logic in the Week-wise Shipment Schedule module ("ebar sob
  logic delete kore dew"). Confirmed scope with user: "Code + handoff wiring only. Keep
  Prisma + migrations + permissions + relations intact so DB stays stable. The module
  tile is removed from the portal."
  Files deleted (uncommitted):
    - `src/server/shipment-schedule/{edit,intake,schedule,types}.ts` (+ the folder)
    - `src/app/actions/shipment-schedule.ts`
    - `src/app/actions/shipment-schedule-edit.ts`
    - `src/components/ScheduleForm.tsx`
    - `src/components/ScheduleFromContracts.tsx`
    - `src/components/ScheduleLineEditor.tsx`
    - `src/app/api/export/schedule/[jobId]/route.ts` (+ `schedule/` folder)
    - `tests/shipment-schedule.test.ts`
    - `tests/shipment-schedule-edit.test.ts`
    - `tests/handoffs.test.ts` (only tested `contractRowToOrder` / `scheduleLineToInvoice`
      which are also gone — no non-schedule tests to preserve)
    - `src/server/handoffs/map.ts` (both exported mappers belonged to the schedule
      handoffs; file would be empty)
  Files edited (uncommitted):
    - `src/server/handoffs/service.ts` — kept only `confirmContractJob`; removed
      `listSchedulableContracts`, `buildScheduleFromContracts`, `listInvoiceableScheduleLines`,
      `generateInvoiceFromLine`, their interfaces, and all shipment-schedule imports.
    - `src/app/actions/handoffs.ts` — kept only `confirmContractAction`; removed
      `scheduleFromContractsAction`, `generateInvoiceFromLineAction`, `ScheduleFromContractsState`.
      `confirmContractAction` no longer revalidates `/modules/shipment-schedule`.
    - `src/app/(portal)/modules/[key]/page.tsx` — removed the `module.key === "shipment-schedule"`
      branch (replaced with an amber "Being rebuilt" notice), removed the customs-invoice
      "① From shipment schedule lines" section (the manual CustomsInvoiceForm remains),
      and dropped the now-unused imports (`ScheduleForm`, `ScheduleFromContracts`,
      `listSchedulableContracts`, `listInvoiceableScheduleLines`, `generateInvoiceFromLineAction`).
    - `src/app/(portal)/jobs/[id]/page.tsx` — removed the `job.scheduleLines` section
      (editor + submit/approve/reopen forms + edit history), removed `scheduleLines`
      from the Prisma include, removed `canEditSchedule`/`canApproveSchedule` locals,
      removed `ScheduleLineEditor` and `setScheduleLineStateAction` imports, trimmed
      the "Contract confirmed → Shipment Schedule" banner to just "Contract confirmed."
    - `src/server/modules/catalog.ts` — removed the `shipment-schedule` entry.
    - `prisma/seed.ts` — removed `shipment-schedule` from `MODULES`, added an explicit
      `prisma.module.deleteMany({ where: { key: "shipment-schedule" } })` so re-seeding
      drops the DB row (ran `npm run db:seed`; the row is gone, verified via
      `prisma.module.findMany()` — the 9 remaining modules are listed, no shipment-schedule).
  Kept intact (per user scope):
    - Prisma models `ShipmentScheduleLine`, `ShipmentScheduleLineEdit`, `Job.scheduleLines`
      relation, `SalesContractRow.scheduledJobId` field.
    - Migrations `20261018064138_add_shipment_schedule_line` + `20261019115647_add_sales_batch_and_schedule_edit`.
    - Permissions `SCHEDULE_EDIT` (`schedule.edit`) and `SCHEDULE_APPROVE` (`schedule.approve`)
      in `src/lib/permissions.ts` + `prisma/seed.ts` role mappings.
    - `confirmContractJob` + `confirmContractAction` (not schedule-specific).
  Verification:
    - `npm run typecheck` — exit 0.
    - `npm run test` — 155/155 (was 173; -18 = removed shipment-schedule.test.ts (10)
      + shipment-schedule-edit.test.ts (6) + handoffs.test.ts (2)).
    - `npm run db:seed` — ran OK; Module table now has 9 entries, no `shipment-schedule`.
    - `npm run build` — SKIPPED (another chat's dev server bound to :3300; §10 rule).
  Nothing committed. Stage selectively when ready.
- 2026-10-20 (Sales Contract Creation — fresh prototype-layout writer, uncommitted):
  User's follow-up spec + screenshot: the master Excel must be built FRESH per
  contract — ONLY the uploaded PDFs' data — using the specific prototype layout
  (Puls Trading banner, Block Contract Ref + two dates, "Revise: N", then a
  7-column data table). User was unhappy that the previous writer `copyFile`'d
  the user's historical workbook (12,000+ existing rows from 2015-2026) and
  appended to it.
  Changes (uncommitted):
    - `src/server/hm-sales-contract/write-xlsx.ts` — REPLACED. No more
      `copyFile` from template. Builds a fresh workbook named "Sales Contract"
      with the prototype layout:
        row 1 "PULS TRADING" text (right-aligned, blue bold — real logo belongs
                to the user; we never fetch external images)
        row 3 "Block Contract Ref:  : <marchentContNo>"  "Date: <contract date>"
        row 5 "Revise: <N>"                              "Date: <latest date>"
        row 7 column headers (blue bold, thin borders): Order No. | Style No. |
              Description | Order Qty | Total Qty With Packs | Unit Price |
              Value | Time of Delivery
        row 8+ one row per PO, every value PDF-sourced:
          A Order No.          = r.orderNo
          B Style No.          = po.header.productName
          C Description        = r.itemDes (customsCustomerGroup + productDescription + typeOfConstruction)
          D Order Qty          = r.orderQty (PO total)
          E Total Qty With Packs = D × packSet (packSet default 1 when blank)
          F Unit Price         = r.fob (USD #,##0.00)
          G Value              = formula =D{row}*F{row}  (USD #,##0.00)
          H Time of Delivery   = r.tod  (multi-line, wrapText)
      `safeStr()` strips "null"/"undefined" so missing fields are truly blank in
      the exported workbook (user spec: "never put field names or missing
      values in the header row" — our column headers only appear on row 7 and
      are the labels themselves, never populated from data).
    - `src/app/api/hm-sales-contract/[id]/download/route.ts` — stopped
      requiring `HM_SALES_CONTRACT_TEMPLATE_PATH`. The route calls the new
      writer with no `templatePath`. The old env var is still parsed by env.ts
      but is no longer required for any downloads.
    - `src/app/(portal)/sales-contract/view/[id]/page.tsx` — removed the
      amber "set TEMPLATE_PATH" warning banner (no longer applies).
  Tests rewritten:
    - `tests/hm-sales-contract.test.ts` — writer test block now verifies the
      prototype banner cells (A3 ref, H3/H5 dates, A5 Revise), the 7-column
      row-7 header, the single data row at row 8 with product-name as Style No.
      and the Value formula, row 9 empty, overrides-by-orderNo editing, blocked
      sets, multi-PO accumulation.
    - All other test files unchanged.
  Verification:
    - `npm run typecheck` — exit 0.
    - `npm run test` — 173/173.
    - Dev server :3300 compile green; `POST /api/sales-contract/upload 200`
      and TWO `GET /api/hm-sales-contract/<id>/download 200` observed in the
      live log — the user has already downloaded the new workbook.
  Nothing committed yet. The template path env var is retained in .env.example
  (optional, unused) in case we add a "re-use user's template" option later.
- 2026-10-20 (Sales Contract Creation — one row per PO (3-PDF merge), uncommitted):
  User's follow-up spec: "process the 3 uploaded PDFs together and generate exactly
  ONE row in the selected Sales Contract's master Excel—never create multiple rows
  for the same PO. All Excel fields must remain in their original columns, including
  fields with blank values; never put field names or missing values in the header row."
  Previous behaviour: mapper produced N rows per PO (anchor + N-1 per-market rows,
  G/M/R blank on non-anchor). New behaviour: mapper produces EXACTLY one row per PO,
  with every market's "<tod> <code> (<codeB>) <qty> <pct>%" concatenated newline-
  separated into column O (and distinct TODs newline-concatenated into column N),
  G/M/R always populated. Writer sets wrapText + top-align on N and O.
  Code changes (uncommitted):
    - `src/server/hm-sales-contract/map-to-rows.ts` — rewrote `mapToTemplateRows` to
      return a single `isAnchor=true` row; marketCode becomes a comma-joined
      traceability string (e.g. "OE,OD,OF,LH"); marketQuantity is the sum (= PO total
      when fully allocated); pctLabel is "" (per-market pct is encoded in O).
    - `src/server/hm-sales-contract/write-xlsx.ts` — removed the per-row `isAnchor`
      branch (every row writes G/M/R); added `safeStr()` that writes "" for null/
      undefined and refuses to persist the literal strings "null" / "undefined";
      added wrapText + vertical top alignment on cells N and O. Overrides are now
      keyed by orderNo alone (one row per PO → one override bucket).
    - `src/server/hm-sales-contract/intake.ts` — `buildOverridesForContract` now
      reduces edits into `{ [orderNo]: overrides }` (was `{ [orderNo:marketCode]: ... }`).
      `HmSalesContractRowEdit.marketCode` column is retained for audit but is not
      part of the lookup key anymore.
    - `src/server/hm-sales-contract/batch-upload.ts` — `detectRowConflicts` now
      compares the single prev/next row's fields directly (orderQty, fob,
      marketQuantity, tod, country, styleNo, itemDes, marketCode); the per-market
      "missing market" path is replaced with a single "row_missing_in_new_upload"
      case when the new upload produces zero rows.
  Tests updated:
    - `tests/hm-sales-contract.test.ts` — "A..U template rows" block updated:
      asserts rows.length === 1 regardless of market count, orderQty on the single
      row equals the PO total, column O concatenates every market (one line per
      market), marketCode is the comma-joined set of all markets, marketQuantity
      is the sum. Writer test updated to appendedRows === 1 and verifies row 3 is
      empty. Grouping test updated to 2 rows for 2 PO sets. Override test updated
      to new key format (orderNo-only).
    - `tests/sales-contract-pick-batch.test.ts` — missing-market test rewritten
      to assert that a DIFFERENT marketCode set between uploads is a conflict (the
      exported column O would change). New test for row-dropped case.
  Verification gates:
    - `npm run typecheck` — exit 0.
    - `npm run test` — **173/173** (was 172; +1 regression for the row-dropped case).
    - Dev server :3300 compile green; the user has already successfully loaded
      `/sales-contract/view/<id>` (POST 200 in the log).
    - `npm run build` SKIPPED while the dev server is bound (§10 rule).
  Nothing committed yet.
- 2026-10-20 (Sales Contract Creation — Master Excel View/Edit page + template path, uncommitted follow-up):
  User reported two things after the prototype redesign shipped:
  (a) `HM_SALES_CONTRACT_TEMPLATE_PATH not configured` on Download click.
  (b) Needs a MASTER EXCEL VIEW page where every row is visible, every field
      editable, with a Save option.
  Fixes:
  - Appended the discovered template path to `.env` (uncommitted; git-ignored):
    `HM_SALES_CONTRACT_TEMPLATE_PATH="D:/Running Backup/Downloads/new-up coming shipment -HM-2015 to 2026(AutoRecovered)(1).xlsx"`
    Dev server restarted (:3300, cleared `.next` first per §10). `/api/healthz`
    returns 200.
  - New page `src/app/(portal)/sales-contract/view/[id]/page.tsx` — the Master
    Excel view. Shows: editable header fields (via existing `HmSalesContractHeader`,
    columns A/B/C/D/E/P/Q/S), every PO's rows with per-cell inline editors (via
    existing `HmSalesContractPreview`, which already saves each edit through
    `editHmRowAction` as an append-only override — "Save" is per-field on blur /
    submit), the amber "set TEMPLATE_PATH" warning when env is unset, and the
    Download .xlsx button. "← Back" returns to /modules/sales-contract. No new
    backend — reuses the H&M editable-row machinery wholesale, so append-only
    edits + edit log + override reduction are already in place.
  - Added "👁 View / Edit" link in the Master Excel List table on the module
    page, next to Download.
  Verification gates:
    - `npm run typecheck` — exit 0.
    - `npm run test` — 172/172.
    - Dev server :3300 restarted; healthz OK. The new view page compiles.
  Nothing committed yet.
- 2026-10-20 (Sales Contract Creation — prototype-driven redesign, uncommitted):
  User sent a mockup + spec: section ① Select-or-Create, section ② Upload 3 PDFs
  (one PO) with coloured dropzones + Process button, section ③ Result, then a
  "Sales Contract Master Excel List" table below. Explicitly asked to DELETE
  everything else from the Sales Contract Creation module page (catalog Source-backed
  scope + Open questions cards, legacy "Bulk PDF upload", legacy "Single Order
  Package intake", "Recent legacy batches", "Recent jobs"). Also reported the earlier
  "No PDFs supplied" error → root cause was useFormState + file inputs in Next 14
  (server-action body-size limit 1 MB AND file inputs can lose files on DOM swap).
  Fix: switched to plain fetch() + two API routes.
  Files added (uncommitted):
    - `src/app/api/sales-contract/create/route.ts` — POST { marchentContNo } →
      creates a blank HmSalesContract and returns { id, marchentContNo }.
    - `src/app/api/sales-contract/upload/route.ts` — POST multipart (contractId +
      3 named PDF slots) → calls uploadHmBatch → returns BatchResult. Runs on a
      regular App Router API route so it is NOT capped by the server-action body
      limit.
  Files replaced (uncommitted):
    - `src/components/SalesContractPickBatch.tsx` — rewritten to match the
      prototype: numbered step badges, ① dropdown + inline "+ Create", ② three
      coloured dropzones (blue / green / purple) with click-to-upload AND real
      drag-and-drop, Process PDFs button, ③ Result card that renders the
      placeholder text until the first upload, then shows per-PO rows
      (orderNo / action / state / kinds / rows / notes) + Download master .xlsx
      link. All inputs stay mounted (ref-based reset) so FormData never loses files.
      Uses fetch() against the two new API routes; no useFormState.
    - `src/app/(portal)/modules/[key]/page.tsx` — the sales-contract branch
      returns a dedicated layout EARLY (header card + SalesContractPickBatch +
      Master Excel List table) and the catalog/legacy/jobs sections never run
      for this module. Dropped the now-unused `SalesContractBatchUpload` and
      `IntakeForm` imports.
  Files deleted (uncommitted):
    - `src/app/actions/sales-contract-pick.ts` — superseded by the API routes.
  Verification gates:
    - `npm run typecheck` — exit 0.
    - `npm run test` — 172/172 (unchanged; the pure-logic tests in
      sales-contract-pick-batch.test.ts still cover the full backend).
    - Dev server :3300 compile green; `GET /modules/sales-contract` returns 307
      (redirect to login, expected). The old SWC error traces in `preview_logs`
      are stale from earlier mid-edit states.
    - `npm run build` SKIPPED while the dev server is bound to :3300 (§10 rule).
  Notes:
    - The master Excel Download button needs `HM_SALES_CONTRACT_TEMPLATE_PATH`
      set in .env (unchanged behaviour); otherwise the download endpoint returns
      400 with a message. The user already knows this from the previous session.
    - Nothing committed yet.
- 2026-10-20 (Sales Contract Creation — Process button + master Excel list, uncommitted follow-up):
  Added the two gaps the user's follow-up spec called out:
    - Renamed the submit button on `SalesContractPickBatch` to `▶ Process N PDF(s) → selected contract`
      (was "Upload & process …") so the "Process" wording the user asked for is literally in the UI.
    - New section ② "Sales Contract master Excel files" below the upload card on `/modules/sales-contract`:
      a per-contract table (ref · Buyer Code · POs · master filename pattern · last updated · ⬇ Download .xlsx).
      Rows with 0 POs show "No POs yet" instead of a download button. Reads from `HmSalesContract` with
      `_count.pos` + the most recently updated PO's `updatedAt`.
    - The old legacy sections ("Bulk PDF upload" + "Single Order Package intake" + the recent-batches
      table) are preserved but moved behind collapsible `<details>` elements as sections ③/④, so the
      new flow is the primary visible one and nothing was removed.
    - SWC refused to parse the inline `typeof existing[number]` helper params in a server component
      (tsc parsed them fine); refactored to pre-computed `masterRows` with precomputed display strings.
  Verification gates:
    - `npm run typecheck` — exit 0 (both before and after the refactor).
    - `npm run test` — 172/172 (unchanged; new UI covered by typecheck + dev-server compile).
    - Dev server :3300 (ANOTHER chat's instance died — I restarted on :3300 after deleting the stale
      `.next` per §10). Current compile green: `GET /modules/sales-contract 307` (redirect to login,
      expected unauthenticated), `Compiled in …ms` with no errors in the latest log window. User asked
      to verify in their own Chrome at localhost:3300 (same URL).
    - `npm run build` — still SKIPPED while the dev server is running on :3300 (§10 rule).
- 2026-10-20 (Sales Contract Creation — pick-a-contract + max-3-PDF batch, uncommitted):
  Added a new "⓪ Pick a Sales Contract → upload up to 3 PDFs" section at the top of
  `/modules/sales-contract` (the "Sales Contract Creation" card). The user asked for:
  (1) contract selection BEFORE uploading PDFs; (2) max 3 PDFs per batch; (3) one master
  Excel per contract; (4) one row per unique PO (merge same-PO PDFs, split different-PO
  PDFs); (5) never silently overwrite — flag conflicts; (6) verification UI.
  The backend reuses the H&M three-PDF-set tables (HmSalesContract /
  HmSalesContractPo / HmSalesContractPdf) because the real supplier PDFs ARE H&M and
  that is the only working per-PO/per-contract infrastructure — building a parallel
  generic schema would duplicate the whole writer/parser stack. The UI/entry point lives
  on the generic Sales Contract Creation module page; the master-workbook download link
  points directly at `/api/hm-sales-contract/{id}/download` so the user never has to
  navigate to the H&M page.
  Files added (uncommitted):
    - `src/server/hm-sales-contract/batch-upload.ts` — new `uploadHmBatch(contractId, files)`
      with pure helpers (`extractOrderNo`, `groupByOrderNo`, `detectRowConflicts`,
      `validateBatchFiles`, `MAX_PDFS_PER_BATCH`). Does: validate (max 3, PDF-only, size,
      header, duplicate kind) → parse text + extract orderNo per file → group by orderNo →
      for each group `findOrCreate HmSalesContractPo(contractId, orderNo)`, upsert its
      PDFs by kind, re-extract across EVERY stored PDF for the PO, compare new rows vs
      previous rows for conflict detection. On conflict: state=NEEDS_REVIEW,
      blockWrite=true, PREVIOUS rowsJson is preserved (never silently overwritten),
      reasons blob lists each differing field.
    - `src/app/actions/sales-contract-pick.ts` — `pickAndUploadSalesContractAction`
      (useFormState). Handles both "pick existing" (contractId) and "create new"
      (marchentContNo) modes; requires JOB_CREATE; returns per-PO result for the UI.
    - `src/components/SalesContractPickBatch.tsx` — client component: existing-contracts
      dropdown + inline "➕ Create new" (just marchentContNo) + three named dropzones
      (PurchaseOrder / Size / Country) + submit + result panel (per-PO orderNo, action
      [created / merged / conflict / failed], state, kinds, rowCount, reasons) + direct
      Download .xlsx link.
    - `tests/sales-contract-pick-batch.test.ts` — 17 pure tests covering:
      Order No extraction (3 real H&M fixtures + "never invents" + regex fallback),
      grouping (same-PO consolidation, different-PO separation, unidentifiable bucket),
      conflict detection (first upload = no conflict, idempotent re-upload = no conflict,
      marketQuantity/fob diff = conflict, missing-market = conflict, additive-market = not
      a conflict), file validation (max-3 cap, non-PDF reject, missing %PDF reject,
      duplicate kind reject, valid 3-PDF accept), per-contract isolation guarantee note.
  Files edited (uncommitted):
    - `src/app/(portal)/modules/[key]/page.tsx` — added the SalesContractPickBatch
      section at the top of the sales-contract branch; existing bulk-batch and single
      intake form stay as sections ① and ②.
  Verification gates:
    - `npm run typecheck` — exit 0.
    - `npm run test` — **172/172 passed** (was 155; +17 regression tests from
      sales-contract-pick-batch.test.ts).
    - `npm run build` — SKIPPED because the dev server (:3300) is bound by ANOTHER chat
      and both share `.next`. Per §10, do not run `next build` while a dev server runs.
      Verify the build after stopping that server.
    - Browser verification SKIPPED for the same reason — the Browser pane in this
      session cannot reach another chat's dev server. Verify by hard-reloading
      `http://localhost:3300/modules/sales-contract` (HMR picks the new files up); the
      "⓪ Pick a Sales Contract → upload up to 3 PDFs" card should appear above the
      existing "① Bulk PDF upload" card.
  Notes:
    - No DB migration (reuses `HmSalesContract*` tables already applied).
    - No new env keys (reuses `HM_SALES_CONTRACT_TEMPLATE_PATH` /
      `HM_SALES_CONTRACT_MAX_FILE_MB`).
    - Nothing committed. Stage selectively (never `.env`, `var/`, `prisma/dev.db`).
    - Open architectural call for the user: this new flow sits on the H&M backend
      because H&M is AGL's only buyer. If a non-H&M buyer appears, we would then split
      out a generic sales-contract per-PO/per-contract schema; today that would be
      duplicated-for-nobody code.
- 2026-10-20 (fresh checkout at `D:\UCP\universal-commercial-portal`): reviewed this file and ran the app. Checkout had no
  `node_modules`, `.next` or `prisma/dev.db` (only `.env` present). Ran `npm install` (360 pkgs; npm audit reports 19 vulns incl.
  next@14.2.33 security advisory — not addressed), `npm run db:migrate` (fresh dev.db, all 11 migrations + seed OK — old test data
  is NOT in this DB), typecheck exit 0, tests 155/155. Dev server started via launch config `aucp-dev` on :3300; `/api/readyz` →
  ready/db ok; login page renders styled. Note: local `.env` has `DAMCO_LIVE_ENABLED="true"` (INTEGRATION_MODE=mock).
  `.env.example` shows as modified in git but the diff is line-endings only.
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
