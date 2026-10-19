"use server";

import { revalidatePath } from "next/cache";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { applyRenameBatch, type ApplyResult } from "@/server/pdf-rename/apply";

export interface RenameApplyState {
  error?: string;
  result?: ApplyResult;
}

export async function applyRenameAction(
  _prev: RenameApplyState,
  formData: FormData,
): Promise<RenameApplyState> {
  const user = await getSessionUser();
  if (!user) return { error: "Not authenticated." };
  if (!userHasPermission(user, PERMISSIONS.RENAME_APPLY))
    return { error: "You do not have permission to apply a rename plan." };

  const jobId = String(formData.get("jobId") ?? "");
  const dryRun = String(formData.get("mode") ?? "dryrun") !== "apply";

  try {
    const result = await applyRenameBatch(jobId, { actor: user.email, dryRun });
    revalidatePath(`/jobs/${jobId}`);
    return { result };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Apply failed." };
  }
}
