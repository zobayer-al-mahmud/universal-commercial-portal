"use server";

import { revalidatePath } from "next/cache";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { runPdfCombine } from "@/server/pdf-combiner/run";
import { runMatrixCombine } from "@/server/pdf-combiner/run-matrix";
import { ensureActiveMaster, readActiveMasterBytes, saveActiveMaster } from "@/server/pdf-combiner/master-store";
import { applyCellEdits, type CellEdit } from "@/server/pdf-combiner/edit-master";
import { MATRIX_SHEET } from "@/server/pdf-combiner/parse-matrix";

export interface PdfCombineState {
  error?: string;
  runId?: string;
}

async function requireUser() {
  const user = await getSessionUser();
  if (!user) return { user: null as null, error: "Not authenticated." };
  if (!userHasPermission(user, PERMISSIONS.PDF_COMBINE)) return { user: null as null, error: "You do not have permission to use the PDF Combiner." };
  return { user, error: undefined };
}

/** Legacy generic combiner (upload master + select folders). Kept for compatibility. */
export async function runPdfCombineAction(_prev: PdfCombineState, formData: FormData): Promise<PdfCombineState> {
  const { user, error } = await requireUser();
  if (!user) return { error };
  const master = formData.get("master");
  if (!(master instanceof File) || master.name === "" || master.size === 0) return { error: "Upload the master Excel file." };
  const folders = formData.getAll("folders").map(String).filter(Boolean);
  if (folders.length === 0) return { error: "Select at least one folder." };
  try {
    const { runId } = await runPdfCombine({ masterFileName: master.name, masterData: Buffer.from(await master.arrayBuffer()), folders, actor: user.email });
    revalidatePath("/modules/pdf-combiner");
    return { runId };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "PDF combine failed." };
  }
}

export interface CombineResult {
  error?: string;
  runId?: string;
  totalRows?: number;
  completed?: number;
  failed?: number;
  skipped?: number;
}

/** Combine every eligible row of the active master into one PDF each. */
export async function combineAllRows(): Promise<CombineResult> {
  const { user, error } = await requireUser();
  if (!user) return { error };
  try {
    const r = await runMatrixCombine({ actor: user.email });
    revalidatePath("/modules/pdf-combiner");
    return { runId: r.runId, totalRows: r.totalRows, completed: r.completed, failed: r.failed, skipped: r.skipped };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Combine all failed." };
  }
}

/** Combine a single worksheet row of the active master. */
export async function combineOneRow(rowNo: number): Promise<CombineResult> {
  const { user, error } = await requireUser();
  if (!user) return { error };
  if (!Number.isInteger(rowNo) || rowNo < 1) return { error: "Invalid row." };
  try {
    const r = await runMatrixCombine({ actor: user.email, rowNos: [rowNo] });
    revalidatePath("/modules/pdf-combiner");
    return { runId: r.runId, totalRows: r.totalRows, completed: r.completed, failed: r.failed, skipped: r.skipped };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Combine row failed." };
  }
}

export interface SaveRowsResult { error?: string; saved?: number; eligible?: number; version?: number }

/** Apply cell edits to CLABING HERE-F of the active master (surgical, preserves the workbook). */
export async function saveMasterCells(edits: CellEdit[]): Promise<SaveRowsResult> {
  const { user, error } = await requireUser();
  if (!user) return { error };
  const clean = (edits ?? []).filter((e) => Number.isInteger(e.rowNo) && Number.isInteger(e.col) && e.rowNo >= 1 && e.col >= 1);
  if (clean.length === 0) return { error: "No changes to save." };
  try {
    const current = await ensureActiveMaster(user.email);
    const bytes = await readActiveMasterBytes(user.email);
    const edited = await applyCellEdits(bytes, MATRIX_SHEET, clean);
    const saved = await saveActiveMaster(edited, { fileName: current.fileName, actor: user.email, action: "pdf-combiner.master.edited", note: `${clean.length} cell(s) edited` });
    revalidatePath("/modules/pdf-combiner");
    return { saved: clean.length, eligible: saved.eligible, version: saved.master.version };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Save failed." };
  }
}
