"use server";

import { revalidatePath } from "next/cache";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { intakeRenameBatch, type RenameIntakeResult } from "@/server/pdf-rename/intake";
import type { RenameDocType } from "@/server/pdf-rename/types";

export interface RenameActionState {
  error?: string;
  result?: RenameIntakeResult;
}

export async function renameAction(
  _prev: RenameActionState,
  formData: FormData,
): Promise<RenameActionState> {
  const user = await getSessionUser();
  if (!user) return { error: "Not authenticated." };
  if (!userHasPermission(user, PERMISSIONS.JOB_CREATE))
    return { error: "You do not have permission to create jobs." };

  const csv = String(formData.get("csv") ?? "").trim();
  if (!csv) return { error: "Paste an extraction CSV first." };

  const docTypeRaw = String(formData.get("docType") ?? "auto");
  const docType = docTypeRaw === "auto" ? undefined : (docTypeRaw as RenameDocType);

  try {
    const result = await intakeRenameBatch(csv, { actor: user.email, docType });
    revalidatePath("/modules/pdf-rename");
    revalidatePath("/jobs");
    revalidatePath("/dashboard");
    return { result };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Rename planning failed." };
  }
}
