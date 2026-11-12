import "server-only";
import type { SystemMetrics } from "./system";
import type { DatabaseHealth } from "./database";
import type { RunningJob } from "@/server/automation/running-jobs";
import type { ErrorStats } from "./errors";
import type { FailedLoginSummary } from "./auth-events";

/**
 * Derived alerts for the Super Admin Control Center. Pure function over the
 * already-collected metrics (no extra DB/system work), so it adds no load. Each
 * alert says what is wrong, how severe, and points at the area to act on — the
 * "what action is needed" the goal calls for.
 */

export type AlertSeverity = "warning" | "critical";

export interface Alert {
  id: string;
  severity: AlertSeverity;
  area: string; // cpu | memory | disk | database | process | error | security | service
  title: string;
  detail: string;
}

/** A job is "stuck" if it is marked active but has had no activity for this long. */
const STUCK_MINUTES = 20;

export function buildAlerts(input: {
  system: SystemMetrics;
  db: DatabaseHealth;
  jobs: RunningJob[];
  errors: ErrorStats;
  failedLogins: FailedLoginSummary[];
}): Alert[] {
  const a: Alert[] = [];
  const { system, db, jobs, errors, failedLogins } = input;

  // CPU
  if (system.cpu.usagePct != null) {
    if (system.cpu.usagePct >= 90) a.push({ id: "cpu", severity: "critical", area: "cpu", title: "CPU usage critical", detail: `CPU at ${system.cpu.usagePct}% (load ${system.cpu.loadAvg1} on ${system.cpu.cores} cores).` });
    else if (system.cpu.usagePct >= 75) a.push({ id: "cpu", severity: "warning", area: "cpu", title: "CPU usage high", detail: `CPU at ${system.cpu.usagePct}% (load ${system.cpu.loadAvg1}).` });
  }
  // Memory
  if (system.memory.usedPct >= 90) a.push({ id: "mem", severity: "critical", area: "memory", title: "Memory usage critical", detail: `RAM at ${system.memory.usedPct}% used.` });
  else if (system.memory.usedPct >= 80) a.push({ id: "mem", severity: "warning", area: "memory", title: "Memory usage high", detail: `RAM at ${system.memory.usedPct}% used.` });
  // Disk
  if (system.disk) {
    if (system.disk.usedPct >= 90) a.push({ id: "disk", severity: "critical", area: "disk", title: "Disk almost full", detail: `Disk at ${system.disk.usedPct}% on ${system.disk.path}.` });
    else if (system.disk.usedPct >= 80) a.push({ id: "disk", severity: "warning", area: "disk", title: "Disk usage high", detail: `Disk at ${system.disk.usedPct}% on ${system.disk.path}.` });
  }
  // Database
  if (!db.ok) a.push({ id: "db-down", severity: "critical", area: "database", title: "Database not responding", detail: "A probe query against the database failed." });
  if (db.integrity && db.integrity.toLowerCase() !== "ok") a.push({ id: "db-integrity", severity: "critical", area: "database", title: "Database integrity check failed", detail: `quick_check: ${db.integrity.slice(0, 200)}` });
  if (db.file?.walSizeBytes != null && db.file.walSizeBytes > 256 * 1024 * 1024) a.push({ id: "db-wal", severity: "warning", area: "database", title: "WAL file large", detail: `WAL is ${(db.file.walSizeBytes / 1048576).toFixed(0)} MB — a checkpoint may be overdue.` });
  if (db.backups && db.backups.latestAgeHours != null && db.backups.latestAgeHours > 48) a.push({ id: "db-backup", severity: "warning", area: "database", title: "Backup is stale", detail: `Latest backup is ${db.backups.latestAgeHours}h old.` });

  // Stuck processes
  const now = Date.now();
  for (const j of jobs) {
    if (!j.active) continue;
    const idleMin = Math.round((now - new Date(j.lastActivity).getTime()) / 60000);
    if (idleMin >= STUCK_MINUTES) a.push({ id: `stuck:${j.key}`, severity: "warning", area: "process", title: `Possibly stuck ${j.module} job`, detail: `"${j.batch}" is ${j.status} but has had no activity for ${idleMin} min (${j.processed}/${j.total}).` });
  }

  // Errors
  if (errors.critical > 0) a.push({ id: "err-crit", severity: "critical", area: "error", title: `${errors.critical} critical error(s)`, detail: `${errors.critical} unresolved critical error(s); ${errors.last24h} error event(s) in the last 24h.` });
  else if (errors.last24h >= 20) a.push({ id: "err-rate", severity: "warning", area: "error", title: "Elevated error rate", detail: `${errors.last24h} error event(s) in the last 24h; ${errors.openTotal} unresolved.` });

  // Security: failed-login spikes
  const brute = failedLogins.filter((f) => f.attempts >= 5);
  for (const f of brute) a.push({ id: `brute:${f.username}`, severity: "warning", area: "security", title: "Repeated failed logins", detail: `${f.attempts} failed login attempts for "${f.username}" in 24h (last IP ${f.lastIp || "unknown"}).` });

  // Most severe first.
  a.sort((x, y) => (x.severity === y.severity ? 0 : x.severity === "critical" ? -1 : 1));
  return a;
}
