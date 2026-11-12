/**
 * PDF File Rename — DB-backed folder job engine (module 4).
 *
 * Background, resumable, bounded-concurrency bulk rename with per-file evidence,
 * deep cross-validation (`validate.ts` via `analyzePdf`), and a safe apply step.
 *
 * Non-negotiables (CLAUDE.md / spec #8):
 *  - Never invent a number — uncertain files are renamed to REVIEW_REQUIRED_<id>.pdf
 *    (when safe) or left untouched and reported; never a guessed business name.
 *  - Never overwrite — an existing target or a duplicate invoice is flagged.
 *  - Preserve the original — apply COPIES; source bytes/layout are never modified.
 *  - Restrict to the selected folder and its subfolders; paths are contained.
 */

import { promises as fs } from "fs";
import path from "path";
import { createHash, randomBytes } from "crypto";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { audit } from "@/lib/audit";
import { analyzePdf, resolveFolder } from "./folder-rename";
import { runKey, startRun, requestCancel, isRunning, cancelInfo } from "@/server/automation/cancellation";
import { notifyJobFinished, notifyAutomationError } from "@/server/notifications/events";

const NON_TERMINAL = ["queued", "processing", "paused"];
const RENAME_STOP_REASON = "Stopped by the operator.";
function renameKey(jobId: string): string {
  return runKey("pdf-rename", jobId);
}

async function fileExists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

/** Recursively list .pdf files under a folder (relative paths), excluding the
 *  output sub-folder and hidden/ dot directories. */
async function listPdfsDeep(abs: string, outputSubdir: string, rel = ""): Promise<string[]> {
  let entries: import("fs").Dirent[];
  try { entries = await fs.readdir(path.join(abs, rel), { withFileTypes: true }); } catch { return []; }
  const out: string[] = [];
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (e.name === outputSubdir) continue;
      out.push(...(await listPdfsDeep(abs, outputSubdir, childRel)));
    } else if (e.isFile() && e.name.toLowerCase().endsWith(".pdf")) {
      out.push(childRel);
    }
  }
  return out.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

async function itemEvent(itemId: string, stage: string, status: string, message: string, data: Record<string, unknown> = {}): Promise<void> {
  await prisma.renameJobEvent.create({ data: { itemId, stage, status, message, dataJson: JSON.stringify(data) } }).catch(() => undefined);
}

export interface StartJobResult {
  jobId: string;
  total: number;
  existingJobId?: string; // set when an active job already exists for the folder
}

/**
 * Create a job for a folder: enumerate PDFs, create one RenameJobItem each
 * (PENDING), and return the jobId. Refuses to start a second active job for the
 * same folder (duplicate-job prevention).
 */
export async function startRenameJob(root: string, folder: string, opts: { actor?: string } = {}): Promise<StartJobResult> {
  const actor = opts.actor ?? "system";
  const abs = resolveFolder(root, folder);
  const outputSubdir = env.PDF_RENAME_OUTPUT_SUBDIR;

  const active = await prisma.renameJob.findFirst({ where: { folder, status: { in: NON_TERMINAL } }, orderBy: { createdAt: "desc" } });
  if (active) return { jobId: active.id, total: active.totalItems, existingJobId: active.id };

  const names = await listPdfsDeep(abs, outputSubdir);
  if (env.PDF_RENAME_MAX_FILES > 0 && names.length > env.PDF_RENAME_MAX_FILES) {
    throw new Error(`Folder has ${names.length} PDFs (> ${env.PDF_RENAME_MAX_FILES}). Raise PDF_RENAME_MAX_FILES (set 0 for unlimited) or narrow the selection.`);
  }

  const job = await prisma.renameJob.create({
    data: {
      createdBy: actor, root, folder, outputSubdir,
      status: "queued", concurrency: env.PDF_RENAME_CONCURRENCY, minConfidence: env.PDF_RENAME_MIN_CONFIDENCE,
      ocrEnabled: env.OCR_ENABLED, totalItems: names.length,
      currentActivity: names.length ? "Queued" : "No PDFs found",
    },
  });

  let serial = 0;
  for (const name of names) {
    serial++;
    let sizeBytes = 0;
    try { sizeBytes = (await fs.stat(path.join(abs, name))).size; } catch { /* reported at processing time */ }
    await prisma.renameJobItem.create({ data: { jobId: job.id, serial, originalName: name, sizeBytes, state: "PENDING" } });
  }

  await audit({ entityType: "document", entityId: folder, action: "rename.job.created", actor, data: { jobId: job.id, total: names.length } });
  return { jobId: job.id, total: names.length };
}

function reviewId(serial: number): string {
  return `${String(serial).padStart(3, "0")}-${randomBytes(3).toString("hex")}`;
}

/** Recompute job counters + status from its items. */
async function recomputeJob(jobId: string): Promise<void> {
  const items = await prisma.renameJobItem.findMany({ where: { jobId }, select: { state: true } });
  const renamed = items.filter((i) => i.state === "RENAMED").length;
  const review = items.filter((i) => i.state === "REVIEW_REQUIRED").length;
  const failed = items.filter((i) => i.state === "FAILED").length;
  const pending = items.filter((i) => i.state === "PENDING" || i.state === "PROCESSING").length;
  const processed = renamed + review + failed;
  const status = pending > 0 ? "processing" : failed + review === 0 ? "completed" : renamed > 0 ? "partial" : "failed";
  await prisma.renameJob.update({ where: { id: jobId }, data: { renamedItems: renamed, reviewItems: review, failedItems: failed, processedItems: processed, status, finishedAt: pending > 0 ? null : new Date() } });
}

/**
 * Process ONE item: analyze → decide → safe apply. Idempotent: a RENAMED item is
 * left untouched unless `force`. Errors are recorded as FAILED so one file never
 * aborts the job.
 */
export async function processItem(itemId: string, opts: { actor?: string; force?: boolean } = {}): Promise<void> {
  const actor = opts.actor ?? "system";
  const item = await prisma.renameJobItem.findUnique({ where: { id: itemId }, include: { job: true } });
  if (!item) return;
  if (item.state === "RENAMED" && !opts.force) return;
  const job = item.job;
  const abs = resolveFolder(job.root, job.folder);
  const src = path.join(abs, item.originalName);
  const outputDir = path.join(abs, job.outputSubdir);

  await prisma.renameJobItem.update({ where: { id: itemId }, data: { state: "PROCESSING", startedAt: new Date(), attempts: { increment: 1 }, reviewReason: "", reasonText: "" } });
  await prisma.renameJob.update({ where: { id: job.id }, data: { status: "processing", currentActivity: `Reading ${item.originalName}`, startedAt: job.startedAt ?? new Date() } });

  try {
    const buffer = await fs.readFile(src);
    const sha256 = createHash("sha256").update(buffer).digest("hex");
    const analysis = await analyzePdf(buffer, { minConfidence: job.minConfidence });
    const v = analysis.validation;

    const common = {
      sha256, sizeBytes: buffer.length, docType: v.docType, pages: analysis.pages, textChars: analysis.textChars,
      invoiceNumber: v.invoiceNumber ?? "", raw: v.candidates[0]?.value ?? "", countryToken: v.countryToken ?? "",
      source: v.source === "none" ? (analysis.usedOcr ? "ocr" : "text") : v.source,
      method: v.method, confidence: v.confidence,
      candidatesJson: JSON.stringify(v.candidates),
      evidenceJson: JSON.stringify({ pageRefs: v.pageRefs, reasonText: v.reasonText, usedOcr: analysis.usedOcr, ocrError: analysis.ocrError ?? null }),
    };
    await itemEvent(itemId, "analyze", v.decision === "RENAME" ? "ok" : "failed", v.reasonText, { candidates: v.candidates.length, confidence: v.confidence, usedOcr: analysis.usedOcr });

    await fs.mkdir(outputDir, { recursive: true });

    if (v.decision === "RENAME" && v.invoiceNumber) {
      // Duplicate detection: another RENAMED item in this job with the same key,
      // or an existing target on disk → never overwrite; flag for review.
      const dupe = await prisma.renameJobItem.findFirst({ where: { jobId: job.id, state: "RENAMED", invoiceNumber: v.invoiceNumber, NOT: { id: itemId } } });
      const dest = path.join(outputDir, `${v.invoiceNumber}.pdf`);
      if (dupe || (await fileExists(dest))) {
        await routeToReview(itemId, job.id, src, outputDir, item.serial, {
          ...common, reviewReason: "DUPLICATE_INVOICE_NUMBER",
          reasonText: `Invoice '${v.invoiceNumber}.pdf' already exists${dupe ? ` (also from '${dupe.originalName}')` : " in the output folder"} — not overwritten.`,
        });
        await recomputeJob(job.id);
        return;
      }
      await fs.copyFile(src, dest);
      await prisma.renameJobItem.update({ where: { id: itemId }, data: { ...common, state: "RENAMED", newName: `${v.invoiceNumber}.pdf`, outputPath: dest, processedAt: new Date() } });
      await itemEvent(itemId, "rename", "ok", `Renamed → ${v.invoiceNumber}.pdf`, { outputPath: dest });
      await audit({ entityType: "document", entityId: job.folder, action: "rename.item.renamed", actor, data: { jobId: job.id, from: item.originalName, to: `${v.invoiceNumber}.pdf` } });
      await recomputeJob(job.id);
      return;
    }

    // REVIEW: safe REVIEW_REQUIRED_<id>.pdf copy, else leave original + report.
    await routeToReview(itemId, job.id, src, outputDir, item.serial, {
      ...common, reviewReason: v.reasonCode ?? "INVOICE_NUMBER_NOT_FOUND", reasonText: v.reasonText,
    });
    await recomputeJob(job.id);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await prisma.renameJobItem.update({ where: { id: itemId }, data: { state: "FAILED", reviewReason: "PDF_UNREADABLE_OR_CORRUPTED", reasonText: message, processedAt: new Date() } });
    await itemEvent(itemId, "error", "failed", message);
    await recomputeJob(job.id);
  }
}

/** Copy an uncertain file to REVIEW_REQUIRED_<id>.pdf when safe; else leave it. */
async function routeToReview(
  itemId: string, jobId: string, src: string, outputDir: string, serial: number,
  data: Record<string, unknown> & { reviewReason: string; reasonText: string },
): Promise<void> {
  const rid = reviewId(serial);
  const destName = `REVIEW_REQUIRED_${rid}.pdf`;
  const dest = path.join(outputDir, destName);
  let outputPath: string | null = null;
  let newName: string | null = null;
  try {
    if (!(await fileExists(dest))) {
      await fs.copyFile(src, dest);
      outputPath = dest;
      newName = destName;
      await itemEvent(itemId, "review", "ok", `Flagged for review → ${destName} (${data.reviewReason})`, { reason: data.reviewReason });
    }
  } catch (e) {
    await itemEvent(itemId, "review", "failed", `Could not write review copy: ${e instanceof Error ? e.message : String(e)} — original left unchanged.`, {});
  }
  await prisma.renameJobItem.update({
    where: { id: itemId },
    data: { ...data, state: "REVIEW_REQUIRED", reviewId: rid, newName, outputPath, processedAt: new Date() },
  });
}

/** Run every PENDING/FAILED item in a job with bounded concurrency (background). */
export async function runJob(jobId: string, opts: { actor?: string; force?: boolean } = {}): Promise<void> {
  const actor = opts.actor ?? "system";
  const job = await prisma.renameJob.findUnique({ where: { id: jobId } });
  if (!job) return;
  await prisma.renameJob.update({ where: { id: jobId }, data: { status: "processing", startedAt: job.startedAt ?? new Date() } });

  const items = await prisma.renameJobItem.findMany({ where: { jobId }, orderBy: { serial: "asc" }, select: { id: true, state: true } });
  const queue = items.filter((i) => opts.force || i.state === "PENDING" || i.state === "FAILED" || i.state === "PROCESSING").map((i) => i.id);

  const limit = Math.max(1, Math.min(job.concurrency, env.PDF_RENAME_CONCURRENCY));
  let cursor = 0;
  // Register the run so a Stop can reach this loop. There is no browser here, so
  // a Stop takes effect between files: the file in flight finishes, then no
  // further files are started. (OCR of one file cannot be safely torn open.)
  const run = startRun(renameKey(jobId));
  async function worker() {
    while (cursor < queue.length) {
      if (run.signal.aborted) break; // Stop requested → start no more files.
      const id = queue[cursor++];
      await processItem(id, { actor, force: opts.force });
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, worker));
  } finally {
    run.end();
  }
  if (run.signal.aborted) {
    await finalizePdfRenameStop(jobId, actor);
  } else {
    await recomputeJob(jobId);
    await prisma.renameJob.update({ where: { id: jobId }, data: { currentActivity: "Finished" } });
  }
  await audit({ entityType: "document", entityId: job.folder, action: run.signal.aborted ? "rename.job.stopped" : "rename.job.run", actor, data: { jobId, items: queue.length } });

  // Persistent notification for the job creator + admins (best-effort; never
  // blocks the run). Failures also raise an automation alert for monitors.
  const finished = await prisma.renameJob.findUnique({ where: { id: jobId } });
  if (finished) {
    const summary = `${finished.renamedItems} renamed · ${finished.reviewItems} to review · ${finished.failedItems} failed (of ${finished.totalItems}).`;
    await notifyJobFinished({ module: "PDF Rename", jobId, status: finished.status, actor, link: "/modules/pdf-rename", summary });
    if (finished.failedItems > 0 || finished.status === "failed") {
      await notifyAutomationError({ source: "PDF Rename", message: `${finished.failedItems} file(s) failed in folder “${finished.folder}”. ${summary}`, link: "/modules/pdf-rename", entityType: "rename-job", entityId: jobId });
    }
  }
}

/**
 * Reconcile DB state after a Stop. Renamed files + review copies already written
 * are kept; files not yet started stay PENDING (resumable via Resume/retry). The
 * job is parked in a durable "stopped" state so it cannot silently restart.
 * Idempotent.
 */
async function finalizePdfRenameStop(jobId: string, actor: string): Promise<void> {
  // A file left mid-flight (PROCESSING with no result yet) returns to PENDING so
  // it is resumed cleanly rather than counted as done.
  await prisma.renameJobItem.updateMany({ where: { jobId, state: "PROCESSING" }, data: { state: "PENDING" } }).catch(() => undefined);
  await recomputeJob(jobId);
  const info = cancelInfo(renameKey(jobId));
  // Only park as stopped when files remain to resume; a job that finished at the
  // instant Stop landed keeps its real completed/partial verdict from recompute.
  const remaining = await prisma.renameJobItem.count({ where: { jobId, state: "PENDING" } });
  if (remaining > 0) await prisma.renameJob.update({ where: { id: jobId }, data: { status: "stopped", currentActivity: "Stopped", finishedAt: new Date() } }).catch(() => undefined);
  await prisma.renameJob.findUnique({ where: { id: jobId } }).then((j) => j && audit({ entityType: "document", entityId: j.folder, action: "rename.job.stop-finalized", actor, data: { jobId, reason: info?.reason ?? RENAME_STOP_REASON } })).catch(() => undefined);
}

/**
 * Request that a running PDF-rename job stop. The in-flight file finishes, then
 * no further files start; already-renamed files are kept and the rest stay
 * resumable. If no loop is attached in this process, the DB is reconciled now.
 */
export async function requestStopPdfRenameJob(jobId: string, actor: string): Promise<{ ok: boolean; message: string }> {
  const job = await prisma.renameJob.findUnique({ where: { id: jobId } });
  if (!job) return { ok: false, message: "Job not found." };
  const key = renameKey(jobId);
  const live = isRunning(key);
  requestCancel(key, RENAME_STOP_REASON);
  await prisma.renameJob.update({ where: { id: jobId }, data: { status: "stopping", currentActivity: "Stopping…" } }).catch(() => undefined);
  const info = cancelInfo(key);
  await audit({ entityType: "document", entityId: job.folder, action: "rename.job.stop-requested", actor, data: { jobId, reason: info?.reason ?? RENAME_STOP_REASON, at: (info?.at ?? new Date()).toISOString(), liveLoop: live } });
  if (!live) await finalizePdfRenameStop(jobId, actor);
  return { ok: true, message: "Stop requested." };
}

/** Retry one item (re-analyze + re-apply). */
export async function retryItem(itemId: string, opts: { actor?: string } = {}): Promise<void> {
  await processItem(itemId, { actor: opts.actor, force: true });
}

/** Resume / retry all not-yet-renamed items in a job. */
export async function resumeJob(jobId: string, opts: { actor?: string } = {}): Promise<void> {
  await runJob(jobId, { actor: opts.actor });
}

/**
 * Apply a reviewer-entered invoice number to an item: validate the value is
 * credible (non-empty alphanumeric, not obviously a date), then rename safely.
 * Never overwrites; a duplicate/existing target stays in review.
 */
export async function applyManualCorrection(itemId: string, invoiceNumberRaw: string, opts: { actor?: string } = {}): Promise<{ ok: boolean; message: string }> {
  const actor = opts.actor ?? "system";
  const item = await prisma.renameJobItem.findUnique({ where: { id: itemId }, include: { job: true } });
  if (!item) return { ok: false, message: "Item not found." };
  const invoiceNumber = invoiceNumberRaw.trim().toUpperCase().replace(/[^A-Z0-9/\-]/g, "");
  if (!/[0-9]{3,}/.test(invoiceNumber)) return { ok: false, message: "Enter a valid invoice number (must contain at least 3 digits)." };

  const job = item.job;
  const abs = resolveFolder(job.root, job.folder);
  const src = path.join(abs, item.originalName);
  const outputDir = path.join(abs, job.outputSubdir);
  if (!(await fileExists(src))) return { ok: false, message: "Source file no longer present." };
  await fs.mkdir(outputDir, { recursive: true });

  const dupe = await prisma.renameJobItem.findFirst({ where: { jobId: job.id, state: "RENAMED", invoiceNumber, NOT: { id: itemId } } });
  const dest = path.join(outputDir, `${invoiceNumber}.pdf`);
  if (dupe || (await fileExists(dest))) return { ok: false, message: `'${invoiceNumber}.pdf' already exists — choose a different number.` };

  await fs.copyFile(src, dest);
  await prisma.renameJobItem.update({
    where: { id: itemId },
    data: {
      state: "RENAMED", invoiceNumber, newName: `${invoiceNumber}.pdf`, outputPath: dest,
      manualInvoice: invoiceNumber, correctedBy: actor, reviewReason: "", reasonText: "Manually corrected by reviewer.",
      source: "manual", method: "manual", confidence: 1, processedAt: new Date(),
    },
  });
  await itemEvent(itemId, "manual-correction", "ok", `Reviewer set invoice '${invoiceNumber}' → ${invoiceNumber}.pdf`, { by: actor });
  await audit({ entityType: "document", entityId: job.folder, action: "rename.item.corrected", actor, data: { jobId: job.id, itemId, invoiceNumber } });
  await recomputeJob(job.id);
  return { ok: true, message: `Renamed → ${invoiceNumber}.pdf` };
}

/**
 * Count the PDFs under a folder (recursive, excluding the output sub-folder).
 * Throws if the path is not a readable directory on the UCP server. Used by the
 * folder picker to confirm a selection before scanning/renaming.
 */
export async function countFolderPdfs(root: string, folder: string): Promise<{ abs: string; count: number }> {
  const abs = resolveFolder(root, folder);
  const st = await fs.stat(abs).catch(() => null);
  if (!st || !st.isDirectory()) throw new Error("Not a readable folder on the UCP server.");
  const names = await listPdfsDeep(abs, env.PDF_RENAME_OUTPUT_SUBDIR);
  return { abs, count: names.length };
}

export interface PreviewItem {
  originalName: string;
  docType: string;
  invoiceNumber: string | null;
  proposedName: string | null;
  confidence: number;
  decision: string; // RENAME | REVIEW
  reviewReason: string;
  reasonText: string;
  source: string; // text | ocr | none
  pages: number;
  candidates: number;
}

export interface PreviewResult {
  folder: string;
  total: number;
  willRename: number;
  needsReview: number;
  items: PreviewItem[];
}

/**
 * READ-ONLY deep preview of a folder: run the SAME deep validator the job uses
 * (`analyzePdf`) over every PDF and report the extracted invoice number, the
 * proposed `<invoice>.pdf` filename, confidence and validation status. Writes
 * nothing — no files renamed, no DB rows created. This is what the user sees
 * before committing a bulk rename, so preview == what the job will do.
 */
export async function previewRenameFolder(root: string, folder: string): Promise<PreviewResult> {
  const abs = resolveFolder(root, folder);
  const names = await listPdfsDeep(abs, env.PDF_RENAME_OUTPUT_SUBDIR);
  if (env.PDF_RENAME_MAX_FILES > 0 && names.length > env.PDF_RENAME_MAX_FILES) {
    throw new Error(`Folder has ${names.length} PDFs (> ${env.PDF_RENAME_MAX_FILES}). Raise PDF_RENAME_MAX_FILES (set 0 for unlimited) or narrow the selection.`);
  }
  const items: PreviewItem[] = [];
  for (const name of names) {
    try {
      const buffer = await fs.readFile(path.join(abs, name));
      const a = await analyzePdf(buffer, { minConfidence: env.PDF_RENAME_MIN_CONFIDENCE });
      const v = a.validation;
      items.push({
        originalName: name,
        docType: v.docType,
        invoiceNumber: v.invoiceNumber ?? null,
        proposedName: v.decision === "RENAME" && v.invoiceNumber ? `${v.invoiceNumber}.pdf` : null,
        confidence: v.confidence,
        decision: v.decision,
        reviewReason: v.reasonCode ?? "",
        reasonText: v.reasonText,
        source: v.source === "none" ? (a.usedOcr ? "ocr" : "text") : v.source,
        pages: a.pages,
        candidates: v.candidates.length,
      });
    } catch (e) {
      items.push({
        originalName: name, docType: "unknown", invoiceNumber: null, proposedName: null, confidence: 0,
        decision: "REVIEW", reviewReason: "PDF_UNREADABLE_OR_CORRUPTED", reasonText: e instanceof Error ? e.message : String(e),
        source: "none", pages: 0, candidates: 0,
      });
    }
  }
  const willRename = items.filter((i) => i.decision === "RENAME").length;
  return { folder, total: items.length, willRename, needsReview: items.length - willRename, items };
}

/** Validate a reviewer-entered invoice against the stored candidates (advisory). */
export function validateManualEntry(candidatesJson: string, value: string): { matchesCandidate: boolean } {
  try {
    const cands = JSON.parse(candidatesJson) as { value: string }[];
    const v = value.trim().toUpperCase();
    return { matchesCandidate: cands.some((c) => c.value.toUpperCase() === v) };
  } catch {
    return { matchesCandidate: false };
  }
}
