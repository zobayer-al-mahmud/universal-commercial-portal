"use server";

import { revalidatePath } from "next/cache";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import {
  upsertFolderMapping,
  upsertBuyerCode,
  setCurrentContract,
  reassignPoToContract,
} from "@/server/sales-contract/config-intake";

/**
 * These actions return `void` so they can be bound directly to `<form action>`
 * props. Validation failures are logged and audited; the UI reflects the
 * resulting DB state after revalidation.
 */
export async function saveFolderMappingAction(formData: FormData): Promise<void> {
  const user = await getSessionUser();
  if (!user) return;
  if (!userHasPermission(user, PERMISSIONS.JOB_CREATE)) return;
  const folderLetter = String(formData.get("folderLetter") ?? "").trim().toUpperCase();
  if (!folderLetter) return;
  const sequence = Number(formData.get("sequence") ?? "0") || 0;
  const commercialDate = String(formData.get("commercialDate") ?? "").trim();
  const sourceFolderPath = String(formData.get("sourceFolderPath") ?? "").trim();
  const merchandisers = String(formData.get("merchandisers") ?? "")
    .split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const active = String(formData.get("active") ?? "true") !== "false";
  try {
    await upsertFolderMapping({ folderLetter, sequence, merchandisers, commercialDate, sourceFolderPath, active }, { actor: user.email });
    revalidatePath("/sales-contract/config");
  } catch (e) {
    console.error("saveFolderMappingAction", e);
  }
}

/** Scan the configured local folder for .msg files and import complete 3-PDF
 *  sets into the given Sales Contract. Returns a result summary via query redirect. */
export async function scanFolderAction(formData: FormData): Promise<void> {
  const user = await getSessionUser();
  if (!user) return;
  if (!userHasPermission(user, PERMISSIONS.JOB_CREATE)) return;
  const contractId = String(formData.get("contractId") ?? "").trim();
  const folderLetter = String(formData.get("folderLetter") ?? "").trim().toUpperCase();
  if (!contractId || !folderLetter) return;
  const { scanConfiguredFolder } = await import("@/server/sales-contract/scan-folder");
  try {
    const r = await scanConfiguredFolder({ contractId, folderLetter, actor: user.email });
    console.log(`[scanFolderAction] ${folderLetter}: scanned=${r.preview.foldersFound}, imported=${r.commit.imported.length}, skipped=${r.commit.skipped.length}`);
    revalidatePath(`/sales-contract/${contractId}`);
    revalidatePath("/sales-contract");
  } catch (e) {
    console.error("scanFolderAction", e);
    throw e;
  }
}

export async function saveBuyerCodeAction(formData: FormData): Promise<void> {
  const user = await getSessionUser();
  if (!user) return;
  if (!userHasPermission(user, PERMISSIONS.JOB_CREATE)) return;
  const contractNo = String(formData.get("contractNo") ?? "").trim();
  const folderLetter = String(formData.get("folderLetter") ?? "").trim().toUpperCase();
  const buyerCode = String(formData.get("buyerCode") ?? "").trim();
  if (!contractNo || !folderLetter || !buyerCode) return;
  try {
    await upsertBuyerCode({ contractNo, folderLetter, buyerCode }, { actor: user.email });
    revalidatePath("/sales-contract/config");
  } catch (e) {
    console.error("saveBuyerCodeAction", e);
  }
}

export async function setCurrentContractAction(formData: FormData): Promise<void> {
  const user = await getSessionUser();
  if (!user) return;
  if (!userHasPermission(user, PERMISSIONS.JOB_CREATE)) return;
  const contractId = String(formData.get("contractId") ?? "").trim();
  if (!contractId) return;
  try {
    await setCurrentContract(contractId, { actor: user.email });
    revalidatePath("/sales-contract");
    revalidatePath(`/sales-contract/${contractId}`);
  } catch (e) {
    console.error("setCurrentContractAction", e);
  }
}

export async function reassignPoAction(formData: FormData): Promise<void> {
  const user = await getSessionUser();
  if (!user) return;
  if (!userHasPermission(user, PERMISSIONS.JOB_CREATE)) return;
  const poId = String(formData.get("poId") ?? "");
  const newContractId = String(formData.get("newContractId") ?? "");
  if (!poId || !newContractId) return;
  try {
    await reassignPoToContract(poId, newContractId, { actor: user.email });
    revalidatePath("/sales-contract");
  } catch (e) {
    console.error("reassignPoAction", e);
  }
}

/** Reassign by looking up the PO on the current contract by its Order No. */
export async function reassignPoByOrderNoAction(formData: FormData): Promise<void> {
  const user = await getSessionUser();
  if (!user) return;
  if (!userHasPermission(user, PERMISSIONS.JOB_CREATE)) return;
  const { prisma } = await import("@/lib/db");
  const fromContractId = String(formData.get("fromContractId") ?? "");
  const orderNo = String(formData.get("orderNo") ?? "").trim();
  const newContractId = String(formData.get("newContractId") ?? "");
  if (!fromContractId || !orderNo || !newContractId) return;
  try {
    const po = await prisma.salesContractPo.findUnique({
      where: { contractId_orderNo: { contractId: fromContractId, orderNo } },
    });
    if (!po) {
      console.error(`reassignPoByOrderNoAction: PO ${orderNo} not found on contract ${fromContractId}`);
      return;
    }
    await reassignPoToContract(po.id, newContractId, { actor: user.email });
    revalidatePath(`/sales-contract/${fromContractId}`);
    revalidatePath(`/sales-contract/${newContractId}`);
    revalidatePath("/sales-contract");
  } catch (e) {
    console.error("reassignPoByOrderNoAction", e);
  }
}
