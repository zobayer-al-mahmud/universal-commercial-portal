import { createHash } from "crypto";
import { mkdir, writeFile, rename, stat, unlink } from "fs/promises";
import { join } from "path";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { audit } from "@/lib/audit";
import { parseExpWorkbook } from "./excel";
import { type ExpKind, type ParsedExpRow } from "./types";
import { runCorrection, runDuplicate, runDownload, type ExpRowResult, type ProgressFn } from "./live-run";
import { detachExpBrowser } from "./browser";
import { runKey, startRun, requestCancel, isRunning, onCancel, cancelInfo, type RunHandle } from "@/server/automation/cancellation";

const EXP_STOP_REASON = "Stopped by the operator.";
function expKey(jobId: string): string {
  return runKey("exp", jobId);
}

/**
 * EXP job engine. One ExpJob per uploaded workbook (one KIND), one ExpJobRow per
 * data row. Rows are processed SEQUENTIALLY by the serialized live driver (the
 * portal is a single visible window). Fail-closed: when EXP_LIVE_ENABLED is off
 * every processed row is recorded as failed with a clear reason — never faked.
 */

function storageDir(): string {
  return join(env.STORAGE_ROOT, "exp");
}

function uploadsDir(): string {
  return join(env.STORAGE_ROOT, "exp", "uploads");
}

/** Save the original uploaded workbook bytes (immutable) next to the job. */
async function storeOriginalWorkbook(jobId: string, buffer: Buffer): Promise<{ path: string; bytes: number } | null> {
  try {
    const dir = uploadsDir();
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${jobId}.xlsx`);
    const tmp = `${path}.part`;
    await writeFile(tmp, buffer);
    await rename(tmp, path).catch(async (e) => { await unlink(path).catch(() => undefined); await rename(tmp, path).catch(() => { throw e; }); });
    return { path, bytes: buffer.length };
  } catch {
    return null;
  }
}

async function logEvent(rowId: string, step: string, status: "info" | "ok" | "failed", message: string, actor: string) {
  await prisma.expJobRowEvent.create({ data: { rowId, step, status, message: message.slice(0, 500), actor } }).catch(() => undefined);
}

export interface CreateJobResult {
  jobId: string;
  kind: ExpKind;
  total: number;
  invalid: number;
  sheetName: string;
  missingHeaders: string[];
  liveEnabled: boolean;
}

/** Parse an uploaded workbook and create the job + rows (all pending). */
export async function createExpJobFromBuffer(input: {
  buffer: Buffer;
  kind: ExpKind;
  sourceName: string;
  actor: string;
}): Promise<CreateJobResult | { error: string }> {
  const parsed = await parseExpWorkbook(input.buffer, input.kind);
  if (parsed.rows.length === 0) {
    const reason = parsed.skipped[0]?.reason || "No data rows were found in the workbook.";
    return { error: reason };
  }
  if (parsed.rows.length > env.EXP_MAX_ROWS) {
    return { error: `Too many rows (${parsed.rows.length}); the limit is ${env.EXP_MAX_ROWS}.` };
  }

  const sha256 = createHash("sha256").update(input.buffer).digest("hex");
  const job = await prisma.expJob.create({
    data: {
      kind: input.kind,
      sourceName: input.sourceName.slice(0, 200),
      sourceSha256: sha256,
      sheetName: parsed.sheetName,
      total: parsed.rows.length,
      actor: input.actor,
    },
  });

  // Persist the original workbook bytes so the batch can be reopened/reprocessed later.
  const stored = await storeOriginalWorkbook(job.id, input.buffer);
  if (stored) {
    await prisma.expJob.update({ where: { id: job.id }, data: { storedPath: stored.path, fileBytes: stored.bytes } }).catch(() => undefined);
  }

  await prisma.expJobRow.createMany({
    data: parsed.rows.map((r: ParsedExpRow) => ({
      jobId: job.id,
      rowNo: r.rowNo,
      kind: input.kind,
      adscode: r.adscode,
      expSerial: r.expSerial,
      expYear: r.expYear,
      expNo: r.expNo,
      invoiceNo: r.invoiceNo,
      saveAs: r.saveAs,
      dataJson: JSON.stringify({ values: r.values, raw: r.raw, notes: r.notes, invalid: r.invalid, invalidReason: r.invalidReason }),
      status: r.invalid ? "skipped" : "pending",
      error: r.invalid ? r.invalidReason ?? "Invalid row." : "",
    })),
  });

  const invalid = parsed.rows.filter((r) => r.invalid).length;
  await audit({ entityType: "exp", entityId: job.id, action: "exp.job.created", actor: input.actor, data: { kind: input.kind, total: parsed.rows.length, invalid, sheet: parsed.sheetName } });
  await recomputeCounters(job.id);

  return { jobId: job.id, kind: input.kind, total: parsed.rows.length, invalid, sheetName: parsed.sheetName, missingHeaders: parsed.missingHeaders, liveEnabled: env.EXP_LIVE_ENABLED };
}

/** Rebuild a job's counters from its rows. */
export async function recomputeCounters(jobId: string): Promise<void> {
  const rows = await prisma.expJobRow.findMany({ where: { jobId }, select: { status: true } });
  const by = (s: string) => rows.filter((r) => r.status === s).length;
  const failed = by("not_found") + by("mismatch") + by("failed") + by("needs_auth");
  // Genuinely processed OK: correction fill, duplicate matched/updated-verified, download.
  const done = by("matched") + by("filled") + by("updated_verified") + by("downloaded");
  const partial = by("partially_updated"); // duplicate: some fields not verified
  const skipped = by("skipped"); // invalid rows — never processed
  const processed = failed + done + partial + skipped;
  const active = rows.some((r) => r.status === "running" || r.status === "queued");
  const pending = rows.some((r) => r.status === "pending");
  const anyOk = done + partial > 0;

  let status: string;
  if (active) status = "running";
  else if (failed + done + partial > 0 && !pending) {
    // All selected rows have finished: distinguish a clean run from a mixed or
    // total failure so Job History reflects the true outcome.
    status = !anyOk ? "failed" : failed > 0 || partial > 0 ? "partially_failed" : "completed";
  } else if (failed + done + partial > 0) status = "running"; // some processed, more still pending (idle between selections)
  else status = "created";

  await prisma.expJob.update({
    where: { id: jobId },
    data: {
      processed,
      matched: by("matched"),
      changed: by("filled") + by("updated_verified"), // correction: filled; duplicate: updated+verified
      partial,
      downloaded: by("downloaded"),
      skipped,
      failed,
      status,
    },
  }).catch(() => undefined);
}

export interface ProcessResult {
  ok: boolean;
  queued: number;
  message: string;
}

/**
 * Queue selected rows (or all pending) and start sequential background
 * processing. Returns immediately so the UI can poll.
 */
export async function processExpRows(input: { jobId: string; rowIds?: string[]; actor: string }): Promise<ProcessResult> {
  const job = await prisma.expJob.findUnique({ where: { id: input.jobId } });
  if (!job) return { ok: false, queued: 0, message: "Job not found." };

  const where = input.rowIds && input.rowIds.length
    ? { jobId: job.id, id: { in: input.rowIds }, status: { in: ["pending", "not_found", "mismatch", "failed", "needs_auth", "partially_updated", "stopped"] } }
    : { jobId: job.id, status: "pending" as const };

  const rows = await prisma.expJobRow.findMany({ where, select: { id: true } });
  if (rows.length === 0) return { ok: false, queued: 0, message: "No eligible rows to process (invalid rows are skipped)." };

  await prisma.expJobRow.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { status: "queued", error: "", step: "" } });
  await prisma.expJob.update({ where: { id: job.id }, data: { status: "running" } }).catch(() => undefined);
  await audit({ entityType: "exp", entityId: job.id, action: "exp.job.process", actor: input.actor, data: { queued: rows.length } });

  // Register the run (a fresh, un-aborted signal — clears any prior Stop) BEFORE
  // the loop is scheduled, so a Stop clicked the instant processing begins can
  // still reach it. Closing the visible browser on cancel makes an in-flight
  // page op throw at once instead of running to its navigation timeout.
  const run = startRun(expKey(job.id));
  onCancel(expKey(job.id), () => { void detachExpBrowser().catch(() => undefined); });
  void runQueue(job.id, input.actor, run).catch(() => undefined);
  return { ok: true, queued: rows.length, message: `${rows.length} row(s) queued.` };
}

/** Drive every queued row of a job, one at a time. Cooperative-cancellable. */
async function runQueue(jobId: string, actor: string, run: RunHandle): Promise<void> {
  try {
    // Re-fetch each loop so rows queued mid-run are also processed.
    for (;;) {
      if (run.signal.aborted) break; // Stop requested → process no more rows.
      const row = await prisma.expJobRow.findFirst({ where: { jobId, status: "queued" }, orderBy: { rowNo: "asc" } });
      if (!row) break;
      if (run.signal.aborted) break;
      await prisma.expJobRow.update({ where: { id: row.id }, data: { status: "running", step: "" } }).catch(() => undefined);
      await runExpRow(row.id, actor).catch(async (e) => {
        // A Stop closes the browser mid-row, which surfaces as a thrown page
        // error: record the interrupted row as Stopped, not Failed.
        const stopped = run.signal.aborted;
        await prisma.expJobRow.update({
          where: { id: row.id },
          data: stopped
            ? { status: "stopped", step: "Stopped", error: EXP_STOP_REASON }
            : { status: "failed", error: e instanceof Error ? e.message : "Row crashed." },
        }).catch(() => undefined);
      });
      await recomputeCounters(jobId);
    }
  } finally {
    run.end();
    if (run.signal.aborted) await finalizeExpStop(jobId, actor);
    else await recomputeCounters(jobId);
  }
}

/**
 * Reconcile DB state after a Stop: the interrupted row is marked Stopped, every
 * still-queued row returns to Pending (resumable by a deliberate re-process), and
 * the job is parked in a durable "stopped" state so nothing restarts on its own.
 * Idempotent — safe whether the loop or the Stop request calls it.
 */
async function finalizeExpStop(jobId: string, actor: string): Promise<void> {
  await prisma.expJobRow.updateMany({ where: { jobId, status: "queued" }, data: { status: "pending", step: "" } }).catch(() => undefined);
  const running = await prisma.expJobRow.findMany({ where: { jobId, status: "running" }, select: { id: true } });
  if (running.length) {
    await prisma.expJobRow.updateMany({ where: { id: { in: running.map((r) => r.id) } }, data: { status: "stopped", step: "Stopped", error: EXP_STOP_REASON } }).catch(() => undefined);
    for (const r of running) await logEvent(r.id, "Stopped", "failed", EXP_STOP_REASON, actor);
  }
  await recomputeCounters(jobId);
  // recomputeCounters derives a live status from the rows; force the durable
  // stopped marker so the UI shows Stopped (and offers Resume), not Running —
  // but only when work was actually interrupted. If every row had already
  // finished at the instant Stop landed, keep the real terminal verdict.
  const resumable = await prisma.expJobRow.count({ where: { jobId, status: { in: ["pending", "stopped"] } } });
  if (resumable > 0) await prisma.expJob.update({ where: { id: jobId }, data: { status: "stopped" } }).catch(() => undefined);
}

/**
 * Request that a running EXP job stop. Flips the shared cancel flag (which closes
 * the live browser) and records the reason + time; if no loop is attached in this
 * process, reconciles the DB directly so a stale "running" job can still be
 * parked. Already-processed rows and downloaded PDFs are never touched.
 */
export async function requestStopExpJob(jobId: string, actor: string): Promise<{ ok: boolean; message: string }> {
  const job = await prisma.expJob.findUnique({ where: { id: jobId } });
  if (!job) return { ok: false, message: "Job not found." };
  const key = expKey(jobId);
  const live = isRunning(key);
  requestCancel(key, EXP_STOP_REASON);
  await prisma.expJob.update({ where: { id: jobId }, data: { status: "stopping" } }).catch(() => undefined);
  const info = cancelInfo(key);
  await audit({ entityType: "exp", entityId: jobId, action: "exp.job.stopped", actor, data: { reason: info?.reason ?? EXP_STOP_REASON, at: (info?.at ?? new Date()).toISOString(), liveLoop: live } });
  // No loop in this process (e.g. after a server restart) → reconcile now.
  if (!live) await finalizeExpStop(jobId, actor);
  return { ok: true, message: "Stop requested." };
}

/** Process one row end-to-end against the live portal + persist the result. */
export async function runExpRow(rowId: string, actor: string): Promise<void> {
  const row = await prisma.expJobRow.findUnique({ where: { id: rowId } });
  if (!row) return;

  // Fail closed — never fabricate a portal result when live automation is off.
  if (!env.EXP_LIVE_ENABLED) {
    const message = "Live EXP automation is disabled (set EXP_LIVE_ENABLED=true). No portal action was taken and nothing was fabricated.";
    await prisma.expJobRow.update({ where: { id: rowId }, data: { status: "failed", error: message, processedAt: new Date() } });
    await logEvent(rowId, "", "failed", message, actor);
    return;
  }

  const parsed = parseRowData(row.dataJson);
  const parsedRow: ParsedExpRow = {
    rowNo: row.rowNo,
    kind: row.kind as ExpKind,
    adscode: row.adscode,
    expSerial: row.expSerial,
    expYear: row.expYear,
    expNo: row.expNo,
    invoiceNo: row.invoiceNo,
    saveAs: row.saveAs,
    values: parsed.values,
    raw: parsed.raw,
    notes: parsed.notes,
    invalid: false,
  };

  const onProgress: ProgressFn = async (step, detail) => {
    await prisma.expJobRow.update({ where: { id: rowId }, data: { step } }).catch(() => undefined);
    await logEvent(rowId, step, "info", detail ?? step, actor);
  };

  let result: ExpRowResult;
  if (row.kind === "correction") result = await runCorrection(parsedRow, onProgress);
  else if (row.kind === "duplicate") result = await runDuplicate(parsedRow, onProgress);
  else result = await runDownload(parsedRow, onProgress);

  // Persist the PDF (download kind).
  let pdfPath: string | null = null;
  let pdfSha256: string | null = null;
  let pdfPages = 0;
  if (result.ok && result.pdf) {
    try {
      const dir = storageDir();
      await mkdir(dir, { recursive: true });
      const path = join(dir, `${rowId}.pdf`);
      const tmp = `${path}.part`;
      await writeFile(tmp, result.pdf.buffer);
      const sz = await stat(tmp);
      if (sz.size !== result.pdf.buffer.length) { await unlink(tmp).catch(() => undefined); throw new Error("partial write"); }
      await rename(tmp, path).catch(async (e) => { await unlink(path).catch(() => undefined); await rename(tmp, path).catch(() => { throw e; }); });
      pdfPath = path;
      pdfSha256 = createHash("sha256").update(result.pdf.buffer).digest("hex");
      pdfPages = result.pdf.pages;
    } catch (e) {
      await logEvent(rowId, "Downloading PDF", "failed", `Failed to store PDF: ${(e as Error).message}`, actor);
    }
  }

  const status = outcomeToStatus(result, Boolean(pdfPath));
  const finalStep =
    result.outcome === "DOWNLOADED" ? "Download complete"
    : result.outcome === "FILLED" ? "Form filled (ready for your review)"
    : undefined;
  await prisma.expJobRow.update({
    where: { id: rowId },
    data: {
      status,
      step: finalStep,
      portalValuesJson: JSON.stringify(result.portalValues ?? {}),
      mismatchedFields: JSON.stringify(result.mismatchedFields ?? []),
      pdfPath,
      pdfSha256,
      pdfPages,
      error: CLEAN_STATUSES.has(status) ? "" : result.message,
      processedAt: new Date(),
    },
  });

  await logEvent(rowId, result.outcome, result.ok ? "ok" : "failed", result.message, actor);
  await audit({ entityType: "exp", entityId: rowId, action: `exp.row.${status}`, actor, data: { kind: row.kind, outcome: result.outcome, authOutcome: result.auth.outcome, mismatched: result.mismatchedFields?.length ?? 0, pdfBytes: result.pdf?.bytes ?? 0 } });
}

function outcomeToStatus(result: ExpRowResult, hasPdf: boolean): string {
  switch (result.outcome) {
    case "FILLED": return "filled";
    case "DOWNLOADED": return hasPdf ? "downloaded" : "failed";
    case "NOT_FOUND": return "not_found";
    case "NEEDS_AUTH": return "needs_auth";
    default: return "failed"; // NAV_ERROR | NO_PDF | FAILED
  }
}

/** Statuses that count as a clean success (no error text, not re-queued by default). */
const CLEAN_STATUSES = new Set(["filled", "downloaded"]);

/** Retry one row (re-queues it; a serialized queue drains it). */
export async function retryExpRow(rowId: string, actor: string): Promise<{ ok: boolean; message: string }> {
  const row = await prisma.expJobRow.findUnique({ where: { id: rowId } });
  if (!row) return { ok: false, message: "Row not found." };
  if (row.status === "skipped") return { ok: false, message: "This row is invalid and cannot be processed." };
  await prisma.expJobRow.update({ where: { id: rowId }, data: { status: "queued", error: "", step: "", retryCount: { increment: 1 } } });
  await prisma.expJob.update({ where: { id: row.jobId }, data: { status: "running" } }).catch(() => undefined);
  await recomputeCounters(row.jobId);
  const run = startRun(expKey(row.jobId));
  onCancel(expKey(row.jobId), () => { void detachExpBrowser().catch(() => undefined); });
  void runQueue(row.jobId, actor, run).catch(() => undefined);
  return { ok: true, message: "Retry queued." };
}

/**
 * Edit a parsed preview row before it is processed: its search identifiers
 * and/or its mapped field values. Allowed only while the row has not been
 * processed OK (pending / skipped / a prior failure) — a done row must be
 * retried, not silently rewritten. Re-derives validity + keeps counters honest.
 */
export async function updateExpRow(input: {
  rowId: string;
  actor: string;
  patch: { adscode?: string; expSerial?: string; expYear?: string; expNo?: string; saveAs?: string; values?: Record<string, string> };
}): Promise<{ ok: boolean; message: string }> {
  const row = await prisma.expJobRow.findUnique({ where: { id: input.rowId } });
  if (!row) return { ok: false, message: "Row not found." };
  const EDITABLE = ["pending", "skipped", "not_found", "mismatch", "failed", "needs_auth", "partially_updated", "stopped"];
  if (!EDITABLE.includes(row.status)) return { ok: false, message: "This row was processed; retry it instead of editing." };

  const parsed = parseRowData(row.dataJson);
  const p = input.patch;
  const nextValues = p.values ? { ...parsed.values, ...p.values } : parsed.values;
  const adscode = (p.adscode ?? row.adscode).trim();
  const expSerial = (p.expSerial ?? row.expSerial).trim();
  const expYear = (p.expYear ?? row.expYear).trim();
  const expNo = (p.expNo ?? row.expNo).trim();
  const saveAs = (p.saveAs ?? row.saveAs).trim();
  const invoiceNo = (nextValues.invoiceNo ?? row.invoiceNo).trim();

  const invalid = row.kind === "download" ? !(expNo || (adscode && expSerial && expYear)) : !(adscode && expSerial && expYear);
  const dataJson = JSON.stringify({ values: nextValues, raw: parsed.raw, notes: parsed.notes, invalid, invalidReason: invalid ? "Missing required identifier(s)." : undefined });

  await prisma.expJobRow.update({
    where: { id: input.rowId },
    data: {
      adscode, expSerial, expYear, expNo, saveAs, invoiceNo, dataJson,
      status: invalid ? "skipped" : "pending",
      error: invalid ? "Missing ADSCODE / EXP Serial / EXP Year." : "",
      step: "",
      portalValuesJson: "{}",
      mismatchedFields: "[]",
    },
  });
  await recomputeCounters(row.jobId);
  return { ok: true, message: "Row updated." };
}

function parseRowData(json: string): { values: Record<string, string>; raw: Record<string, string>; notes: string[] } {
  try {
    const o = JSON.parse(json) as { values?: Record<string, string>; raw?: Record<string, string>; notes?: string[] };
    return { values: o.values ?? {}, raw: o.raw ?? {}, notes: o.notes ?? [] };
  } catch {
    return { values: {}, raw: {}, notes: [] };
  }
}
