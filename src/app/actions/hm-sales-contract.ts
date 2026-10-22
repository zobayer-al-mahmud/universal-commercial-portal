"use server";

import { revalidatePath } from "next/cache";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import {
  createHmContract,
  recordHmRowEdit,
  updateHmContractHeader,
  type HmHeaderPatch,
} from "@/server/hm-sales-contract/intake";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";

/** Create a blank H&M Sales Contract and return its id so the caller can
 *  redirect to the detail page. Requires JOB_CREATE. */
export async function createHmSalesContractAction(): Promise<{ id?: string; error?: string }> {
  const user = await getSessionUser();
  if (!user) return { error: "Not authenticated." };
  if (!userHasPermission(user, PERMISSIONS.JOB_CREATE)) return { error: "Forbidden." };
  const id = await createHmContract({ actor: user.email });
  revalidatePath("/modules/hm-sales-contract");
  return { id };
}

/** Save Sales Contract-level header fields (A/B/C/D/E/P/Q/S defaults). */
export async function updateHmHeaderAction(formData: FormData): Promise<void> {
  const user = await getSessionUser();
  if (!user || !userHasPermission(user, PERMISSIONS.JOB_CREATE)) return;
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const patch: HmHeaderPatch = {
    marchentContNo: String(formData.get("marchentContNo") ?? ""),
    contractDate: String(formData.get("contractDate") ?? ""),
    buyerCode: String(formData.get("buyerCode") ?? ""),
    commercialContNo: String(formData.get("commercialContNo") ?? ""),
    commercialDate: String(formData.get("commercialDate") ?? ""),
    merchandiserName: String(formData.get("merchandiserName") ?? ""),
    packSet: String(formData.get("packSet") ?? ""),
    remarksDefault: String(formData.get("remarksDefault") ?? ""),
  };
  await updateHmContractHeader(id, patch, { actor: user.email });
  revalidatePath(`/hm-sales-contract/${id}`);
}

/** Persist a user edit to a single row (overrides A..U cells for that row). */
export async function editHmRowAction(formData: FormData): Promise<void> {
  const user = await getSessionUser();
  if (!user || !userHasPermission(user, PERMISSIONS.JOB_CREATE)) return;
  const poId = String(formData.get("poId") ?? "");
  const marketCode = String(formData.get("marketCode") ?? "");
  const contractId = String(formData.get("contractId") ?? "");
  if (!poId || !marketCode) return;

  // Every Sales Contract column is user-editable (2026-10-20 spec). The
  // numeric columns (orderQty, fob, totalWithPacks, value) accept decimals;
  // string columns pass through as typed.
  const editable: (keyof import("@/server/hm-sales-contract").HmFlatCells)[] = [
    "marchentContNo", "buyerCode", "commercialContNo", "orderNo", "orderQty",
    "styleNo", "fob", "itemDes", "cat", "hts", "tod", "country", "remarks",
    "merchandiserName", "packSet", "withoutDiscount", "discountFobDate",
    "totalWithPacks", "value",
  ];
  const numericKeys = new Set(["orderQty", "fob", "totalWithPacks", "value"]);
  const over: Record<string, unknown> = {};
  for (const k of editable) {
    const v = formData.get(k);
    if (v === null) continue;
    const s = String(v);
    if (numericKeys.has(k)) {
      const n = s.trim() === "" ? null : Number(s);
      over[k] = Number.isFinite(n) ? n : null;
    } else {
      over[k] = s;
    }
  }
  await recordHmRowEdit(poId, marketCode, over, { actor: user.email });
  revalidatePath(`/hm-sales-contract/${contractId}`);
  revalidatePath(`/sales-contract/view/${contractId}`);
}

/** Delete a PO's three-PDF set from a contract. */
export async function deleteHmPoAction(formData: FormData): Promise<void> {
  const user = await getSessionUser();
  if (!user || !userHasPermission(user, PERMISSIONS.JOB_CREATE)) return;
  const poId = String(formData.get("poId") ?? "");
  const contractId = String(formData.get("contractId") ?? "");
  if (!poId) return;
  await prisma.hmSalesContractPo.delete({ where: { id: poId } });
  await audit({ entityType: "document", entityId: poId, action: "hm.po.deleted", actor: user.email, data: { contractId } });
  revalidatePath(`/hm-sales-contract/${contractId}`);
}
