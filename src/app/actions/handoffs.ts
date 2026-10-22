"use server";

import { revalidatePath } from "next/cache";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { confirmContractJob } from "@/server/handoffs/service";

export async function confirmContractAction(formData: FormData) {
  const user = await getSessionUser();
  if (!user || !userHasPermission(user, PERMISSIONS.CONTRACT_APPROVE))
    throw new Error("Not authorised to confirm contracts.");
  const jobId = String(formData.get("jobId"));
  await confirmContractJob(jobId, user.email);
  revalidatePath(`/jobs/${jobId}`);
  revalidatePath("/dashboard");
}
