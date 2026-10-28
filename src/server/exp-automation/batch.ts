import { createHash } from "crypto";
import { mkdir, writeFile, rename, stat, unlink } from "fs/promises";
import { join } from "path";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { audit } from "@/lib/audit";
import { parseExpWorkbook } from "./excel";
import { type ExpKind, type ParsedExpRow } from "./types";
import { runCorrection, runDuplicate, runDownload, type ExpRowResult, type ProgressFn } from "./live-run";

/**
 * EXP job engine. One ExpJob per uploaded workbook (one KIND), one ExpJobRow per
 * data row. Rows are processed SEQUENTIALLY by the serialized live driver (the
 * portal is a single visible window). Fail-closed: when EXP_LIVE_ENABLED is off
 * every processed row is recorded as failed with a clear reason — never faked.
 */

function storageDir(): string {
  return join(env.STORAGE_ROOT, "exp");
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
  const done = by("matched") + by("filled") + by("downloaded"); // genuinely processed OK
  const skipped = by("skipped"); // invalid rows — never processed
  const processed = failed + done + skipped;
  const active = rows.some((r) => r.status === "running" || r.status === "queued");
  const pending = rows.some((r) => r.status === "pending");

  let status: string;
  if (active) status = "running";
  else if (failed + done > 0 && !pending) {
    // All selected rows have finished: distinguish a clean run from a mixed or
    // total failure so Job History reflects the true outcome.
    status = done === 0 ? "failed" : failed > 0 ? "partially_failed" : "completed";
  } else if (failed + done > 0) status = "running"; // some processed, more still pending (idle between selections)
  else status = "created";

  await prisma.expJob.update({
    where: { id: jobId },
    data: {
      processed,
      matched: by("matched"),
      changed: by("filled"),
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
    ? { jobId: job.id, id: { in: input.rowIds }, status: { in: ["pending", "not_found", "mismatch", "failed", "needs_auth"] } }
    : { jobId: job.id, status: "pending" as const };

  const rows = await prisma.expJobRow.findMany({ where, select: { id: true } });
  if (rows.length === 0) return { ok: false, queued: 0, message: "No eligible rows to process (invalid rows are skipped)." };

  await prisma.expJobRow.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { status: "queued", error: "", step: "" } });
  await prisma.expJob.update({ where: { id: job.id }, data: { status: "running" } }).catch(() => undefined);
  await audit({ entityType: "exp", entityId: job.id, action: "exp.job.process", actor: input.actor, data: { queued: rows.length } });

  void runQueue(job.id, input.actor).catch(() => undefined);
  return { ok: true, queued: rows.length, message: `${rows.length} row(s) queued.` };
}

/** Drive every queued row of a job, one at a time. */
async function runQueue(jobId: string, actor: string): Promise<void> {
  // Re-fetch each loop so rows queued mid-run are also processed.
  for (;;) {
    const row = await prisma.expJobRow.findFirst({ where: { jobId, status: "queued" }, orderBy: { rowNo: "asc" } });
    if (!row) break;
    await prisma.expJobRow.update({ where: { id: row.id }, data: { status: "running", step: "" } }).catch(() => undefined);
    await runExpRow(row.id, actor).catch(async (e) => {
      await prisma.expJobRow.update({ where: { id: row.id }, data: { status: "failed", error: e instanceof Error ? e.message : "Row crashed." } }).catch(() => undefined);
    });
    await recomputeCounters(jobId);
  }
  await recomputeCounters(jobId);
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
  await prisma.expJobRow.update({
    where: { id: rowId },
    data: {
      status,
      step: result.outcome === "DOWNLOADED" ? "Download Verified" : result.outcome === "FILLED" ? "Verified (ready for your review)" : result.outcome === "MATCHED" ? "Verified (ready for your review)" : undefined,
      portalValuesJson: JSON.stringify(result.portalValues ?? {}),
      mismatchedFields: JSON.stringify(result.mismatchedFields ?? []),
      pdfPath,
      pdfSha256,
      pdfPages,
      error: status === "matched" || status === "filled" || status === "downloaded" ? "" : result.message,
      processedAt: new Date(),
    },
  });

  await logEvent(rowId, result.outcome, result.ok ? "ok" : "failed", result.message, actor);
  await audit({ entityType: "exp", entityId: rowId, action: `exp.row.${status}`, actor, data: { kind: row.kind, outcome: result.outcome, authOutcome: result.auth.outcome, mismatched: result.mismatchedFields?.length ?? 0, pdfBytes: result.pdf?.bytes ?? 0 } });
}

function outcomeToStatus(result: ExpRowResult, hasPdf: boolean): string {
  switch (result.outcome) {
    case "MATCHED": return "matched";
    case "FILLED": return "filled";
    case "DOWNLOADED": return hasPdf ? "downloaded" : "failed";
    case "NOT_FOUND": return "not_found";
    case "NEEDS_AUTH": return "needs_auth";
    default: return "failed"; // NAV_ERROR | NO_PDF | FAILED
  }
}

/** Retry one row (re-queues it; a serialized queue drains it). */
export async function retryExpRow(rowId: string, actor: string): Promise<{ ok: boolean; message: string }> {
  const row = await prisma.expJobRow.findUnique({ where: { id: rowId } });
  if (!row) return { ok: false, message: "Row not found." };
  if (row.status === "skipped") return { ok: false, message: "This row is invalid and cannot be processed." };
  await prisma.expJobRow.update({ where: { id: rowId }, data: { status: "queued", error: "", step: "", retryCount: { increment: 1 } } });
  await recomputeCounters(row.jobId);
  void runQueue(row.jobId, actor).catch(() => undefined);
  return { ok: true, message: "Retry queued." };
}

function parseRowData(json: string): { values: Record<string, string>; raw: Record<string, string>; notes: string[] } {
  try {
    const o = JSON.parse(json) as { values?: Record<string, string>; raw?: Record<string, string>; notes?: string[] };
    return { values: o.values ?? {}, raw: o.raw ?? {}, notes: o.notes ?? [] };
  } catch {
    return { values: {}, raw: {}, notes: [] };
  }
}
