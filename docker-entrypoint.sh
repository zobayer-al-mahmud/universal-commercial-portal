#!/bin/sh
# UCP container entrypoint: ensure storage, apply DB migrations, optionally seed
# on first deploy, then run the app (CMD).
set -e

mkdir -p "${STORAGE_ROOT:-/data/storage}"

# Apply all pending migrations. On a fresh volume this also CREATES the database.
echo "[entrypoint] applying database migrations…"
node node_modules/prisma/build/index.js migrate deploy

# First-deploy seed (roles, permissions, modules, reference data, bootstrap
# admin). Idempotent upserts, but gated so it does not run on every restart.
# Set RUN_SEED=true (and BOOTSTRAP_ADMIN_USERNAME/PASSWORD) on the first deploy.
if [ "${RUN_SEED:-false}" = "true" ]; then
  echo "[entrypoint] seeding database…"
  node node_modules/prisma/build/index.js db seed || echo "[entrypoint] seed skipped/failed (continuing)"
fi

echo "[entrypoint] starting UCP…"
exec "$@"
