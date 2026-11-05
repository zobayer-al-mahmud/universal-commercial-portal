import { prisma } from "@/lib/db";

/**
 * Cross-module aggregator for the centralised "Running Processes" dashboard.
 *
 * Every UCP automation already runs as a DB-backed background job inside the
 * server process (see automation/cancellation.ts). Each module keeps its own
 * job/batch table with its own counter columns, so this module reads those
 * tables and NORMALISES them into one shape the dashboard can render — it never
 * changes state, starts, or stops anything (read-only). Switching tabs, leaving
 * a module or refreshing the browser does not touch these rows; this view simply
 * reports their live state and links back to each job's own module (revisit).
 */

export type RunningJobStatus =
  | "running"
  | "queued"
  | "completed"
  | "partial"
  | "failed"
  | "stopped"
  | "idle";

export interface RunningJob {
  /** Stable dashboard key, e.g. "container:<id>". */
  key: string;
  moduleKey: string;
  module: string; // display name
  batch: string; // batch / file label
  total: number;
  success: number; // completed OK
  failed: number;
  remaining: number; // not yet finished (queued + running)
  processed: number; // finished (success + failed + stopped + skipped)
  progressPct: number; // 0..100
  status: RunningJobStatus;
  active: boolean; // currently processing (drives the live indicator + polling)
  startedAt: Date;
  lastActivity: Date;
  /** Revisit link — opens the job's own module where its controls live. */
  href: string;
}

/** How many recent rows to pull per module (active jobs are always included). */
const PER_MODULE = 40;

function pct(done: number, total: number): number {
  if (total <= 0) return done > 0 ? 100 : 0;
  return Math.min(100, Math.round((done / total) * 100));
}

/** Aggregate active + recent jobs from every module into one normalised list. */
export async function getRunningJobs(limit = 60): Promise<RunningJob[]> {
  const [containerBatches, expJobs, bookingBatches, renameJobs, combineRuns] = await Promise.all([
    prisma.containerBatch.findMany({ orderBy: { updatedAt: "desc" }, take: PER_MODULE }),
    prisma.expJob.findMany({ orderBy: { updatedAt: "desc" }, take: PER_MODULE }),
    prisma.bookingBatch.findMany({ orderBy: { updatedAt: "desc" }, take: PER_MODULE }),
    prisma.renameJob.findMany({ orderBy: { updatedAt: "desc" }, take: PER_MODULE }),
    prisma.pdfCombineRun.findMany({ orderBy: { updatedAt: "desc" }, take: PER_MODULE }),
  ]);

  const jobs: RunningJob[] = [];

  // --- Container: no per-batch counters, so group the searches by status. ----
  if (containerBatches.length) {
    const ids = containerBatches.map((b) => b.id);
    const grouped = await prisma.containerSearch.groupBy({
      by: ["batchId", "status"],
      where: { batchId: { in: ids } },
      _count: { _all: true },
    });
    const byBatch = new Map<string, Record<string, number>>();
    for (const g of grouped) {
      if (!g.batchId) continue;
      const m = byBatch.get(g.batchId) ?? {};
      m[g.status] = g._count._all;
      byBatch.set(g.batchId, m);
    }
    for (const b of containerBatches) {
      const c = byBatch.get(b.id) ?? {};
      const success = c.completed ?? 0;
      const failed = (c.failed ?? 0) + (c.not_found ?? 0) + (c.mismatch ?? 0) + (c.needs_auth ?? 0) + (c.update_failed ?? 0);
      const stopped = c.stopped ?? 0;
      const queued = c.queued ?? 0;
      const running = c.running ?? 0;
      const total = b.total || success + failed + stopped + queued + running;
      const remaining = queued + running;
      const processed = success + failed + stopped;
      const active = remaining > 0 && running > 0 ? true : running > 0;
      let status: RunningJobStatus;
      if (running > 0) status = "running";
      else if (queued > 0) status = "queued";
      else if (stopped > 0 && success === 0) status = "stopped";
      else if (failed > 0 && success === 0) status = "failed";
      else if (failed > 0 || stopped > 0) status = "partial";
      else if (processed > 0) status = "completed";
      else status = "idle";
      jobs.push({
        key: `container:${b.id}`,
        moduleKey: "container",
        module: "Container",
        batch: `${total} container${total === 1 ? "" : "s"}`,
        total,
        success,
        failed,
        remaining,
        processed,
        progressPct: pct(processed, total),
        status,
        active: running > 0 || queued > 0,
        startedAt: b.createdAt,
        lastActivity: b.updatedAt,
        href: "/modules/container",
      });
    }
  }

  // --- EXP Automation: denormalised counters on the job. ---------------------
  for (const j of expJobs) {
    const success = j.matched + j.changed + j.downloaded + j.partial;
    const active = j.status === "running" || j.status === "stopping";
    const status = normalizeExp(j.status);
    jobs.push({
      key: `exp:${j.id}`,
      moduleKey: "exp-automation",
      module: "EXP Automation",
      batch: j.sourceName || `${j.kind} job`,
      total: j.total,
      success,
      failed: j.failed,
      remaining: Math.max(0, j.total - j.processed),
      processed: j.processed,
      progressPct: pct(j.processed, j.total),
      status,
      active,
      startedAt: j.createdAt,
      lastActivity: j.updatedAt,
      href: "/modules/exp-automation",
    });
  }

  // --- Booking Correction ----------------------------------------------------
  for (const b of bookingBatches) {
    const processed = b.completedDocs + b.failedDocs;
    const active = b.status === "processing" || b.liveStatus === "running";
    const status = normalizeBooking(b.status, b.liveStatus);
    jobs.push({
      key: `booking:${b.id}`,
      moduleKey: "booking-correction",
      module: "Booking Correction",
      batch: b.sourceName || `${b.totalDocs} document${b.totalDocs === 1 ? "" : "s"}`,
      total: b.totalDocs,
      success: b.completedDocs,
      failed: b.failedDocs,
      remaining: Math.max(0, b.totalDocs - processed),
      processed,
      progressPct: pct(processed, b.totalDocs),
      status,
      active,
      startedAt: b.liveStartedAt ?? b.createdAt,
      lastActivity: b.liveUpdatedAt ?? b.updatedAt,
      href: `/booking/${b.id}`,
    });
  }

  // --- PDF File Rename -------------------------------------------------------
  for (const r of renameJobs) {
    const active = r.status === "processing" || r.status === "queued";
    const status = normalizeRename(r.status);
    jobs.push({
      key: `rename:${r.id}`,
      moduleKey: "pdf-rename",
      module: "PDF File Rename",
      batch: r.folder || "Rename job",
      total: r.totalItems,
      success: r.renamedItems,
      failed: r.failedItems,
      remaining: Math.max(0, r.totalItems - r.processedItems),
      processed: r.processedItems,
      progressPct: pct(r.processedItems, r.totalItems),
      status,
      active,
      startedAt: r.startedAt ?? r.createdAt,
      lastActivity: r.updatedAt,
      href: "/modules/pdf-rename",
    });
  }

  // --- PDF Combiner (single-shot generator, but tracked as a run) ------------
  for (const run of combineRuns) {
    const processed = run.completedRows + run.failedRows + run.skippedRows;
    const active = run.status === "processing";
    const status = normalizeCombine(run.status);
    jobs.push({
      key: `pdf-combiner:${run.id}`,
      moduleKey: "pdf-combiner",
      module: "PDF Combiner",
      batch: run.masterFileName || "Combiner run",
      total: run.totalRows,
      success: run.completedRows,
      failed: run.failedRows,
      remaining: Math.max(0, run.totalRows - processed),
      processed,
      progressPct: pct(processed, run.totalRows),
      status,
      active,
      startedAt: run.createdAt,
      lastActivity: run.updatedAt,
      href: `/pdf-combiner/${run.id}`,
    });
  }

  // Active jobs first, then most-recently-active. Cap for display.
  jobs.sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    return b.lastActivity.getTime() - a.lastActivity.getTime();
  });
  return jobs.slice(0, limit);
}

function normalizeExp(s: string): RunningJobStatus {
  switch (s) {
    case "running":
    case "stopping":
      return "running";
    case "completed":
      return "completed";
    case "partially_failed":
      return "partial";
    case "failed":
      return "failed";
    case "stopped":
      return "stopped";
    case "idle":
      return "idle";
    default:
      return "queued"; // created
  }
}

function normalizeBooking(s: string, live: string): RunningJobStatus {
  if (s === "processing" || live === "running") return "running";
  if (s === "completed") return "completed";
  if (s === "partial") return "partial";
  if (s === "failed") return "failed";
  if (live === "paused") return "idle";
  return "idle"; // uploaded / stopping
}

function normalizeRename(s: string): RunningJobStatus {
  switch (s) {
    case "processing":
      return "running";
    case "queued":
      return "queued";
    case "completed":
      return "completed";
    case "partial":
      return "partial";
    case "failed":
      return "failed";
    case "paused":
      return "idle";
    default:
      return "idle";
  }
}

function normalizeCombine(s: string): RunningJobStatus {
  switch (s) {
    case "processing":
      return "running";
    case "completed":
      return "completed";
    case "partial":
      return "partial";
    case "failed":
      return "failed";
    default:
      return "idle";
  }
}

/** True when any aggregated job is still actively processing. */
export function anyActive(jobs: RunningJob[]): boolean {
  return jobs.some((j) => j.active);
}
