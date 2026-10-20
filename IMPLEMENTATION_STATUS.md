# Implementation Status

Updated: 2026-10-20. Statuses reflect what is actually implemented and verified.

## Milestones

| Milestone | Status | Notes |
|-----------|--------|-------|
| A. Source analysis | ✅ Done | 835 files inventoried + hashed; SRS + checklist + modules 1–5 analyzed; decision register written |
| B. Project foundation | ✅ Done | Next.js + Prisma + SQLite; migration applied; auth + RBAC; health probes; config validation |
| C. Shared workflow infra | ✅ Done | Document intake + hashing, job ledger + state machine, review queue, audit trail, reference data, adapter interface |
| D. Module vertical slices | 🟡 Partial | 5 of 9 modules functional (Sales Contract, PDF-rename, Shipment Schedule, Customs Invoice, Booking Correction — the last now a full DAMCO batch workflow) — implemented + tested; H&M / BB portals blocked (no source files) |
| E. Cross-module workflow | 🟡 Implemented | Confirm contract → schedule-from-contracts → invoice-from-line pipeline wired, with handoff links (scheduledJobId / invoicedJobId) preventing double-processing; verified live end-to-end |
| F. QA / hardening | 🟡 Partial | Unit tests + typecheck + build pass; live-integration tests out of scope (gated) |

## Per-module

| Module | Status | Implemented | Blocked / pending |
|--------|--------|-------------|-------------------|
| 1. Sales Contract | ✅ Implemented | Intake, 3-PDF rule, parse/normalize/validate, per-contract aggregation, review routing, idempotency, mock UCP save + read-back, audit, UI. **NEW (2026-10-20): H&M three-PDF-set workflow** — end-to-end feature: extractor (`src/server/hm-sales-contract/` parses real supplier PO + Size/Colour + Country breakdown layouts, three-way matches, cross-reconciles qty sums, maps to the A–U columns of the live `H&M` worksheet), Prisma models (`HmSalesContract`, `HmSalesContractPo`, `HmSalesContractPdf`, `HmSalesContractRowEdit`), server action, upload + download API routes, portal UI (`/hm-sales-contract`) with editable preview that marks extracted vs user-edited vs blank-source distinctly. Writer appends to a **copy** of the user's template (never overwrites). 27 tests on the real 643159 PDFs; typecheck + full build green. See `docs/modules/hm-sales-contract.md` for the mapping + 5 unresolved rules (BR-HM-01..05) | Q-SC-01..12; BR-HM-01..05; real PO-PDF/MSG extraction (bulk) |
| 2. Shipment Schedule | 🟡 Implemented (build + export) | Week-title parse, order→per-market expansion, value=PCS×FOB, sequential invoice allocation, validation + review routing, UI + job view, **.xlsx download** (Summary layout) | Booking-confirmation PDF parsing; port/country lookup; cut-off/invoice rules (Q-SS-01) |
| 3. Customs Invoice | 🟡 Implemented (build + export) | Per-order/market invoice build: fixed exporter/buyer, market-resolved consignee, HS-coded line items, amount=qty×price, totals, review routing, rendered doc, **.xlsx download** (INVOICE + SUMMARY + BL DRAFT) | numbering + consignee master data (Q-CI-01) |
| 4. PDF Rename | 🟡 Implemented (plan + gated apply) | CSV ingest (FCR 34 / Bill-of-Export 39 fields), deterministic rename-plan, collision/failed handling, review routing, UI; **gated on-disk apply** copies planned scans to an output dir (dry-run default, permission-gated, originals preserved, never overwrites) | canonical filename rule (Q-PR-01) |
| 5. Booking Correction (DAMCO) | ✅ Implemented | Batch PDF upload (drag/drop, validation, de-dup, originals preserved); layered extraction of Gross Weight/Cartons/Quantity + PO/country (confidence, NEEDS_REVIEW, reviewer-correction UI, audited); Damco search (PO*+country*, non-blind booking selection); 3-value match (GW tolerance, exact cartons/qty); CONFIRMED-status validation (heading+field); generated+re-validated PDF; per-doc + batch-ZIP + failed-report downloads; retry; durable state machine; bounded concurrency. Plus original↔corrected field diff | Confirm real Damco country-code field + authorised live-confirmation workflow (Q-PORT-01); OCR for scanned copies |
| 6. H&M Portal | ⛔ Blocked | Adapter registered (not configured) | No source files; credentials + field lists |
| 7. Bangladesh Bank | ⛔ Blocked | Adapter registered | No source files; draft/dry-run only |
| 8. Damco Portal | 🟡 Adapter in use | Shipper-Portal search/booking adapter consumed by Booking Correction (mock/dryrun) | Live search/confirmation gated (DAMCO_LIVE_ENABLED + env creds); confirm country-code field map (Q-PORT-01) |
| 9. Common Requirements | 🟡 Partial | RBAC, audit, reference data, idempotency | Full mapping/calc rules; retention; notifications |

## Verification (actual results, 2026-10-18)

| Check | Result |
|-------|--------|
| `npm run test` (Vitest) | ✅ PASS — 90/90 (pipeline, pdf-rename + apply, shipment-schedule, customs-invoice, booking-correction diff, booking DAMCO extract/match/status/adapter/pdf+zip, handoffs, xlsx export) |
| Booking Correction DAMCO pipeline (live smoke, 7 sample packing lists) | ✅ PASS — 2 MATCHED→CONFIRMED→COMPLETED on clean extraction; after inline review-corrections: REQUESTED→PORTAL_AUTH_REQUIRED, gross MISMATCH, no-results SEARCH_FAILED, multiple-candidate resolution, valid batch ZIP (completed only) |
| `npm run typecheck` (tsc) | ✅ PASS — exit 0 |
| `npm run build` (next build) | ✅ PASS — routes compiled (incl. /api/export/*), types valid |
| .xlsx export (live) | ✅ PASS — authenticated downloads return valid .xlsx (ZIP magic PK): Week-43 schedule 7 KB, customs-invoice 66000 OW 9.3 KB (INVOICE + SUMMARY + BL DRAFT) |
| PDF-rename apply (live) | ✅ PASS — dry-run then apply on job cmvdgfu8: copied 1 (1).pdf→64931.pdf, 1 (2).pdf→64883.pdf to output dir; originals unchanged; skipped the failed-extraction row |
| DB migrate + seed | ✅ PASS — 6 migrations (init, rename, schedule, customs-invoice, booking-correction, crossmodule-links) applied; roles/modules/admin/reference seeded |
| Live app smoke test (port 3300) | ✅ PASS — per-module slices + full cross-module chain: confirmed contract 644637-8756 → Week 43 schedule (invoices 66000/66001, markets OW/CL) → customs invoice 66000 OW (qty 2500, USD 26250 carried through; missing OW consignee flagged for review) |
| Live external integrations | ⛔ NOT RUN — disabled by design (mock); require authorization |

## Known limitations

- No real Purchase-Order PDF or `.msg`-attachment extraction (source had `.msg`
  containers only, no standalone PO PDFs; no MSG parser installed). Parser is covered
  by sanitized synthetic fixtures.
- SQLite dev DB; money stored as float in dev (→ `NUMERIC(14,2)` in Postgres).
- Concurrency (per-OrderNo advisory lock, SC-NFR-06) enforced logically, to be
  hardened with Postgres advisory locks.
- Modules 6/7 (H&M, Bangladesh Bank) blocked on missing source + credentials.
- Booking Correction's generated booking PDF is a clearly-labelled UCP artifact (mock);
  a live run would retrieve the portal's own PDF. The bundled pdf-parse (pdf.js v1.10,
  2018) cannot always extract text from the hand-authored PDF, so generated-PDF
  re-validation is structural (header + page + EOF) with a best-effort text check;
  real input packing-list PDFs extract normally.

## Safe next steps

1. Confirm Q-SC-11 (UCP API vs browser) + Q-SC-12 (submission policy) to enable a
   real UCP adapter behind the existing interface.
2. Implement PDF-rename execution from the captured CSV schemas (next cheapest slice).
3. Implement Shipment Schedule using the Week workbook layout + code lookups.
4. Provide field lists/screenshots + least-privilege service credentials for the
   three portals to unblock modules 6–8.
5. Migrate to PostgreSQL for staging; add advisory locks + money precision.
