import "server-only";
import { getSystemMetrics, type SystemMetrics } from "./system";
import { getDatabaseHealth, type DatabaseHealth } from "./database";
import { getErrorStats, type ErrorStats } from "./errors";
import { getFailedLoginSummary, getActiveSessions } from "./auth-events";
import { getRunningJobs, type RunningJob } from "@/server/automation/running-jobs";
import { buildAlerts, type Alert } from "./alerts";

/**
 * Lightweight overview snapshot for the Super Admin Control Center's auto-refresh.
 * Runs the cheap collectors in parallel and derives alerts. Heavy, detail-tab data
 * (full user list, log stream, error list) is fetched on demand by its own
 * endpoint so the frequent refresh never does expensive work — "monitoring must
 * not slow down existing UCP processes".
 */

export interface JobsSummary {
  total: number;
  active: number;
  running: number;
  queued: number;
  completed: number;
  failed: number;
  partial: number;
  stopped: number;
  activeJobs: RunningJob[];
}

export interface OverviewSnapshot {
  system: SystemMetrics;
  db: DatabaseHealth;
  jobs: JobsSummary;
  errors: ErrorStats;
  alerts: Alert[];
  auth: { activeSessions: number; failedLogins24h: number };
  at: string;
}

function summarizeJobs(jobs: RunningJob[]): JobsSummary {
  const by = (s: string) => jobs.filter((j) => j.status === s).length;
  return {
    total: jobs.length,
    active: jobs.filter((j) => j.active).length,
    running: by("running"),
    queued: by("queued"),
    completed: by("completed"),
    failed: by("failed"),
    partial: by("partial"),
    stopped: by("stopped"),
    activeJobs: jobs.filter((j) => j.active).slice(0, 20),
  };
}

export async function getOverviewSnapshot(): Promise<OverviewSnapshot> {
  const [system, db, jobs, errors, failedLogins, activeSessions] = await Promise.all([
    getSystemMetrics(),
    getDatabaseHealth(),
    getRunningJobs(80),
    getErrorStats(),
    getFailedLoginSummary(24),
    getActiveSessions(),
  ]);
  const alerts = buildAlerts({ system, db, jobs, errors, failedLogins });
  return {
    system,
    db,
    jobs: summarizeJobs(jobs),
    errors,
    alerts,
    auth: { activeSessions: activeSessions.length, failedLogins24h: failedLogins.reduce((n, f) => n + f.attempts, 0) },
    at: new Date().toISOString(),
  };
}
