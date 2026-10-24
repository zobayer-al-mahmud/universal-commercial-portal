"use server";

import { revalidatePath } from "next/cache";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { beginContainerSearch } from "@/server/container/run";

export interface ContainerSearchActionResult {
  id?: string;
  status?: string;
  message?: string;
  reused?: boolean;
  error?: string;
}

/**
 * Run a CTG Port container search for a shipment's container number. Permission
 * is checked server-side; the heavy lifting (visible browser, portal, PDF
 * capture) happens in `startContainerSearch`, which is fail-closed and never
 * fabricates a result.
 */
export async function searchContainerAction(input: {
  containerNo: string;
  expectedLocation?: string;
  shipmentRef?: string;
  force?: boolean;
}): Promise<ContainerSearchActionResult> {
  const user = await getSessionUser();
  if (!user) return { error: "Not authenticated." };
  if (!userHasPermission(user, PERMISSIONS.CONTAINER_SEARCH)) return { error: "You do not have permission to run container searches." };

  const containerNo = (input.containerNo ?? "").trim();
  if (!containerNo) return { error: "Enter a container number." };

  try {
    const r = await beginContainerSearch({
      containerNo,
      expectedLocation: input.expectedLocation?.trim() || null,
      shipmentRef: input.shipmentRef?.trim() || null,
      actor: user.email,
      force: input.force,
    });
    revalidatePath("/modules/container");
    return r;
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Container search failed." };
  }
}
