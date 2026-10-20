"use server";

/**
 * Server action for the Sales Contract Creation module's new "pick a contract →
 * upload up to 3 PDFs" flow. Lives under /modules/sales-contract. The backend
 * reuses the H&M three-PDF-set tables (one row per unique PO per contract,
 * per-contract master workbook) because that is the only workable layout for
 * the real supplier PDFs — see docs/modules/hm-sales-contract.md.
 */

import { revalidatePath } from "next/cache";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { createHmContract, updateHmContractHeader } from "@/server/hm-sales-contract/intake";
import { uploadHmBatch, type BatchResult, type BatchFile, MAX_PDFS_PER_BATCH } from "@/server/hm-sales-contract/batch-upload";
import type { HmPdfKind } from "@/server/hm-sales-contract";

export interface PickUploadState {
  ok?: boolean;
  error?: string;
  result?: BatchResult;
  contractId?: string;
  marchentContNo?: string;
}

const KINDS: HmPdfKind[] = ["PurchaseOrder", "SizePerColourBreakdown", "TotalCountryBreakdown"];

/**
 * Entry action — the UI posts either an existing contractId OR a new
 * marchentContNo. Up to {@link MAX_PDFS_PER_BATCH} files follow, one per
 * named kind. Returns the per-PO decision table for the UI's result panel.
 */
export async function pickAndUploadSalesContractAction(
  _prev: PickUploadState,
  formData: FormData,
): Promise<PickUploadState> {
  const user = await getSessionUser();
  if (!user) return { error: "Not authenticated." };
  if (!userHasPermission(user, PERMISSIONS.JOB_CREATE)) return { error: "Forbidden." };

  const mode = String(formData.get("mode") ?? "pick");
  let contractId = String(formData.get("contractId") ?? "").trim();
  let marchentContNo = "";

  // "Create new" path: no contractId yet — we create one and immediately save
  // the user-typed Merchant Contract No. (column A) on it. We do NOT invent
  // Buyer Code or any other BR-HM-01..05-blocked field.
  if (mode === "new") {
    marchentContNo = String(formData.get("marchentContNo") ?? "").trim();
    if (!marchentContNo) return { error: "Please type a Merchant Contract No. for the new contract." };
    contractId = await createHmContract({ actor: user.email });
    await updateHmContractHeader(contractId, { marchentContNo }, { actor: user.email });
  }

  if (!contractId) return { error: "Please select a target Sales Contract or create a new one." };

  // Collect up to 3 kind-tagged files. The UI uses three named inputs so each
  // file arrives with its kind already assigned. Fewer than 3 is allowed; max
  // is enforced in `validateBatchFiles`.
  const files: BatchFile[] = [];
  for (const kind of KINDS) {
    const entry = formData.get(kind);
    if (!(entry instanceof File) || entry.size === 0 || entry.name === "") continue;
    files.push({ name: entry.name, buffer: Buffer.from(await entry.arrayBuffer()), kind });
  }
  if (files.length === 0) return { error: "No PDFs supplied — select at least one of the three PDF slots." };

  try {
    const result = await uploadHmBatch(contractId, files, { actor: user.email });
    // Make the detail page (where the user downloads the master Excel) see
    // the fresh PO rows.
    revalidatePath(`/hm-sales-contract/${contractId}`);
    revalidatePath("/modules/sales-contract");
    return { ok: true, result, contractId, marchentContNo: marchentContNo || undefined };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Batch upload failed." };
  }
}
