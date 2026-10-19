# Ananta Universal Commercial Portal — Final Implementation Report

Date: 2026-10-19 · Repo HEAD: `ad23970` · 121 tracked files · 10 commits

---

## 1. Project location

```
D:\UCP — REQUIRED DATA & FILES\AUCP
```

A local git repository (branch `main`). Built from the read-only source set in
`D:\UCP — REQUIRED DATA & FILES` (folders 1–9 + checklist). No source file was
modified; no secret or business document was committed.

## 2. Source analysis coverage

- **835** source files inventoried and SHA-256 hashed ([`source-inventory.csv`](./source-analysis/source-inventory.csv)). **0** duplicate copies.
- Types: 742 PDF, 63 XLSX, 26 MSG, 2 CSV, 1 PNG, 1 DOCX, 1 ZIP.
- **Fully analyzed:** both Word docs, both CSVs, the logo, and the representative/sampled workbooks that drove implementation (modules 1–4).
- **Partially analyzed (metadata/structure):** the 742 bulk PDFs and remaining workbooks — filenames, folder structure, and representative samples; their field requirements are fully captured in the SRS / CSV schemas / workbook layouts.
- **Unreadable:** 0. **Excluded:** live portal credentials inside the checklist (kept out of the repo).
- **Missing folders:** areas **6 (H&M), 7 (Bangladesh Bank), 8 (Damco), 9 (Common Requirements)** contain **no files** — requirements are known only from the checklist.

See [`SOURCE_INVENTORY`](./source-analysis/SOURCE_INVENTORY.md), [`SOURCE_COVERAGE`](./source-analysis/SOURCE_COVERAGE.md), [`FILE_ANALYSIS_LOG`](./source-analysis/FILE_ANALYSIS_LOG.md), [`REQUIREMENTS_BY_MODULE`](./source-analysis/REQUIREMENTS_BY_MODULE.md).

## 3. Modules implemented

| # | Module | Status | What works |
|---|--------|--------|-----------|
| 1 | Sales Contract Creation | ✅ implemented | Order-package intake, 3-PDF rule, parse→normalize→validate→reconcile, per-contract aggregation, review routing, idempotency, mock UCP save + read-back, append-only audit |
| 2 | Week Wise Shipment Schedule | ✅ implemented | Week-title parse, order→per-market expansion, value=PCS×FOB, sequential invoice allocation, validation + review, **.xlsx export** |
| 3 | Customs Invoice Generation | ✅ implemented | Per-order/market invoice build, market-resolved consignee, HS-coded line items, totals, rendered doc, **.xlsx export (INVOICE + SUMMARY + BL DRAFT)** |
| 4 | PDF File Rename | ✅ implemented | CSV ingest (FCR 34 / Bill-of-Export 39 fields), deterministic rename plan, collision handling, **gated on-disk apply** (copy, originals preserved) |
| 5 | Booking Correction | ✅ implemented | Original↔corrected diff, locked-identity vs allowed-field classification, approval gate, mock Damco SO verify |
| — | **Cross-module pipeline** | ✅ implemented | Confirm contract → build schedule from contracts → generate invoice from schedule line; link fields prevent double-processing |
| 6 | H&M Portal | ⛔ blocked | No source files; adapter registered (not configured). Needs field lists + authorised credentials |
| 7 | Bangladesh Bank Portal | ⛔ blocked | No source files; banking actions default to draft/dry-run |
| 8 | Damco Portal | ⛔ blocked | No source files; Damco adapter exists (mock verify) but live is fail-closed |
| 9 | Common Requirements | 🟡 partial | RBAC, audit, reference data, idempotency, review queue delivered at platform level |

Platform: authentication + RBAC, dashboard with live counts, durable job ledger +
state machine, review queue, append-only audit, admin pages, health probes.

## 4. Architecture and key decisions

- **Stack:** Next.js 14 (App Router) + TypeScript modular monolith; Prisma ORM with
  **SQLite (dev)**, Postgres-portable; bcrypt + JWT sessions; Vitest.
- **Why not the SRS's Next+Nest+Postgres+Python split:** no Docker on the target
  machine and the build must run/test self-contained. Domain logic is pure
  TypeScript, liftable into a standalone worker later. See
  [ADR-0001](./architecture/architecture-decisions/ADR-0001-stack.md).
- **Separation:** extraction (pure) → normalization → deterministic validation →
  reconciliation → persistence (intake services) → adapters (external). Only intake
  services write the DB; only adapters touch external systems.
- **Integrations:** adapter interface with `mock`/`dryrun`/`live`; **live fails
  closed**. UCP + Damco adapters implemented in mock.
- **7 versioned migrations** (no production auto-sync):
  `init`, `add_rename_item`, `add_shipment_schedule_line`, `add_customs_invoice`,
  `add_booking_correction`, `add_crossmodule_links`, `add_rename_applied`.

See [`SYSTEM_ARCHITECTURE`](./architecture/SYSTEM_ARCHITECTURE.md), [`DATA_MODEL`](./architecture/DATA_MODEL.md), [`JOB_STATE_MACHINES`](./architecture/JOB_STATE_MACHINES.md), [`INTEGRATION_ADAPTERS`](./architecture/INTEGRATION_ADAPTERS.md), [`CROSS_MODULE_WORKFLOW_MAP`](./source-analysis/CROSS_MODULE_WORKFLOW_MAP.md).

## 5. Run commands (Windows)

> The install path contains spaces, which breaks npm `.bin` shims, so the scripts
> call `node <entrypoint.js>` directly.

```bash
npm install
Copy-Item .env.example .env   # then set AUTH_SECRET and BOOTSTRAP_ADMIN_PASSWORD
npm run db:migrate            # apply migrations (creates the SQLite DB)
npm run db:seed               # roles, permissions, modules, admin, reference data
npm run dev                   # http://localhost:3000 (testing used -p 3300)
```

Other: `npm run test` · `npm run typecheck` · `npm run build` · `npm run db:reset`.
Health: `GET /api/healthz`, `GET /api/readyz`. Default dev admin: `admin@ananta.com.bd`.

## 6. Verification results

| Check | Result |
|-------|--------|
| `npm run test` (Vitest) | **PASS** — 59/59 across 10 files |
| `npm run typecheck` (tsc) | **PASS** — exit 0 |
| `npm run build` (next build) | **PASS** — all routes compiled, types valid |
| DB migrate + seed | **PASS** — 7 migrations applied; seed OK |
| Live smoke (port 3300) | **PASS** — login, dashboard, all 5 modules, full cross-module chain, .xlsx downloads, PDF-rename dry-run + apply, review queue |
| Live external integrations (UCP/H&M/BB/Damco) | **BLOCKED** — disabled by design; require authorization + credentials |

End-to-end chain verified live: contract **644637-8756** → Week 43 schedule
(invoices 66000/66001, markets OW/CL) → customs invoice **66000 OW** (qty 2500 /
USD 26250 carried through; missing OW consignee correctly flagged for review).

## 7. Business decisions needed (high-priority)

Full register: [`BUSINESS_DECISIONS_REQUIRED`](./source-analysis/BUSINESS_DECISIONS_REQUIRED.md). Each fails closed until resolved.

- **Q-SC-11 / Q-SC-12** — UCP integration path (API vs browser) and submission policy (auto-submit vs draft-then-approve). Currently mock + save-as-draft.
- **Q-SC-01 / Q-SC-02** — per-contract Unit Price and Time-of-Delivery rules when markets differ. Currently flagged pending.
- **Q-SC-03 / Q-SC-06** — Buyer-Code assignment and closed enum lists. Currently observed-sample reference data.
- **Q-SS-01 / Q-CI-01 / Q-PR-01** — schedule cut-off/invoice allocation, customs consignee master data, canonical rename filename pattern.
- **Q-PORT-01** — in-scope processes, field maps, and authorization for the three portals.

## 8. Security and live-integration status

- **All live integrations disabled** (`INTEGRATION_MODE=mock`); `live` fails closed.
- Passwords hashed (bcrypt); JWT session cookies; server-side RBAC on every mutation;
  Prisma parameterised queries; `.env`, `var/`, `dev.db` git-ignored.
- **Portal credentials from the source checklist are excluded from the repo and
  should be rotated** — they were exposed in a shared document.
- Still to harden before production: PostgreSQL + money precision + advisory locks,
  CSRF tokens, security headers, rate limiting, storage-layer WORM/retention,
  least-privilege service accounts.

## 9. Key files

- [`README.md`](../README.md) · [`CLAUDE.md`](../CLAUDE.md) · [`IMPLEMENTATION_STATUS.md`](../IMPLEMENTATION_STATUS.md)
- Source analysis pack: [`docs/source-analysis/`](./source-analysis/) (inventory, coverage, requirements, traceability, conflicts, decisions, workflow map)
- Architecture + ADR: [`docs/architecture/`](./architecture/)
- Runbook: [`docs/runbooks/OPERATIONS.md`](./runbooks/OPERATIONS.md)
- Domain code: `src/server/{sales-contract,shipment-schedule,customs-invoice,pdf-rename,booking-correction,handoffs,export,integrations}/`

## 10. Safe next steps

1. Resolve Q-SC-11/12 to implement a real UCP adapter behind the existing interface.
2. Provide field lists/screenshots + least-privilege credentials to unblock the three portals.
3. Migrate to PostgreSQL (advisory locks, `NUMERIC(14,2)` money) for staging.
4. Wire remaining handoffs (invoice/export → PDF rename; booking) and add the
   customs-invoice BL/export polish as the business confirms layouts.
