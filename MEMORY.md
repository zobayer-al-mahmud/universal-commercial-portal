# MEMORY.md — AUCP project handover

> Read this first, then inspect the files named below. Keep it current (rules at the bottom).
> **Never put secrets here.** Credentials live only in the git-ignored `.env`.
> Last updated: 2026-10-19 (all facts below were verified on that date unless marked UNVERIFIED).

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
- **The dev server is NOT running** (it was stopped; last checked 2026-10-19). Start it with the PowerShell command above (`next dev -p 3300`); check `Get-NetTCPConnection -LocalPort 3300` first.

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
  RenameItem, ShipmentScheduleLine, CustomsInvoice, BookingCorrection, **BookingBatch, BookingDocument, BookingDocEvent (new)**,
  ReviewTicket, AuditEvent, ReferenceData, IntegrationAdapter.
- Dev DB contains test data from manual/live smoke testing (contract 644637-8756, schedule Week 43, invoice 66000 OW, rename job `cmvdgfu8…`).
- Money stored as float in SQLite (→ `NUMERIC(14,2)` when moving to Postgres).

## 7. Module status (verified against code/tests where noted)
| # | Module | Status |
|---|---|---|
| 1 | Sales Contract | Implemented (mock UCP save, draft-only). No real PO-PDF/.msg extraction (only synthetic fixtures) |
| 2 | Shipment Schedule | Implemented build + .xlsx export. Pending: booking-confirmation PDF parsing, port/country lookup, cut-off rules |
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
| Extraction on the 7 REAL packing-list PDFs (`..\5. Booking Correction\PACKING LIST\`) | **PASS** — PO/country/market + Gross Weight extract on all 7; carton/qty auto-split on the clean ones, rest → NEEDS_REVIEW (honest) |
| Full pipeline end-to-end (createBookingBatch → processBatch on all 7 real PDFs) | **PASS** (tsx smoke, 2026-10-19): 2 MATCHED→CONFIRMED→COMPLETED on clean extraction; after inline review-corrections all branches exercised — REQUESTED→PORTAL_AUTH_REQUIRED, gross MISMATCH, no-results SEARCH_FAILED, multiple-candidate resolution by country+values, valid batch ZIP (completed PDFs only) |
| Booking batch UI in browser (admin login → batch dashboard → downloads) | **PASS** — signed in as admin, `/booking/<batchId>` renders full results table + match tables + review editor + integrity messaging; in-page fetch of `/generated`, `/zip`, `/failed-report` → 200 with application/pdf, application/zip, text/csv |
| Live Damco | **NOT RUN** — fail-closed by design |

**Real-PDF findings (2026-10-19):** PO, country and market code extract correctly on all 7 files; Gross Weight extracts on all 7
(conf 0.95, label "Total weight (kg) · Gross"). Cartons/Quantity are **concatenated in the PDF's extracted text** (e.g. `Total8103`, `Total114`),
so: 4/7 files (614275 PE, 698757 PH, 698757 VN, 729715 EC) get an *unverified auto-split* (conf 0.55, pending review reason
`CARTON_QTY_AMBIGUOUS`); 3/7 (613625 PE `Total15263`, 698757 CN `Total29581`, 729708 EC `Total16312`) are *hard review* — cartons/quantity left empty,
user must key them in. This matches the design note in `extract.ts` (never guess) but means most real batches need manual review of carton/qty.
Auto-split correctness (e.g. `Total114` = 1/14 vs 11/4) could not be verified from text alone — a human must check against the PDF.
**Improvement idea:** use pdf-parse's custom `pagerender` (or another parser) to get positional text so "Ctns/Col" and "Qty/Col" totals come out as separate columns,
or cross-check against the per-carton rows. Not started.

### Next actions (in order)
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
- **Docs updated 2026-10-19** for the batch workflow: `README.md`, `IMPLEMENTATION_STATUS.md`, `src/server/modules/catalog.ts`, and new `docs/modules/booking-correction.md` now reflect 90 tests, 8 migrations, booking-correction "implemented". Still stale: `docs/FINAL_REPORT.md`.
- Git warns "LF will be replaced by CRLF" on several files (Windows autocrlf) — harmless.
- Git Bash broken in this environment; use PowerShell.
- No live external integration has ever been run; all are mock/dry-run by design.
- Security: portal credentials in the checklist .docx were exposed in a shared doc — rotate them; never copy them into the repo.

## 11. Git / remote
- Branch `main`; remote `origin` = `https://github.com/zobayer-al-mahmud/universal-commercial-portal` (pushed 2026-10-19 at commit `aef10bc`, 10 commits).
- Only the `AUCP` folder is the repo; source folders 1–9 and the checklist are **not** in it. `.gitignore` excludes `.env`, `/var/`, `prisma/dev.db`, `node_modules`.
- Everything in §8, plus `MEMORY.md` and the `CLAUDE.md` edit, is local only (not on GitHub). Commit trailer for commits made by Claude: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## 12. Session log (newest first)
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
