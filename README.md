# Ananta Universal Commercial Portal (AUCP)

Internal commercial-automation portal for **Ananta Garments Ltd.** It automates the
commercial department's document workflows between H&M and AGL — starting with
**Sales Contract Creation** — with a human review queue, append-only audit trail, and
fail-closed external integrations.

> Built from the source material in `D:\UCP — REQUIRED DATA & FILES` (folders 1–9 +
> checklist). Those folders are **read-only**; this app lives only in `AUCP/`.

## Status at a glance

| Area | Status |
|------|--------|
| Platform (auth, RBAC, jobs, review queue, audit, dashboard) | ✅ implemented |
| Sales Contract Creation (intake → extract → reconcile → draft → mock UCP) | ✅ implemented + tested |
| PDF File Rename | 🟡 CSV → rename-plan preview implemented + tested; on-disk apply gated |
| Week Wise Shipment Schedule | 🟡 schedule build (order→market lines, invoices) implemented + tested |
| Customs Invoice Generation | 🟡 per-order invoice build (consignee, HS line items, totals) implemented + tested |
| Booking Correction | 🟡 original↔corrected diff + approval gate + mock Damco verify implemented + tested |
| H&M / Bangladesh Bank / Damco portals | ⛔ blocked (no source files; credentials required) |

See [`IMPLEMENTATION_STATUS.md`](./IMPLEMENTATION_STATUS.md) for detail.

## Tech stack

Next.js 14 (App Router) + TypeScript · Prisma (SQLite dev / PostgreSQL prod) ·
bcrypt + JWT sessions · Vitest. One language, one deployable unit, no Docker required.
Rationale: [ADR-0001](./docs/architecture/architecture-decisions/ADR-0001-stack.md).

## Prerequisites

- Node 20+ (tested on Node 24.20), npm 10+.
- No database server needed for dev (SQLite file).

> **Windows note:** the install path contains spaces, which breaks npm's `.bin` cmd
> shims. All `package.json` scripts call `node <entrypoint.js>` directly to avoid this.
> If you run a tool manually, use e.g. `node node_modules/prisma/build/index.js …`.

## Setup & run

```bash
# 1. install dependencies
npm install

# 2. create .env (copy the example and adjust)
#    on Windows PowerShell: Copy-Item .env.example .env
cp .env.example .env

# 3. apply migrations + seed roles, modules, admin
npm run db:migrate      # first time: creates the SQLite DB + migration
npm run db:seed         # seeds roles/permissions/modules/admin from BOOTSTRAP_ADMIN_*

# 4. run
npm run dev             # http://localhost:3000  (this repo used -p 3300 in testing)
```

Default dev admin (change after first login): `admin@ananta.com.bd` / value of
`BOOTSTRAP_ADMIN_PASSWORD` in `.env`.

## Commands

| Command | What it does |
|---------|--------------|
| `npm run dev` | Start the dev server |
| `npm run build` / `npm run start` | Production build / serve |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run test` | Vitest unit suite (pipeline, parser, validation) |
| `npm run db:migrate` / `db:seed` / `db:reset` | Database lifecycle |
| `npm run setup` | `migrate deploy` + seed (CI / fresh deploy) |

Health probes: `GET /api/healthz`, `GET /api/readyz`.

## Try the Sales Contract flow

1. Sign in → **Modules → Sales Contract Creation**.
2. The intake form is pre-filled with a sanitized sample Order Package. Click
   **Run intake**.
3. You'll get a draft job: PO EXTRACTION rows, an aggregated contract row
   (qty summed, value computed), and a mock UCP save + read-back. Remove a PDF from
   the attachment list or break the PO number to see it routed to the **Review Queue**
   instead — no destination write happens for a failed record.

## Key files

- Source analysis pack: [`docs/source-analysis/`](./docs/source-analysis/)
- Architecture + ADRs: [`docs/architecture/`](./docs/architecture/)
- Sales Contract engine: `src/server/sales-contract/`
- Decision register: [`docs/source-analysis/BUSINESS_DECISIONS_REQUIRED.md`](./docs/source-analysis/BUSINESS_DECISIONS_REQUIRED.md)

## Safety

- Live portal/UCP integrations are **disabled by default** (`INTEGRATION_MODE=mock`)
  and fail closed.
- Portal credentials present in the source checklist are **excluded** from this repo
  and should be rotated.
- No source file is modified; no business document content is committed.
