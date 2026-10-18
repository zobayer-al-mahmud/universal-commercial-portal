"use server";

import { revalidatePath } from "next/cache";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { intakeWeekSchedule, type ScheduleIntakeResult } from "@/server/shipment-schedule/intake";

export interface ScheduleActionState {
  error?: string;
  result?: ScheduleIntakeResult;
}

export async function scheduleAction(
  _prev: ScheduleActionState,
  formData: FormData,
): Promise<ScheduleActionState> {
  const user = await getSessionUser();
  if (!user) return { error: "Not authenticated." };
  if (!userHasPermission(user, PERMISSIONS.JOB_CREATE))
    return { error: "You do not have permission to create jobs." };

  const weekTitle = String(formData.get("weekTitle") ?? "").trim();
  const csv = String(formData.get("csv") ?? "").trim();
  const invoiceStartRaw = String(formData.get("invoiceStart") ?? "").trim();
  const invoiceStart = invoiceStartRaw ? parseInt(invoiceStartRaw.replace(/[^\d]/g, ""), 10) : undefined;

  if (!weekTitle) return { error: "Week title is required." };
  if (!csv) return { error: "Paste the orders CSV first." };

  try {
    const result = await intakeWeekSchedule(weekTitle, csv, { actor: user.email, invoiceStart });
    revalidatePath("/modules/shipment-schedule");
    revalidatePath("/jobs");
    revalidatePath("/dashboard");
    return { result };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Schedule build failed." };
  }
}
