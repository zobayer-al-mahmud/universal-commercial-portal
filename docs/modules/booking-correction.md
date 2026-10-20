# Booking Correction (DAMCO) module

Batch packing-list PDFs → extract the three shipment-level totals → search the Damco
Shipper Portal → match → validate the CONFIRMED status → return verified PDFs, entirely
inside UCP. This document covers the workflow, configuration, commands, and the portal
limitations that keep the live path fail-closed.

## Workflow

```
UPLOAD → EXTRACTING → READY_TO_SEARCH → PORTAL_SEARCH → BOOKING_MATCHING
       → PDF_GENERATING → STATUS_VALIDATION → COMPLETED
```

Branch / terminal states: `NEEDS_REVIEW`, `MISMATCH`, `STATUS_MISMATCH`,
`SEARCH_FAILED`, `PORTAL_AUTH_REQUIRED`, `DOWNLOAD_FAILED`, `FAILED`.

1. **Batch upload** (`src/components/BookingBatchUpload.tsx`): multi-select + drag/drop,
   PDF-type / size / count validation, per-file content de-duplication. Originals are
   written unchanged to `STORAGE_ROOT/booking-correction/<batchId>/` and never modified.
2. **Extraction** (`src/server/booking-correction/extract.ts`): embedded text via
   `pdf-parse`; Gross Weight, Total Cartons, Total Quantity, PO number and country code
   with a source label, page, confidence and normalized value. Different labels are
   supported (e.g. `Gross Wt`, `CTNS`, `Qty`). Values that are missing/ambiguous are
   **never invented** — the document is flagged `NEEDS_REVIEW`. A scanned PDF with no
   embedded text is flagged `SCANNED_PDF_OCR_REQUIRED` (OCR is a configured extension).
3. **Review & correct** (`src/components/ExtractionReview.tsx`): authorised users
   (`booking.review`) correct extracted values inline; corrections are written to the
   audit log and the document is reprocessed.
4. **Damco search** (`src/server/integrations/damco-portal.ts`): logs in at the single
   dashboard entry URL and navigates the portal UI — selects the company + buyer, opens
   the Booking tab, enters the wildcard terms `PO*` (and `country*`), inspects results, and
   selects the matching booking **without blind first-result selection** (PO + country +
   value agreement). Ambiguity → `NEEDS_REVIEW`; no results → `SEARCH_FAILED`.
5. **Match** (`src/server/booking-correction/match.ts`): Gross Weight within an explicit
   tolerance (`BOOKING_GROSS_WEIGHT_TOLERANCE_KG`), Cartons and Quantity exact. A missing
   value is never a match. Outcomes: `MATCHED` / `MISMATCH` / `NEEDS_REVIEW` /
   `SEARCH_FAILED`. Only `MATCHED` proceeds to PDF generation.
6. **PDF generation** (`src/server/booking-correction/pdf-writer.ts`): produces the
   booking PDF, stored separately from the original, then re-validated
   (`pdfIsReadable`).
7. **Status validation** (`src/server/booking-correction/status.ts`): both the document
   heading and the booking status field must read **CONFIRMED** for the job to complete.
   - `CONFIRMED` + `CONFIRMED` → `COMPLETED`, PDF offered for download.
   - `REQUESTED` + `REQUESTED` → `PORTAL_AUTH_REQUIRED` (authorised confirmation needed).
   - disagreement → `STATUS_MISMATCH`. An unconfirmed booking is **never** reported as
     confirmed, and document text is never edited to fake a confirmation.
8. **Results** (`/booking/<batchId>`): one row per document with every required column,
   per-document generated/original downloads, a batch **ZIP of completed PDFs only**, a
   failed/review **CSV report**, per-document and batch **retry**, and full audit history.

## Processing guarantees

- State is persisted in the database (`BookingBatch`, `BookingDocument`,
  `BookingDocEvent`), so a restart does not lose progress.
- Bounded concurrency (`BOOKING_CONCURRENCY`); one document's failure never stops the
  rest of the batch.
- Idempotent: a `COMPLETED` document is not reprocessed unless explicitly retried; a
  duplicate file (same content hash) is skipped.

## Configuration (environment)

| Variable | Default | Purpose |
|----------|---------|---------|
| `INTEGRATION_MODE` | `mock` | `mock` \| `dryrun` \| `live` (see below) |
| `DAMCO_PORTAL_URL` | `https://booking.damco.com/ShipperPortalWeb/ViewDashboardAction.action` | The single authorised bot entry point (portal dashboard); the bot logs in here and navigates the UI — no other portal URL / booking-detail deep link is used |
| `DAMCO_USERNAME` / `DAMCO_PASSWORD` | _(empty)_ | **Live only.** From a secrets manager — never committed, never logged |
| `DAMCO_LIVE_ENABLED` | `false` | Must be `true` (with credentials, and `INTEGRATION_MODE=live`) to attempt a live run |
| `DAMCO_DEFAULT_COMPANY` | `ANANTA GARMENTS LIMITED` | Default company selection |
| `DAMCO_DEFAULT_BUYER` | `H&M HENNES & MAURITZ GBC AB` | Buyer selection |
| `BOOKING_MAX_FILES` | `25` | Max PDFs per batch |
| `BOOKING_MAX_FILE_MB` | `20` | Max size per PDF |
| `BOOKING_CONCURRENCY` | `4` | Documents processed in parallel |
| `BOOKING_GROSS_WEIGHT_TOLERANCE_KG` | `0.5` | Gross-weight match tolerance |

No secret value is printed above, and none is stored in source or the database.

## Integration modes

- **mock** (default): deterministic, offline. The booking is derived from the extracted
  values; scenario fixtures keyed by PO exercise MATCHED / MISMATCH / REQUESTED /
  multiple / no-results paths.
- **dryrun**: records the dashboard entry URL + the UI navigation steps and wildcard search terms (`PO*`, `country*`); makes no external call and constructs no deep link.
- **live**: **fail-closed.** Requires `INTEGRATION_MODE=live` + `DAMCO_LIVE_ENABLED=true`
  + credentials in the environment. Even when enabled, this build does not drive the
  live portal (a Playwright driver plugs in at `searchDamcoBookings`) and never performs
  a status-changing confirmation automatically — REQUESTED bookings are routed for
  authorised action (`PORTAL_AUTH_REQUIRED`). CAPTCHA/MFA are never bypassed.

## Permissions

- `job.create` — upload a batch.
- `booking.review` — correct extracted values.
- `job.retry` — retry a document / reprocess a batch.
- `booking.export` — download generated/original PDFs and the batch ZIP.

## Commands

```bash
npm run db:migrate   # applies the add_booking_batch migration
npm run db:seed      # registers booking.review / booking.export permissions
npm run test         # includes booking-extract / match / status / damco / pdf-zip suites
npm run typecheck
npm run build
npm run dev          # then Modules → Booking Correction
```

## Portal limitations (verify before enabling live)

- The reference screenshot does not clearly expose a **country-code search field**; the
  adapter carries country as an advisory `country=<code>*` filter. Confirm the real
  field / mechanism before a live run (decision Q-PORT-01).
- The authorised **confirmation workflow** for a REQUESTED booking is not automated; it
  requires an authorised person and least-privilege service credentials.
- Wildcard (`*`) search behaviour must be verified against the live portal.
- The generated mock booking PDF is a UCP artifact (clearly labelled as generated); it is
  not a Damco-issued document. Only a live run would retrieve the portal's own PDF.

## Carton / quantity extraction

The H&M "Ctns/Col | Qty/Col" summary table flattens into text with the two totals
concatenated on the total row (e.g. `Total6151` = 6 cartons / 151 pcs). The parser
(`parseCtnsQtyTable`) reads the total row's carton figure as **Total Cartons** (which is
Solid + Asst) and recovers **Total Quantity** as the numeric suffix the total row shares
with the article row (which ends in the same quantity) — so column headers and the
"Pcs incl. in totals" note are never treated as values. Verified across all 7 sample
packing lists: 613625 = 15/263, 614275 = 6/151, 698757 CN = 29/581, PH = 8/103,
VN = 7/114, 729708 = 16/312, 729715 = 1/14. When a document uses explicit labels
(`Total Cartons:`, `Total Quantity:`) those take priority. Only a layout the parser
cannot resolve confidently falls back to review — the manual-correction + reprocess path
is unchanged.

## Tested (2026-10-19)

`npm run test` → all suites pass (97/97), including the booking-correction DAMCO suites
and the per-file carton/quantity split. A live pipeline smoke test over the 7 sample
packing lists produced (no manual correction): 4 `COMPLETED` (verified CONFIRMED PDFs),
REQUESTED → `PORTAL_AUTH_REQUIRED`, gross-weight `MISMATCH`, no-results `SEARCH_FAILED`,
and a valid batch ZIP containing only completed PDFs.
