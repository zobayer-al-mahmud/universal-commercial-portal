# UCP — Linux Production Deployment

This guide covers deploying the Ananta Universal Commercial Portal (UCP) to a
Linux server. All portal automation runs **in the backend** in a **headless
Chromium** browser — nothing opens on any user's screen; users interact only with
the UCP dashboard.

## Architecture (production)

- **Next.js 14** app (server) + **Prisma/SQLite** database.
- **Backend browser automation** (EXP, Damco/Booking, Container) runs server-side
  in headless Chromium, driven over a loopback-only CDP port. Each module uses its
  own Chromium profile + port so sessions never clash. Launch is centralised in
  `src/server/automation/browser-launch.ts` and controlled by env
  (`AUTOMATION_HEADLESS`, `AUTOMATION_BROWSER_PATH`).
- **Runs independently of the frontend**: a job keeps processing after the user
  closes the tab or navigates away (it runs in the server process, UI just polls).
- **Restart recovery**: on boot (`src/instrumentation.ts` → `boot-recovery.ts`)
  any row left mid-run by a crash/restart is reset to a resumable state so the UI
  never shows a phantom "running". It does not auto-drive the live portals.

### Why Chromium, not Firefox
The Container module captures its result PDF via Chromium's CDP `Page.printToPDF`,
which Firefox does not provide; EXP download uses network capture (engine-neutral)
and the APEX form driving works on Chromium. Headless **Chromium** therefore
satisfies "backend, headless, Linux" for every module. `AUTOMATION_BROWSER_ENGINE`
is a forward-compat hook; `firefox` is not wired and must be validated on the host
before use (Container PDF capture would need a Chromium fallback).

---

## Option A — Docker (recommended)

Prerequisites: Docker + Docker Compose on the server.

1. Copy the repo to the server and create `.env` from `.env.example`. Set at least:
   - `AUTH_SECRET` (long random string, 32+ chars)
   - `BOOTSTRAP_ADMIN_PASSWORD` and `RUN_SEED=true` (first deploy only)
   - any live-portal creds + `*_LIVE_ENABLED=true` you want active.
2. Build + start:
   ```bash
   docker compose up -d --build
   ```
   The entrypoint runs `prisma migrate deploy` (creating the DB on the mounted
   `ucp-data` volume) and, when `RUN_SEED=true`, seeds roles/permissions/modules/
   admin. **After the first successful boot, set `RUN_SEED=false` and `docker
   compose up -d` again.**
3. Verify: `curl -f http://localhost:3300/api/health` → `{"status":"ok",...}`.
4. Log in at `http://<host>:3300` with username `admin` + the bootstrap password;
   change it and create real accounts in Administration.

Data (SQLite DB + uploaded Excel + downloaded PDFs) persists in the `ucp-data`
volume. Put a TLS-terminating reverse proxy (nginx/Caddy) in front for HTTPS.

## Option B — systemd on the host

Prerequisites: Node 20+, and Chromium (`apt-get install -y chromium` or Google
Chrome) on the host.

1. Deploy the app to `/opt/ucp`, create a `ucp` system user that owns it.
2. `cd /opt/ucp && npm ci && node node_modules/prisma/build/index.js generate && node node_modules/next/dist/bin/next build`
3. Create `/opt/ucp/.env` (from `.env.example`). Set `AUTOMATION_HEADLESS=true`,
   `AUTOMATION_BROWSER_PATH=/usr/bin/chromium` (or your Chrome path), an absolute
   `DATABASE_URL` + `STORAGE_ROOT` on persistent storage, and secrets.
4. First deploy: `node node_modules/prisma/build/index.js migrate deploy` then
   `RUN_SEED` is not used here — run the seed once: `node node_modules/prisma/build/index.js db seed`.
5. Install the service:
   ```bash
   sudo cp deploy/ucp.service /etc/systemd/system/ucp.service
   sudo systemctl daemon-reload && sudo systemctl enable --now ucp
   systemctl status ucp && journalctl -u ucp -f
   ```

---

## Configuration
All config is environment variables (validated in `src/lib/env.ts`); see
`.env.example` for the full annotated list. Never commit `.env`. Key production
settings: `AUTH_SECRET`, `DATABASE_URL`, `STORAGE_ROOT`, `AUTOMATION_HEADLESS=true`,
`AUTOMATION_BROWSER_PATH`, `INTEGRATION_MODE=live` (+ the per-portal
`*_LIVE_ENABLED` and credentials), and optionally `EXP_AUTO_UPDATE=true`.

## Database: migrations, backups, recovery
- **Migrations**: `prisma migrate deploy` applies `prisma/migrations/*` and creates
  the DB on first run (Docker entrypoint / systemd `ExecStartPre` do this).
  > Note: the local dev `dev.db` carries historical schema drift (some Int columns
  > vs Boolean in schema) that blocks `migrate` there; a **fresh production DB**
  > created by `migrate deploy` is clean. Do not copy the drifted dev DB to prod —
  > start fresh and seed, or reconcile the drift into a migration first.
- **Backups**: `scripts/backup-db.sh` takes an online `sqlite3 .backup` snapshot of
  the DB + a tar of `STORAGE_ROOT`, with rotation. Schedule via cron (example in
  the script header). To restore: stop the app, `gunzip` the chosen `ucp-*.db.gz`
  into place as `DATABASE_URL`'s file, untar storage, start the app.
- **Restart recovery**: automatic (boot-recovery). To additionally auto-resume
  processing on boot, `AUTOMATION_RESUME_ON_BOOT` is reserved for that (currently
  park-only; resume is operator-initiated).

## Health, logs, monitoring
- Health probe: `GET /api/health` (200 healthy / 503 DB down). Wired into the
  Docker `HEALTHCHECK`; point your load balancer / uptime monitor at it.
- Logs: container → `docker compose logs -f ucp`; systemd → `journalctl -u ucp -f`.

## Maintenance
- **Upgrade**: pull new code → `docker compose up -d --build` (Docker) or rebuild +
  `systemctl restart ucp` (systemd). Migrations apply automatically on boot.
- **Rotate secrets/credentials**: edit `.env`, restart the service.
- **Storage growth**: downloaded PDFs accumulate under `STORAGE_ROOT`; include it in
  backups and prune old job artifacts as needed.
- **Browser updates**: rebuild the image (Docker) or `apt upgrade chromium`
  (systemd) periodically.
