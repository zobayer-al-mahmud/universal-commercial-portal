import "server-only";
import { prisma } from "@/lib/db";

/**
 * Unified system-log feed for the Super Admin Control Center (System Logs).
 *
 * Phase 1 merges the logs UCP already produces inside the app, into one
 * searchable, date-ranged, source/level-filterable stream:
 *   - audit      → AuditEvent (admin + auth + workflow actions)
 *   - error      → ErrorEvent (captured application/automation errors)
 *   - automation → per-module worker event tables (exp / booking / container /
 *                  pdf-rename / intake) — the real "worker/automation logs".
 * (Phase 2 will add raw server/journald + API-request logs.)
 */

export type LogLevel = "info" | "warn" | "error" | "critical";

export interface LogEntry {
  id: string;
  source: string; // audit | error | exp | booking | container | pdf-rename | intake
  level: LogLevel;
  stage: string; // step/stage/action
  message: string;
  actor: string;
  at: string;
}

export interface LogQuery {
  source?: string;
  level?: LogLevel;
  search?: string;
  since?: Date;
  until?: Date;
  limit?: number;
}

function levelFromStatus(status: string): LogLevel {
  const s = (status || "").toLowerCase();
  if (s === "failed" || s === "error") return "error";
  if (s === "skipped" || s === "warn" || s === "warning") return "warn";
  return "info";
}

function dateWhere(q: LogQuery) {
  if (!q.since && !q.until) return undefined;
  return { ...(q.since ? { gte: q.since } : {}), ...(q.until ? { lte: q.until } : {}) };
}

/** The distinct sources, for the UI's source filter. */
export const LOG_SOURCES = ["audit", "error", "exp", "booking", "container", "pdf-rename", "intake"] as const;

export async function getUnifiedLogs(q: LogQuery = {}): Promise<LogEntry[]> {
  const take = Math.min(Math.max(q.limit ?? 300, 1), 2000);
  const perSource = Math.min(take, 500);
  const createdAt = dateWhere(q);
  const wantSource = (s: string) => !q.source || q.source === s;
  const msgContains = q.search ? { contains: q.search } : undefined;

  const tasks: Promise<LogEntry[]>[] = [];

  if (wantSource("audit")) {
    tasks.push(
      prisma.auditEvent
        .findMany({ where: { ...(createdAt ? { createdAt } : {}), ...(msgContains ? { action: msgContains } : {}) }, orderBy: { createdAt: "desc" }, take: perSource })
        .then((rows) => rows.map((r) => ({ id: `audit:${r.id}`, source: "audit", level: "info" as LogLevel, stage: `${r.entityType}.${r.action}`, message: r.dataJson && r.dataJson !== "{}" ? r.dataJson.slice(0, 300) : r.action, actor: r.actor, at: r.createdAt.toISOString() }))),
    );
  }
  if (wantSource("error")) {
    tasks.push(
      prisma.errorEvent
        .findMany({ where: { ...(createdAt ? { lastSeen: createdAt } : {}), ...(msgContains ? { message: msgContains } : {}) }, orderBy: { lastSeen: "desc" }, take: perSource })
        .then((rows) => rows.map((r) => ({ id: `error:${r.id}`, source: "error", level: (r.level as LogLevel) ?? "error", stage: r.source, message: `${r.message}${r.count > 1 ? ` (×${r.count})` : ""}`, actor: "system", at: r.lastSeen.toISOString() }))),
    );
  }
  if (wantSource("exp")) {
    tasks.push(
      prisma.expJobRowEvent
        .findMany({ where: { ...(createdAt ? { createdAt } : {}), ...(msgContains ? { message: msgContains } : {}) }, orderBy: { createdAt: "desc" }, take: perSource })
        .then((rows) => rows.map((r) => ({ id: `exp:${r.id}`, source: "exp", level: levelFromStatus(r.status), stage: r.step, message: r.message, actor: r.actor, at: r.createdAt.toISOString() }))),
    );
  }
  if (wantSource("booking")) {
    tasks.push(
      prisma.bookingDocEvent
        .findMany({ where: { ...(createdAt ? { createdAt } : {}), ...(msgContains ? { message: msgContains } : {}) }, orderBy: { createdAt: "desc" }, take: perSource })
        .then((rows) => rows.map((r) => ({ id: `booking:${r.id}`, source: "booking", level: levelFromStatus(r.status), stage: r.stage, message: r.message ?? "", actor: r.actor, at: r.createdAt.toISOString() }))),
    );
  }
  if (wantSource("container")) {
    tasks.push(
      prisma.containerSearchEvent
        .findMany({ where: { ...(createdAt ? { createdAt } : {}), ...(msgContains ? { message: msgContains } : {}) }, orderBy: { createdAt: "desc" }, take: perSource })
        .then((rows) => rows.map((r) => ({ id: `container:${r.id}`, source: "container", level: levelFromStatus(r.status), stage: r.step, message: r.message, actor: r.actor, at: r.createdAt.toISOString() }))),
    );
  }
  if (wantSource("pdf-rename")) {
    tasks.push(
      prisma.renameJobEvent
        .findMany({ where: { ...(createdAt ? { createdAt } : {}), ...(msgContains ? { message: msgContains } : {}) }, orderBy: { createdAt: "desc" }, take: perSource })
        .then((rows) => rows.map((r) => ({ id: `pdf-rename:${r.id}`, source: "pdf-rename", level: levelFromStatus(r.status), stage: r.stage, message: r.message, actor: "system", at: r.createdAt.toISOString() }))),
    );
  }
  if (wantSource("intake")) {
    tasks.push(
      prisma.jobStageEvent
        .findMany({ where: { ...(createdAt ? { createdAt } : {}), ...(msgContains ? { message: msgContains } : {}) }, orderBy: { createdAt: "desc" }, take: perSource })
        .then((rows) => rows.map((r) => ({ id: `intake:${r.id}`, source: "intake", level: levelFromStatus(r.status), stage: r.stage, message: r.message ?? "", actor: r.actor, at: r.createdAt.toISOString() }))),
    );
  }

  const merged = (await Promise.all(tasks)).flat();
  const filtered = q.level ? merged.filter((e) => e.level === q.level) : merged;
  filtered.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return filtered.slice(0, take);
}
