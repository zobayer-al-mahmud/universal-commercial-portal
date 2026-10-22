"use server";

import { revalidatePath } from "next/cache";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { updateHmContractHeader, type HmHeaderPatch } from "@/server/hm-sales-contract/intake";

/**
 * Save the two banner fields (Block Contract Ref + Revise) typed by the user.
 * Called by `SalesContractBannerEditor`. These two fields are the ONLY header
 * values exported to the top of the master .xlsx; every other HmSalesContract
 * header column stays blank until a future spec adds UI for it.
 */
export async function updateSalesContractBannerAction(formData: FormData): Promise<void> {
  const user = await getSessionUser();
  if (!user || !userHasPermission(user, PERMISSIONS.JOB_CREATE)) return;
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const patch: HmHeaderPatch = {
    marchentContNo: String(formData.get("marchentContNo") ?? ""),
    reviseNo: String(formData.get("reviseNo") ?? ""),
  };
  await updateHmContractHeader(id, patch, { actor: user.email });
  revalidatePath(`/sales-contract/view/${id}`);
  revalidatePath("/modules/sales-contract");
}
