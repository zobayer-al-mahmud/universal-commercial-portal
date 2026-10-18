# ADR-0001: Technology stack

- Status: Accepted
- Date: 2026-10-18

## Context

The SRS and master prompt suggest a baseline of Next.js (web) + NestJS (API) +
PostgreSQL + a separate Python worker + Playwright. That baseline is explicitly a
*fallback recommendation* to adapt to the local environment. The build must actually
run and be testable in the delivered environment.

Measured environment: Windows 10, Node 24.20, npm 11.19, Python 3.14, git 2.55,
**no Docker**. The project path contains spaces and an em-dash
(`D:\UCP — REQUIRED DATA & FILES\AUCP`), which breaks npm `.bin` cmd shims.

## Decision

- **One application, one language:** Next.js 14 (App Router) + TypeScript modular
  monolith. UI, API (route handlers + server actions), and the Sales Contract domain
  live in one deployable unit with strict internal boundaries.
- **Database:** Prisma ORM. **SQLite** in dev (zero external services — no Docker
  needed); schema is Postgres-portable for staging/production. Versioned migrations;
  no production schema auto-sync.
- **Auth:** credential login, bcrypt hashing, signed JWT session cookie (`jose`).
- **Domain logic:** pure TypeScript functions, unit-tested with Vitest. This is the
  same code a standalone worker would run; it can be lifted into a separate service
  later without rewrite.
- **External integrations:** adapter interface with `mock` / `dryrun` / `live` modes;
  `live` fails closed. Playwright is **not** added until a portal integration is
  authorised (Q-SC-11, Q-PORT-01).
- **npm scripts call `node <entrypoint.js>` directly** to avoid the spaced-path shim bug.

## Consequences

- Runs and tests on the target machine with `npm install` + `npm run setup` + `npm run dev`,
  no Docker, no cloud dependency.
- The SRS's "separate automation server" is satisfied in spirit (clean module
  boundaries) but not in deployment topology. Splitting the worker into its own
  process/service remains an option and is documented as future work.
- SQLite is single-writer; the per-OrderNo advisory-lock concurrency requirement
  (SC-NFR-06) is documented and enforced logically, to be hardened with Postgres
  advisory locks when migrating.
- Python/Playwright/pdftotext/IMAP are deferred until their gating decisions and
  credentials are approved.
