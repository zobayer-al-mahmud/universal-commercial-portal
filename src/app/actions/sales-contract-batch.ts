"use server";

import { revalidatePath } from "next/cache";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { audit } from "@/lib/audit";
import {
  createSalesContractBatch,
  processSalesContractBatch,
  processSalesBatchItem,
} from "@/server/sales-contract/batch";

export interface SalesUploadState {
  error?: string;
  batchId?: string;
  accepted?: number;
  duplicates?: number;
  rejected?: { name: string; reason: string }[];
}

/** Multi-PDF bulk upload → store → process (§3.1). */
export async function uploadSalesContractBatchAction(_prev: SalesUploadState, formData: FormData): Promise<SalesUploadState> {
  const user = await getSessionUser();
  if (!user) return { error: "Not authenticated." };
  if (!userHasPermission(user, PERMISSIONS.JOB_CREATE)) return { error: "You do not have permission to create jobs." };

  const entries = formData.getAll("files").filter((e): e is File => e instanceof File && e.size >= 0 && e.name !== "");
  if (entries.length === 0) return { error: "Select at least one PDF." };

  const blockRef = String(formData.get("blockRef") ?? "").trim() || undefined;

  try {
    const files = await Promise.all(entries.map(async (f) => ({ name: f.name, buffer: Buffer.from(await f.arrayBuffer()) })));
    const res = await createSalesContractBatch(files, { blockRef, actor: user.email });
    await processSalesContractBatch(res.batchId, { actor: user.email });
    revalidatePath("/modules/sales-contract");
    revalidatePath(`/sales-contract/${res.batchId}`);
    revalidatePath("/jobs");
    revalidatePath("/dashboard");
    return { batchId: res.batchId, accepted: res.accepted, duplicates: res.duplicates, rejected: res.rejected };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Upload failed." };
  }
}

/** Retry a single item independently (§2, AC-12). */
export async function retrySalesItemAction(formData: FormData): Promise<void> {
  const user = await getSessionUser();
  if (!user || !userHasPermission(user, PERMISSIONS.JOB_RETRY)) return;
  const itemId = String(formData.get("itemId") ?? "");
  const batchId = String(formData.get("batchId") ?? "");
  if (!itemId) return;
  await processSalesBatchItem(itemId, { actor: user.email, force: true });
  await audit({ entityType: "job", entityId: batchId, action: "sales.item.retried", actor: user.email, data: { itemId } });
  revalidatePath(`/sales-contract/${batchId}`);
  revalidatePath("/dashboard");
}

/** Reprocess all non-terminal items in a batch. */
export async function reprocessSalesBatchAction(formData: FormData): Promise<void> {
  const user = await getSessionUser();
  if (!user || !userHasPermission(user, PERMISSIONS.JOB_RETRY)) return;
  const batchId = String(formData.get("batchId") ?? "");
  if (!batchId) return;
  await processSalesContractBatch(batchId, { actor: user.email });
  revalidatePath(`/sales-contract/${batchId}`);
}
