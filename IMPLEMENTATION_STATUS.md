# Implementation Status

Updated: 2026-10-18. Statuses reflect what is actually implemented and verified.

## Milestones

| Milestone | Status | Notes |
|-----------|--------|-------|
| A. Source analysis | ✅ Done | 835 files inventoried + hashed; SRS + checklist + modules 1–5 analyzed; decision register written |
| B. Project foundation | ✅ Done | Next.js + Prisma + SQLite; migration applied; auth + RBAC; health probes; config validation |
| C. Shared workflow infra | ✅ Done | Document intake + hashing, job ledger + state machine, review queue, audit trail, reference data, adapter interface |
| D. Module vertical slices | 🟡 Partial | 5 of 9 modules functional (Sales Contract, PDF-rename, Shipment Schedule, Customs Invoice, Booking Correction) — implemented + tested; H&M / BB / Damco portals blocked (no source files) |
| E. Cross-module workflow | 🟠 Specified | Dependency map documented; gating implemented within Sales Contract only |
| F. QA / hardening | 🟡 Partial | Unit tests + typecheck + build pass; live-integration tests out of scope (gated) |

## Per-module

| Module | Status | Implemented | Blocked / pending |
|--------|--------|-------------|-------------------|
| 1. Sales Contract | ✅ Implemented | Intake, 3-PDF rule, parse/normalize/validate, per-contract aggregation, review routing, idempotency, mock UCP save + read-back, audit, UI | Q-SC-01..12; real PO-PDF/MSG extraction (no samples) |
| 2. Shipment Schedule | 🟡 Implemented (build) | Week-title parse, order→per-market expansion, value=PCS×FOB, sequential invoice allocation, validation + review routing, UI + job schedule view | Booking-confirmation PDF parsing; port/country lookup; cut-off/invoice rules (Q-SS-01) |
| 3. Customs Invoice | 🟡 Implemented (build) | Per-order/market invoice build: fixed exporter/buyer, market-resolved consignee, HS-coded line items, amount=qty×price, totals, validation + review routing, rendered invoice doc | xlsx export (SUMMARY/BL DRAFT); numbering + consignee master data (Q-CI-01) |
| 4. PDF Rename | 🟡 Implemented (preview) | CSV ingest (FCR 34 / Bill-of-Export 39 fields), deterministic rename-plan (invoice→target), collision + failed-extraction handling, review routing, UI + job plan view | On-disk rename **execution** (gated preview); canonical filename rule (Q-PR-01) |
| 5. Booking Correction | 🟡 Implemented (diff+verify) | Original↔corrected booking diff, locked-identity vs allowed-field classification, approval-gated corrections, review routing, mock Damco SO verification, diff view | Packing-list PDF parsing; live Damco apply (Q-PORT-01) |
| 6. H&M Portal | ⛔ Blocked | Adapter registered (not configured) | No source files; credentials + field lists |
| 7. Bangladesh Bank | ⛔ Blocked | Adapter registered | No source files; draft/dry-run only |
| 8. Damco Portal | ⛔ Blocked | Adapter registered | No source files; field map |
| 9. Common Requirements | 🟡 Partial | RBAC, audit, reference data, idempotency | Full mapping/calc rules; retention; notifications |

## Verification (actual results, 2026-10-18)

| Check | Result |
|-------|--------|
| `npm run test` (Vitest) | ✅ PASS — 52/52 (sales-contract pipeline, pdf-rename, shipment-schedule, customs-invoice, booking-correction) |
| `npm run typecheck` (tsc) | ✅ PASS — exit 0 |
| `npm run build` (next build) | ✅ PASS — 13 routes compiled, types valid |
| DB migrate + seed | ✅ PASS — 5 migrations (init, rename, schedule, customs-invoice, booking-correction) applied; roles/modules/admin/reference seeded |
| Live app smoke test (port 3300) | ✅ PASS — Sales Contract intake → draft + mock UCP read-back, missing-PDF → queued review, PDF-rename plan, Week 43 schedule, Customs Invoice 45901 NH (total USD 825), Booking Correction 698757 VN (3 allowed changes, mock Damco verify), job detail views, review-queue |
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
