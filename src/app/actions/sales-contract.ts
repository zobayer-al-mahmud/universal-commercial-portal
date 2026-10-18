"use server";

import { revalidatePath } from "next/cache";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { intakeOrderPackage, type IntakeResult } from "@/server/sales-contract/intake";

export interface IntakeActionState {
  error?: string;
  result?: IntakeResult;
}

export async function intakeAction(
  _prev: IntakeActionState,
  formData: FormData,
): Promise<IntakeActionState> {
  const user = await getSessionUser();
  if (!user) return { error: "Not authenticated." };
  if (!userHasPermission(user, PERMISSIONS.JOB_CREATE))
    return { error: "You do not have permission to create jobs." };

  const subject = String(formData.get("subject") ?? "").trim();
  if (!subject) return { error: "Order Package subject is required." };

  const attachmentsRaw = String(formData.get("attachments") ?? "");
  const attachments = attachmentsRaw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);

  const poText = String(formData.get("poText") ?? "");
  const blockContractRef = String(formData.get("blockContractRef") ?? "").trim() || undefined;

  try {
    const result = await intakeOrderPackage(
      { subject, attachments, poText, blockContractRef, sender: user.email },
      { actor: user.email },
    );
    revalidatePath("/dashboard");
    revalidatePath("/jobs");
    revalidatePath("/review");
    return { result };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Intake failed." };
  }
}
