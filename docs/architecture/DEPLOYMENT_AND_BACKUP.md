# Deployment and Backup

## Environments

| Env | DB | Integration mode | Notes |
|-----|----|------------------|-------|
| dev | SQLite (`prisma/dev.db`) | `mock` | self-contained; no Docker |
| staging | PostgreSQL | `dryrun` | real schema, no live writes |
| production | PostgreSQL | `live` per adapter | only after Q-SC-11/Q-PORT-01 approved |

## Build & run

```bash
npm install
npm run setup     # prisma migrate deploy + seed
npm run build
npm run start     # or: npm run dev for local
```

Config comes entirely from env (`.env.example`). Production schema changes go through
`prisma migrate deploy` (versioned migrations); **no auto schema sync**.

## Backup & retention (SRS §5.12)

- **Database:** nightly logical dump + WAL archiving (Postgres); 30 days local, 1 year
  off-site.
- **Archive object store:** WORM lifecycle / object-lock; **7-year** retention aligned
  with customs/export-document policy.
- **Audit log:** append-only, 7-year retention.

## Health & monitoring (SRS §5.9, §5.11)

- `GET /api/healthz` — liveness. `GET /api/readyz` — readiness (checks DB).
- Metrics to add: `jobs_total{status}`, extract/portal latency, review-queue depth.
- Alerts: queue depth > N, failure rate > M%/15min, portal latency p95, restart loop.

## Rollback (SRS §5.13)

- Blue/green or canary; keep the previous version one week; code + config versioned
  together. SQLite dev → Postgres prod migration path in
  [DATA_MODEL.md](./DATA_MODEL.md).

## Runbooks

See `docs/runbooks/` for backup/restore, migration, worker restart, secret rotation,
and incident procedures (to be expanded as modules go live).
