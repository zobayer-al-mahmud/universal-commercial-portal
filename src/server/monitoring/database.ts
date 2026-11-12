import "server-only";
import { stat, readdir } from "fs/promises";
import { resolve, dirname, basename, join } from "path";
import { prisma } from "@/lib/db";

/**
 * Database health for the Super Admin Control Center (Database Monitoring).
 *
 * UCP runs on SQLite (an embedded, single-file, single-writer DB), so some
 * server-DB concepts do not apply the way they would on Postgres/MySQL: there is
 * no connection pool, no server-side slow-query log, and no cross-connection
 * transaction counter. We report what is REAL and meaningful for SQLite — file
 * size, journal mode (WAL), page stats, an integrity quick-check, key table row
 * counts, a probe latency, and the latest on-disk backup — and label the engine
 * so the UI never implies metrics SQLite cannot provide. Honest, never mocked.
 */

export interface DatabaseHealth {
  engine: string; // "SQLite (embedded)"
  ok: boolean;
  probeLatencyMs: number | null;
  file: { path: string; sizeBytes: number | null; walSizeBytes: number | null } | null;
  pragma: { journalMode: string | null; pageCount: number | null; pageSize: number | null; freelistPages: number | null };
  integrity: string | null; // "ok" or the first problem
  tables: { name: string; rows: number }[];
  backups: { latest: string | null; latestAgeHours: number | null; count: number } | null;
  note: string;
  at: string;
}

/** Resolve the SQLite file path from DATABASE_URL (file:...). Absolute or relative to cwd. */
function dbFilePath(): string | null {
  const url = process.env.DATABASE_URL || "";
  const m = url.match(/^file:(.*)$/);
  if (!m) return null;
  const p = m[1]!.trim();
  return resolve(process.cwd(), p);
}

async function pragma<T = unknown>(name: string): Promise<T | null> {
  try {
    const rows = (await prisma.$queryRawUnsafe(`PRAGMA ${name};`)) as Record<string, unknown>[];
    const first = rows?.[0];
    if (!first) return null;
    const vals = Object.values(first);
    return (vals[0] as T) ?? null;
  } catch {
    return null;
  }
}

async function tableRowCount(table: string): Promise<number> {
  try {
    const rows = (await prisma.$queryRawUnsafe(`SELECT COUNT(*) AS c FROM "${table}";`)) as { c: bigint | number }[];
    return Number(rows?.[0]?.c ?? 0);
  } catch {
    return 0;
  }
}

async function latestBackup(dbPath: string | null): Promise<DatabaseHealth["backups"]> {
  // Look for *.db / *.bak backups next to the DB and in a sibling "backups" dir.
  const candidates: string[] = [];
  if (dbPath) {
    candidates.push(dirname(dbPath));
    candidates.push(join(dirname(dirname(dbPath)), "backups"));
  }
  let latest: { name: string; mtime: number } | null = null;
  let count = 0;
  for (const dir of candidates) {
    try {
      const entries = await readdir(dir);
      for (const e of entries) {
        if (!/\.(db|bak|sqlite)(\.|$)|\.db\.bak|backup/i.test(e)) continue;
        if (dbPath && e === basename(dbPath)) continue; // the live DB is not a backup
        try {
          const s = await stat(join(dir, e));
          if (!s.isFile()) continue;
          count++;
          if (!latest || s.mtimeMs > latest.mtime) latest = { name: e, mtime: s.mtimeMs };
        } catch {
          /* skip */
        }
      }
    } catch {
      /* dir absent */
    }
  }
  if (!latest) return { latest: null, latestAgeHours: null, count };
  return { latest: latest.name, latestAgeHours: Math.round((Date.now() - latest.mtime) / 3600_000), count };
}

const KEY_TABLES = ["User", "AuditEvent", "AuthEvent", "ErrorEvent", "ExpJob", "ExpJobRow", "ContainerSearch", "BookingDocument", "RenameJobItem"];

export async function getDatabaseHealth(): Promise<DatabaseHealth> {
  const dbPath = dbFilePath();

  // Probe latency + liveness.
  let probeLatencyMs: number | null = null;
  let ok = false;
  try {
    const t0 = Date.now();
    await prisma.$queryRawUnsafe("SELECT 1;");
    probeLatencyMs = Date.now() - t0;
    ok = true;
  } catch {
    ok = false;
  }

  const [journalMode, pageCount, pageSize, freelistPages, integrityRaw] = await Promise.all([
    pragma<string>("journal_mode"),
    pragma<number>("page_count"),
    pragma<number>("page_size"),
    pragma<number>("freelist_count"),
    pragma<string>("quick_check"),
  ]);

  let file: DatabaseHealth["file"] = null;
  if (dbPath) {
    let sizeBytes: number | null = null;
    let walSizeBytes: number | null = null;
    try {
      sizeBytes = (await stat(dbPath)).size;
    } catch {
      /* ignore */
    }
    try {
      walSizeBytes = (await stat(`${dbPath}-wal`)).size;
    } catch {
      walSizeBytes = null;
    }
    file = { path: dbPath, sizeBytes, walSizeBytes };
  }

  const tables = await Promise.all(KEY_TABLES.map(async (name) => ({ name, rows: await tableRowCount(name) })));
  const backups = await latestBackup(dbPath);

  return {
    engine: "SQLite (embedded)",
    ok,
    probeLatencyMs,
    file,
    pragma: {
      journalMode: journalMode ?? null,
      pageCount: pageCount != null ? Number(pageCount) : null,
      pageSize: pageSize != null ? Number(pageSize) : null,
      freelistPages: freelistPages != null ? Number(freelistPages) : null,
    },
    integrity: integrityRaw ?? null,
    tables,
    backups,
    note: "SQLite is embedded and single-writer: there is no connection pool, server-side slow-query log, or cross-connection transaction counter. Metrics shown are the real, applicable ones (size, WAL, pages, integrity, row counts, probe latency, backups).",
    at: new Date().toISOString(),
  };
}
