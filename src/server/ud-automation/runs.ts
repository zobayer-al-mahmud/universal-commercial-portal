import "server-only";
import { prisma } from "@/lib/db";

/**
 * BGMEA portal run history + live progress. A run row is created when a fetch or a
 * write-back starts; each section's status is written as it progresses (the UI polls
 * GET /api/ud/[id]/runs/[runId]); the final report is kept as history.
 * Never stores credentials or secrets — only statuses, counts and portal values.
 */

export type RunKind = "fetch" | "writeback";
export type RunStatus = "running" | "ok" | "partial" | "failed" | "blocked";
export type SectionProgressStatus = "pending" | "running" | "ok" | "empty" | "partial" | "unverified" | "error" | "skipped" | "saved" | "unchanged" | "failed" | "locked" | "manual";

export interface SectionProgress {
  key: string;
  title: string;
  stepKey: string;
  status: SectionProgressStatus;
  message: string;
  found?: number;
}

const RUN_ID_RE = /^[a-z0-9]{12,40}$/;

/** Client-supplied run ids are only accepted in a safe shape (so the UI can poll before the action returns). */
export function safeRunId(id: string | undefined): string | undefined {
  return id && RUN_ID_RE.test(id) ? id : undefined;
}

export async function startRun(input: { id?: string; recordId: string; kind: RunKind; factoryId: string; udNumber: string; actor: string; sections: SectionProgress[] }): Promise<string> {
  const row = await prisma.udPortalRun.create({
    data: {
      ...(input.id ? { id: input.id } : {}),
      recordId: input.recordId,
      kind: input.kind,
      factoryId: input.factoryId,
      udNumber: input.udNumber,
      actor: input.actor,
      sectionsJson: JSON.stringify(input.sections),
      message: "Starting…",
    },
  });
  return row.id;
}

/** A small in-memory mirror so frequent progress updates don't re-read the row. */
const live = new Map<string, SectionProgress[]>();

export async function setRunSections(runId: string, sections: SectionProgress[], message?: string): Promise<void> {
  live.set(runId, sections);
  await prisma.udPortalRun.update({ where: { id: runId }, data: { sectionsJson: JSON.stringify(sections), ...(message !== undefined ? { message } : {}) } }).catch(() => undefined);
}

export async function updateSection(runId: string, sections: SectionProgress[], key: string, patch: Partial<SectionProgress>, message?: string): Promise<SectionProgress[]> {
  const next = sections.map((s) => (s.key === key ? { ...s, ...patch } : s));
  await setRunSections(runId, next, message);
  return next;
}

export async function finishRun(runId: string, status: RunStatus, message: string, sections: SectionProgress[], report: Record<string, unknown>): Promise<void> {
  live.delete(runId);
  let reportJson = JSON.stringify(report);
  if (reportJson.length > 2_000_000) reportJson = JSON.stringify({ truncated: true, note: "Report too large to keep in full." });
  await prisma.udPortalRun.update({ where: { id: runId }, data: { status, message, sectionsJson: JSON.stringify(sections), reportJson, finishedAt: new Date() } }).catch(() => undefined);
}

export interface RunView {
  id: string;
  kind: string;
  factoryId: string;
  udNumber: string;
  status: string;
  message: string;
  sections: SectionProgress[];
  actor: string;
  startedAt: string;
  finishedAt: string | null;
}

function toView(r: { id: string; kind: string; factoryId: string; udNumber: string; status: string; message: string; sectionsJson: string; actor: string; startedAt: Date; finishedAt: Date | null }): RunView {
  let sections: SectionProgress[] = [];
  try {
    sections = JSON.parse(r.sectionsJson);
  } catch {
    sections = [];
  }
  return { id: r.id, kind: r.kind, factoryId: r.factoryId, udNumber: r.udNumber, status: r.status, message: r.message, sections, actor: r.actor, startedAt: r.startedAt.toISOString(), finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null };
}

export async function getRun(recordId: string, runId: string): Promise<RunView | null> {
  const r = await prisma.udPortalRun.findFirst({ where: { id: runId, recordId } });
  return r ? toView(r) : null;
}

export async function getRunReport(recordId: string, runId: string): Promise<Record<string, unknown> | null> {
  const r = await prisma.udPortalRun.findFirst({ where: { id: runId, recordId }, select: { reportJson: true } });
  if (!r) return null;
  try {
    return JSON.parse(r.reportJson);
  } catch {
    return null;
  }
}

export async function listRuns(recordId: string, take = 10): Promise<RunView[]> {
  const rows = await prisma.udPortalRun.findMany({ where: { recordId }, orderBy: { startedAt: "desc" }, take });
  return rows.map(toView);
}

/** Mark runs left "running" by a crashed/restarted server as failed (called lazily). */
export async function expireStaleRuns(recordId: string): Promise<void> {
  const cutoff = new Date(Date.now() - 30 * 60_000);
  await prisma.udPortalRun.updateMany({ where: { recordId, status: "running", startedAt: { lt: cutoff } }, data: { status: "failed", message: "Run did not finish (server restarted or timed out).", finishedAt: new Date() } }).catch(() => undefined);
}
