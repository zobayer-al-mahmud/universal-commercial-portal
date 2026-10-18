"use server";

import { revalidatePath } from "next/cache";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import {
  confirmContractJob,
  buildScheduleFromContracts,
  generateInvoiceFromLine,
} from "@/server/handoffs/service";

export async function confirmContractAction(formData: FormData) {
  const user = await getSessionUser();
  if (!user || !userHasPermission(user, PERMISSIONS.CONTRACT_APPROVE))
    throw new Error("Not authorised to confirm contracts.");
  const jobId = String(formData.get("jobId"));
  await confirmContractJob(jobId, user.email);
  revalidatePath(`/jobs/${jobId}`);
  revalidatePath("/modules/shipment-schedule");
  revalidatePath("/dashboard");
}

export interface ScheduleFromContractsState {
  error?: string;
  result?: { jobId: string; weekNo: number; lines: number; status: string };
}

export async function scheduleFromContractsAction(
  _prev: ScheduleFromContractsState,
  formData: FormData,
): Promise<ScheduleFromContractsState> {
  const user = await getSessionUser();
  if (!user || !userHasPermission(user, PERMISSIONS.JOB_CREATE))
    return { error: "Not authorised." };

  const weekTitle = String(formData.get("weekTitle") ?? "").trim();
  const invoiceStartRaw = String(formData.get("invoiceStart") ?? "").trim();
  const invoiceStart = invoiceStartRaw ? parseInt(invoiceStartRaw.replace(/[^\d]/g, ""), 10) : undefined;
  const rowIds = formData.getAll("rowIds").map((v) => String(v));

  try {
    const result = await buildScheduleFromContracts(weekTitle, rowIds, { actor: user.email, invoiceStart });
    revalidatePath("/modules/shipment-schedule");
    revalidatePath("/modules/customs-invoice");
    revalidatePath("/jobs");
    return { result };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Schedule build failed." };
  }
}

export async function generateInvoiceFromLineAction(formData: FormData) {
  const user = await getSessionUser();
  if (!user || !userHasPermission(user, PERMISSIONS.JOB_CREATE))
    throw new Error("Not authorised to generate invoices.");
  const lineId = String(formData.get("lineId"));
  await generateInvoiceFromLine(lineId, user.email);
  revalidatePath("/modules/customs-invoice");
  revalidatePath("/jobs");
}
