"use server";

import { revalidatePath } from "next/cache";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { validateScheduleEdit, recomputeLineValue } from "@/server/shipment-schedule/edit";

export interface ScheduleEditState {
  error?: string;
  ok?: boolean;
  field?: string;
}

/**
 * Apply one in-portal edit to a shipment schedule line (§4.2). Role-gated,
 * field-level validated, append-only audited (original → edited, editor,
 * timestamp, reason). The source PDF is never altered. A PCS/FOB edit
 * recomputes the line value.
 */
export async function editScheduleLineAction(_prev: ScheduleEditState, formData: FormData): Promise<ScheduleEditState> {
  const user = await getSessionUser();
  if (!user) return { error: "Not authenticated." };
  if (!userHasPermission(user, PERMISSIONS.SCHEDULE_EDIT)) return { error: "You do not have permission to edit schedule lines." };

  const lineId = String(formData.get("lineId") ?? "");
  const field = String(formData.get("field") ?? "");
  const value = String(formData.get("value") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  if (!lineId || !field) return { error: "Missing line or field.", field };
  if (!reason) return { error: "A change reason is required.", field };

  const line = await prisma.shipmentScheduleLine.findUnique({ where: { id: lineId } });
  if (!line) return { error: "Schedule line not found.", field };
  if (line.editState === "approved") return { error: "This line is approved and locked; reopen it before editing.", field };

  const check = validateScheduleEdit(field, value);
  if (!check.ok) return { error: check.error ?? "Invalid value.", field };

  const oldValue = String((line as Record<string, unknown>)[field] ?? "");
  if (oldValue === check.normalized) return { ok: true, field }; // no-op

  // Build the typed update patch.
  const data: Record<string, unknown> = { editState: "edited", editedBy: user.email, editedAt: new Date() };
  if (field === "pcs") {
    const pcs = parseInt(check.normalized, 10);
    data.pcs = pcs;
    data.value = recomputeLineValue(pcs, line.fob);
  } else if (field === "fob") {
    const fob = Number(check.normalized);
    data.fob = fob;
    data.value = recomputeLineValue(line.pcs, fob);
  } else {
    data[field] = check.normalized;
  }

  await prisma.shipmentScheduleLine.update({ where: { id: lineId }, data });
  await prisma.shipmentScheduleLineEdit.create({
    data: { lineId, field, oldValue, newValue: check.normalized, reason, editor: user.email },
  });
  await audit({
    entityType: "job",
    entityId: line.jobId,
    action: "schedule.line.edited",
    actor: user.email,
    data: { lineId, field, oldValue, newValue: check.normalized, reason },
  });

  revalidatePath(`/jobs/${line.jobId}`);
  return { ok: true, field };
}

/** Submit or approve an edited line per the authorization workflow (§4.2). */
export async function setScheduleLineStateAction(formData: FormData): Promise<void> {
  const user = await getSessionUser();
  if (!user) return;
  const lineId = String(formData.get("lineId") ?? "");
  const target = String(formData.get("target") ?? ""); // submitted | approved | edited(reopen)
  if (!lineId) return;
  const line = await prisma.shipmentScheduleLine.findUnique({ where: { id: lineId } });
  if (!line) return;

  if (target === "submitted") {
    if (!userHasPermission(user, PERMISSIONS.SCHEDULE_EDIT)) return;
  } else if (!userHasPermission(user, PERMISSIONS.SCHEDULE_APPROVE)) {
    return; // approve / reopen require approver
  }

  await prisma.shipmentScheduleLine.update({ where: { id: lineId }, data: { editState: target } });
  await audit({ entityType: "job", entityId: line.jobId, action: `schedule.line.${target}`, actor: user.email, data: { lineId } });
  revalidatePath(`/jobs/${line.jobId}`);
}
