"use server";

import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";
import { prisma } from "@/lib/db";
import { scanFolder, applyPlan, type PlanItem, type PlanSummary } from "@/server/pdf-rename/folder-rename";
import {
  startRenameJob, runJob, retryItem, resumeJob, applyManualCorrection,
  previewRenameFolder, countFolderPdfs, type PreviewResult,
} from "@/server/pdf-rename/job-run";
import { revalidatePath } from "next/cache";

/**
 * Server actions for the PDF File Rename folder workflow (module 4).
 *  - scanFolderAction: read-only preview — extract every PDF's invoice number
 *    (text + OCR) and build the plan. No file is written.
 *  - renameOneAction / renameAllAction: gated apply — copy the planned file(s)
 *    into the folder's output sub-folder. Originals preserved, never overwritten.
 */

export interface RenameItemView {
  originalName: string;
  docType: string;
  invoiceNumber: string | null;
  countryToken: string | null;
  newName: string | null;
  status: string;
  source: string;
  method: string;
  reason: string;
  pages: number;
  applied?: boolean;
  outputPath?: string | null;
}

export interface FolderScanView {
  error?: string;
  folder?: string;
  outputSubdir?: string;
  summary?: PlanSummary;
  applied?: { renamed: number; targetExists: number; missingSource: number; skipped: number };
  items?: RenameItemView[];
}

function toView(items: PlanItem[]): RenameItemView[] {
  return items.map((it) => ({
    originalName: it.originalName,
    docType: it.docType,
    invoiceNumber: it.invoiceNumber,
    countryToken: it.countryToken,
    newName: it.newName,
    status: it.status,
    source: it.source,
    method: it.method,
    reason: it.reason,
    pages: it.pages,
  }));
}

async function requireAuth(perm: (typeof PERMISSIONS)[keyof typeof PERMISSIONS]) {
  const user = await getSessionUser();
  if (!user) return { user: null as null, error: "Not authenticated." };
  if (!userHasPermission(user, perm)) return { user: null as null, error: "You do not have permission for this action." };
  return { user, error: undefined };
}

// ---------------------------------------------------------------------------
// Folder selection + deep preview + job history (DB-backed workflow).
// ---------------------------------------------------------------------------

export interface FolderValidateView { ok: boolean; folder?: string; count?: number; error?: string }

/**
 * Confirm a user-entered folder path is a readable directory on the UCP SERVER
 * (within the configured rename root) and report its PDF count. The module only
 * ever touches the server filesystem — never the user's local computer.
 */
export async function validateFolderAction(folder: string): Promise<FolderValidateView> {
  const { user, error } = await requireAuth(PERMISSIONS.JOB_READ);
  if (!user) return { ok: false, error };
  if (!env.PDF_RENAME_ROOT) return { ok: false, error: "PDF_RENAME_ROOT is not configured." };
  try {
    const { count } = await countFolderPdfs(env.PDF_RENAME_ROOT, folder);
    return { ok: true, folder, count };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Folder not accessible." };
  }
}

export interface PreviewView { error?: string; preview?: PreviewResult }

/** Deep read-only preview of a folder (same validator the job uses; no writes). */
export async function previewFolderAction(folder: string): Promise<PreviewView> {
  const { user, error } = await requireAuth(PERMISSIONS.JOB_READ);
  if (!user) return { error };
  if (!env.PDF_RENAME_ROOT) return { error: "PDF_RENAME_ROOT is not configured." };
  try {
    const preview = await previewRenameFolder(env.PDF_RENAME_ROOT, folder);
    await audit({ entityType: "document", entityId: folder, action: "rename.folder.preview", actor: user.email, data: { total: preview.total, willRename: preview.willRename } });
    return { preview };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Preview failed." };
  }
}

export interface JobHistoryRow {
  id: string; folder: string; status: string; total: number; renamed: number; review: number; failed: number;
  createdAt: string; finishedAt: string | null; createdBy: string;
}

/** Recent rename jobs for the History section (persisted, newest first). */
export async function listRenameJobsAction(limit = 20): Promise<{ jobs: JobHistoryRow[] }> {
  const { user } = await requireAuth(PERMISSIONS.JOB_READ);
  if (!user) return { jobs: [] };
  const rows = await prisma.renameJob.findMany({ orderBy: { createdAt: "desc" }, take: Math.min(Math.max(limit, 1), 100) });
  return {
    jobs: rows.map((j) => ({
      id: j.id, folder: j.folder, status: j.status, total: j.totalItems,
      renamed: j.renamedItems, review: j.reviewItems, failed: j.failedItems,
      createdAt: j.createdAt.toISOString(), finishedAt: j.finishedAt ? j.finishedAt.toISOString() : null, createdBy: j.createdBy,
    })),
  };
}

/** Read-only preview: extract invoice numbers and build the rename plan. */
export async function scanFolderAction(folder: string): Promise<FolderScanView> {
  const { user, error } = await requireAuth(PERMISSIONS.JOB_READ);
  if (!user) return { error };
  if (!env.PDF_RENAME_ROOT) return { error: "PDF_RENAME_ROOT is not configured." };
  try {
    const res = await scanFolder(env.PDF_RENAME_ROOT, folder, {
      outputSubdir: env.PDF_RENAME_OUTPUT_SUBDIR,
      maxFiles: env.PDF_RENAME_MAX_FILES,
    });
    await audit({ entityType: "document", entityId: folder, action: "rename.folder.scan", actor: user.email, data: { summary: res.summary } });
    return { folder, outputSubdir: env.PDF_RENAME_OUTPUT_SUBDIR, summary: res.summary, items: toView(res.items) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Scan failed." };
  }
}

async function scanAndApply(folder: string, files: string[] | undefined, actor: string): Promise<FolderScanView> {
  const res = await scanFolder(env.PDF_RENAME_ROOT, folder, {
    outputSubdir: env.PDF_RENAME_OUTPUT_SUBDIR,
    maxFiles: env.PDF_RENAME_MAX_FILES,
    files,
  });
  const apply = await applyPlan(env.PDF_RENAME_ROOT, folder, env.PDF_RENAME_OUTPUT_SUBDIR, res.items);
  const appliedByName = new Map(apply.renamed.map((r) => [r.originalName, r]));
  const items = toView(res.items).map((v) => {
    const a = appliedByName.get(v.originalName);
    return { ...v, applied: a?.action === "renamed", outputPath: a?.outputPath ?? null };
  });
  await audit({
    entityType: "document",
    entityId: folder,
    action: "rename.folder.apply",
    actor,
    data: { summary: res.summary, apply: apply.summary, outputDir: apply.outputDir, scope: files ? files : "all" },
  });
  return {
    folder,
    outputSubdir: env.PDF_RENAME_OUTPUT_SUBDIR,
    summary: res.summary,
    applied: {
      renamed: apply.summary.renamed,
      targetExists: apply.summary["target-exists"],
      missingSource: apply.summary["missing-source"],
      skipped: apply.summary.skipped,
    },
    items,
  };
}

/** Gated apply of every planned file in the folder ("Rename All PDFs"). */
export async function renameAllAction(folder: string): Promise<FolderScanView> {
  const { user, error } = await requireAuth(PERMISSIONS.RENAME_APPLY);
  if (!user) return { error };
  if (!env.PDF_RENAME_ROOT) return { error: "PDF_RENAME_ROOT is not configured." };
  try {
    return await scanAndApply(folder, undefined, user.email);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Rename all failed." };
  }
}

// ---------------------------------------------------------------------------
// DB-backed job workflow (background, resumable, unified progress + review).
// ---------------------------------------------------------------------------

export interface StartJobView { error?: string; jobId?: string; total?: number; alreadyRunning?: boolean }

/** Start (or resume) a background rename job for a folder ("Rename All PDFs"). */
export async function startRenameJobAction(folder: string): Promise<StartJobView> {
  const { user, error } = await requireAuth(PERMISSIONS.RENAME_APPLY);
  if (!user) return { error };
  if (!env.PDF_RENAME_ROOT) return { error: "PDF_RENAME_ROOT is not configured." };
  try {
    const res = await startRenameJob(env.PDF_RENAME_ROOT, folder, { actor: user.email });
    // Run in the BACKGROUND so the UI can poll the unified progress indicator.
    void runJob(res.jobId, { actor: user.email }).catch((e) => console.error("[rename] job run failed", e));
    revalidatePath("/modules/pdf-rename");
    return { jobId: res.jobId, total: res.total, alreadyRunning: Boolean(res.existingJobId) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Could not start the rename job." };
  }
}

/** Resume / retry all not-yet-renamed items in a job. */
export async function resumeRenameJobAction(formData: FormData): Promise<void> {
  const { user } = await requireAuth(PERMISSIONS.RENAME_APPLY);
  if (!user) return;
  const jobId = String(formData.get("jobId") ?? "");
  if (!jobId) return;
  void resumeJob(jobId, { actor: user.email }).catch((e) => console.error("[rename] resume failed", e));
}

/** Retry one item (re-analyze + re-apply). */
export async function retryRenameItemAction(formData: FormData): Promise<void> {
  const { user } = await requireAuth(PERMISSIONS.RENAME_APPLY);
  if (!user) return;
  const itemId = String(formData.get("itemId") ?? "");
  if (!itemId) return;
  void retryItem(itemId, { actor: user.email }).catch((e) => console.error("[rename] retry failed", e));
}

/** Apply a reviewer-entered invoice number to an item (manual correction). */
export async function correctRenameItemAction(formData: FormData): Promise<{ ok: boolean; message: string }> {
  const { user, error } = await requireAuth(PERMISSIONS.RENAME_APPLY);
  if (!user) return { ok: false, message: error ?? "Not permitted." };
  const itemId = String(formData.get("itemId") ?? "");
  const invoiceNumber = String(formData.get("invoiceNumber") ?? "");
  if (!itemId) return { ok: false, message: "No item specified." };
  return applyManualCorrection(itemId, invoiceNumber, { actor: user.email });
}

/** Gated apply of a single file ("Rename One PDF"). */
export async function renameOneAction(folder: string, fileName: string): Promise<FolderScanView> {
  const { user, error } = await requireAuth(PERMISSIONS.RENAME_APPLY);
  if (!user) return { error };
  if (!env.PDF_RENAME_ROOT) return { error: "PDF_RENAME_ROOT is not configured." };
  if (!fileName) return { error: "No file specified." };
  try {
    return await scanAndApply(folder, [fileName], user.email);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Rename failed." };
  }
}
