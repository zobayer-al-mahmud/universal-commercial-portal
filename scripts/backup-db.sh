#!/usr/bin/env bash
# Online, consistent backup of the UCP SQLite database (safe while the app runs)
# plus a copy of the storage tree. Keeps the last N backups.
#
#   DB_FILE=/data/ucp.db STORAGE_ROOT=/data/storage BACKUP_DIR=/data/backups \
#   KEEP=14 ./scripts/backup-db.sh
#
# Schedule via cron, e.g. daily at 01:30:
#   30 1 * * * DB_FILE=/data/ucp.db BACKUP_DIR=/data/backups /opt/ucp/scripts/backup-db.sh
set -euo pipefail

DB_FILE="${DB_FILE:-/data/ucp.db}"
STORAGE_ROOT="${STORAGE_ROOT:-/data/storage}"
BACKUP_DIR="${BACKUP_DIR:-/data/backups}"
KEEP="${KEEP:-14}"
TS="$(date +%Y%m%d-%H%M%S)"

mkdir -p "$BACKUP_DIR"

if [ ! -f "$DB_FILE" ]; then
  echo "backup-db: database not found at $DB_FILE" >&2
  exit 1
fi

DB_OUT="$BACKUP_DIR/ucp-$TS.db"
# .backup takes a consistent snapshot even while the DB is in use (preferred).
if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$DB_FILE" ".backup '$DB_OUT'"
else
  # Fallback: copy the file + WAL/SHM if present (stop the app first for safety).
  cp "$DB_FILE" "$DB_OUT"
  [ -f "${DB_FILE}-wal" ] && cp "${DB_FILE}-wal" "${DB_OUT}-wal" || true
  [ -f "${DB_FILE}-shm" ] && cp "${DB_FILE}-shm" "${DB_OUT}-shm" || true
fi
gzip -f "$DB_OUT"
echo "backup-db: wrote ${DB_OUT}.gz"

# Storage tree (uploaded Excel + downloaded PDFs).
if [ -d "$STORAGE_ROOT" ]; then
  STORE_OUT="$BACKUP_DIR/storage-$TS.tar.gz"
  tar -czf "$STORE_OUT" -C "$(dirname "$STORAGE_ROOT")" "$(basename "$STORAGE_ROOT")"
  echo "backup-db: wrote $STORE_OUT"
fi

# Rotate: keep the newest $KEEP of each kind.
ls -1t "$BACKUP_DIR"/ucp-*.db.gz 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -r rm -f
ls -1t "$BACKUP_DIR"/storage-*.tar.gz 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -r rm -f
echo "backup-db: done (kept last $KEEP)."
