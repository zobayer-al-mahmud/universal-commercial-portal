# Operations Runbook

## First-time setup (fresh checkout)

```bash
npm install
cp .env.example .env            # PowerShell: Copy-Item .env.example .env
# edit .env: set AUTH_SECRET (32+ chars) and BOOTSTRAP_ADMIN_PASSWORD
npm run db:migrate              # creates DB + applies migrations
npm run db:seed                 # roles, permissions, modules, admin
npm run dev
```

## Reset the dev database

```bash
npm run db:reset                # drops + re-migrates; re-run db:seed
npm run db:seed
```

## Run the test suite / checks

```bash
npm run test
npm run typecheck
npm run build
```

## Backup / restore (production, PostgreSQL)

- Backup: `pg_dump` nightly + WAL archive. Keep 30d local, 1y off-site.
- Restore: provision DB, `pg_restore`, then `npm run db:migrate` (deploy) to reconcile.
- Archive object store: object-lock/WORM; never delete within the 7-year window.

## Rotate secrets

1. Generate new `AUTH_SECRET` / integration tokens in the secrets manager.
2. Update env for the running service; restart.
3. Rotating `AUTH_SECRET` invalidates existing sessions (users re-login) — expected.
4. **Rotate the portal passwords exposed in the source checklist immediately.**

## Enable a real integration (gated)

1. Resolve the decision (Q-SC-11 for UCP; Q-PORT-01 for a portal).
2. Add credentials to the secrets manager (least privilege).
3. Implement the `live` branch of the adapter with pre-write verify + post-write
   read-back; test against a sandbox.
4. Set `INTEGRATION_MODE=live` (and `AUTO_SUBMIT` only if the business authorises it).

## Incident: stuck / failed jobs

- Inspect in **Jobs** (filter by `failed`/`queued`) and the job's stage history.
- Failed read-back → do **not** blindly retry; verify the destination first (§7.5).
- Clear blocking exceptions in the **Review Queue**; resolving all open tickets for a
  queued job moves it back to `draft`.
```
