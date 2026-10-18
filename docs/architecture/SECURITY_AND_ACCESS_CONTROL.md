# Security and Access Control

## Authentication

- Credential login; passwords hashed with **bcrypt** (cost 10). Plaintext passwords
  are never stored or logged.
- Session = signed **JWT** in an `httpOnly`, `sameSite=lax` cookie (`secure` in
  production), signed with `AUTH_SECRET` via `jose`. TTL from `SESSION_TTL_HOURS`.
- Initial admin is bootstrapped from `BOOTSTRAP_ADMIN_EMAIL/PASSWORD` (one-time seed);
  change it after first login. No universal default password is hardcoded.

## Authorization (RBAC)

Roles → permissions in `src/lib/permissions.ts`; enforced **server-side** in server
actions and page loaders (hiding a button is never the control).

| Role | Capabilities (baseline, least privilege) |
|------|------------------------------------------|
| ADMIN | Everything incl. user/role/reference/integration admin |
| COMMERCIAL | Jobs (create/retry), review resolve, contract approve, audit |
| MERCHANDISER | Create jobs, view jobs, view review queue |
| REVIEWER | View jobs, resolve/reject review tickets |
| VIEWER | Dashboard + read jobs only |

Role-assignment *rules* from the business are not yet confirmed (Q-SC-03, Q-SEC-01);
the baseline is least-privilege and configurable.

## Data protection

- Secrets only via env / secrets manager; `.env` is git-ignored; `.env.example` holds
  placeholders only.
- **Portal credentials from the source checklist are excluded from the repo** and
  should be rotated (they were exposed in a shared document).
- Prisma parameterises all queries (no string-built SQL).
- Uploaded/source files: content-type + filename checks planned; immutable archive
  paths live outside the repo (`var/`, git-ignored).
- Append-only audit records user identity + action for auth, jobs, and review decisions.

## Controls still to harden (documented, not yet enforced)

- CSRF tokens on mutations (server actions are same-origin; add explicit tokens for
  any cross-origin API), security headers, rate limiting.
- Storage-layer immutability (WORM/object-lock) for the archive.
- Secret rotation schedule (SRS: 90-day) and least-privilege service accounts for
  mailbox / UCP / portals.
