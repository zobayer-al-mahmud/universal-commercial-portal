# Implementation Status

Updated: 2026-10-18. Statuses reflect what is actually implemented and verified.

## Milestones

| Milestone | Status | Notes |
|-----------|--------|-------|
| A. Source analysis | ✅ Done | 835 files inventoried + hashed; SRS + checklist + modules 1–5 analyzed; decision register written |
| B. Project foundation | ✅ Done | Next.js + Prisma + SQLite; migration applied; auth + RBAC; health probes; config validation |
| C. Shared workflow infra | ✅ Done | Document intake + hashing, job ledger + state machine, review queue, audit trail, reference data, adapter interface |
| D. Module vertical slices | 🟡 Partial | 5 of 9 modules functional (Sales Contract, PDF-rename, Shipment Schedule, Customs Invoice, Booking Correction) — implemented + tested; H&M / BB / Damco portals blocked (no source files) |
| E. Cross-module workflow | 🟡 Implemented | Confirm contract → schedule-from-contracts → invoice-from-line pipeline wired, with handoff links (scheduledJobId / invoicedJobId) preventing double-processing; verified live end-to-end |
| F. QA / hardening | 🟡 Partial | Unit tests + typecheck + build pass; live-integration tests out of scope (gated) |

## Per-module

| Module | Status | Implemented | Blocked / pending |
|--------|--------|-------------|-------------------|
| 1. Sales Contract | ✅ Implemented | Intake, 3-PDF rule, parse/normalize/validate, per-contract aggregation, review routing, idempotency, mock UCP save + read-back, audit, UI | Q-SC-01..12; real PO-PDF/MSG extraction (no samples) |
| 2. Shipment Schedule | 🟡 Implemented (build + export) | Week-title parse, order→per-market expansion, value=PCS×FOB, sequential invoice allocation, validation + review routing, UI + job view, **.xlsx download** (Summary layout) | Booking-confirmation PDF parsing; port/country lookup; cut-off/invoice rules (Q-SS-01) |
| 3. Customs Invoice | 🟡 Implemented (build + export) | Per-order/market invoice build: fixed exporter/buyer, market-resolved consignee, HS-coded line items, amount=qty×price, totals, review routing, rendered doc, **.xlsx download** (INVOICE + SUMMARY + BL DRAFT) | numbering + consignee master data (Q-CI-01) |
| 4. PDF Rename | 🟡 Implemented (preview) | CSV ingest (FCR 34 / Bill-of-Export 39 fields), deterministic rename-plan (invoice→target), collision + failed-extraction handling, review routing, UI + job plan view | On-disk rename **execution** (gated preview); canonical filename rule (Q-PR-01) |
| 5. Booking Correction | 🟡 Implemented (diff+verify) | Original↔corrected booking diff, locked-identity vs allowed-field classification, approval-gated corrections, review routing, mock Damco SO verification, diff view | Packing-list PDF parsing; live Damco apply (Q-PORT-01) |
| 6. H&M Portal | ⛔ Blocked | Adapter registered (not configured) | No source files; credentials + field lists |
| 7. Bangladesh Bank | ⛔ Blocked | Adapter registered | No source files; draft/dry-run only |
| 8. Damco Portal | ⛔ Blocked | Adapter registered | No source files; field map |
| 9. Common Requirements | 🟡 Partial | RBAC, audit, reference data, idempotency | Full mapping/calc rules; retention; notifications |

## Verification (actual results, 2026-10-18)

| Check | Result |
|-------|--------|
| `npm run test` (Vitest) | ✅ PASS — 57/57 (pipeline, pdf-rename, shipment-schedule, customs-invoice, booking-correction, handoffs, xlsx export) |
| `npm run typecheck` (tsc) | ✅ PASS — exit 0 |
| `npm run build` (next build) | ✅ PASS — routes compiled (incl. /api/export/*), types valid |
| .xlsx export (live) | ✅ PASS — authenticated downloads return valid .xlsx (ZIP magic PK): Week-43 schedule 7 KB, customs-invoice 66000 OW 8 KB |
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
- Modules 2/3/5 not implemented; 6/7/8 blocked on missing source + credentials.

## Safe next steps

1. Confirm Q-SC-11 (UCP API vs browser) + Q-SC-12 (submission policy) to enable a
   real UCP adapter behind the existing interface.
2. Implement PDF-rename execution from the captured CSV schemas (next cheapest slice).
3. Implement Shipment Schedule using the Week workbook layout + code lookups.
4. Provide field lists/screenshots + least-privilege service credentials for the
   three portals to unblock modules 6–8.
5. Migrate to PostgreSQL for staging; add advisory locks + money precision.
