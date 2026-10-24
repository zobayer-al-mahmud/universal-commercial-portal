"use server";

import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";
import { scanFolder, applyPlan, type PlanItem, type PlanSummary } from "@/server/pdf-rename/folder-rename";

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
