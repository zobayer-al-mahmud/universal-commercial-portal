# CLAUDE.md — project rules for AUCP

## What this is
Ananta Universal Commercial Portal: a Next.js 14 + TypeScript modular monolith that
automates AGL's commercial workflows (Sales Contract first). Built from the read-only
source set in `D:\UCP — REQUIRED DATA & FILES` (folders 1–9 + checklist).

## Non-negotiables
- **Never modify the source folders** (`1.`–`9.`, the checklist). They are read-only
  evidence. This app lives only under `AUCP/`.
- **Never commit secrets or business documents.** `.env`, `var/`, and source files are
  git-ignored. Portal credentials from the checklist stay out of the repo.
- **Fail closed** on consequential actions. No destination write for a record with a
  hard validation failure (BR-SC-27). Live integrations (`INTEGRATION_MODE=live`) are
  not implemented and must stay gated until the relevant decision + credentials exist.
- **Evidence over assumption.** Tie business rules to a source (SRS section, workbook,
  CSV). Mark unknowns as `DECISION REQUIRED`; don't invent values.

## Windows / path gotcha
The repo path has spaces + an em-dash, which breaks npm `.bin` shims. Scripts call
`node <entrypoint.js>` directly (see `package.json`). Do the same for ad-hoc commands.

## Folder map
- `src/app/(portal)/**` — authenticated UI (server components; real data only).
- `src/app/actions/**` — server actions (always check permissions server-side).
- `src/server/sales-contract/**` — **pure** domain logic: `parse`→`normalize`→`validate`→`reconcile`→`pipeline`; `intake.ts` persists.
- `src/server/integrations/**` — adapters (mock/dryrun/live; live fails closed).
- `src/lib/**` — env, db, auth, permissions, audit.
- `prisma/**` — schema, migrations, seed.
- `tests/**` — Vitest (pure logic). `docs/**` — analysis + architecture.

## Conventions
- Keep extraction side-effect-free; only `intake.ts` and adapters do I/O.
- Append-only: `SalesContractRow`, `JobStageEvent`, `AuditEvent` are insert-only.
- New business rules → add a test in `tests/` and a traceability row.
- Run `npm run typecheck` and `npm run test` before considering a change done.

## Key commands
`npm run dev` · `npm run test` · `npm run typecheck` · `npm run build` ·
`npm run db:migrate` · `npm run db:seed`

## Source of truth
SRS: `../SRS_Sales_Contract_Creation.docx` (UCP-SRS-SC-001). Decision register:
`docs/source-analysis/BUSINESS_DECISIONS_REQUIRED.md`. Stack rationale:
`docs/architecture/architecture-decisions/ADR-0001-stack.md`.
