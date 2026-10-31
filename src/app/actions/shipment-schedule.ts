"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import {
  createSchedule,
  updateScheduleTitle,
  addCutoff,
  updateCutoff,
  deleteCutoff,
  moveRowToCutoff,
  deleteRow,
  allocateInvoiceNumbers,
} from "@/server/shipment-schedule/intake";
import { isEditableField, validateField, type EditableField } from "@/server/shipment-schedule/edit";
import { findRowOwningInvoiceNo } from "@/server/shipment-schedule/intake";

export interface CreateScheduleState {
  error?: string;
}

export async function createScheduleAction(_prev: CreateScheduleState, formData: FormData): Promise<CreateScheduleState> {
  const user = await getSessionUser();
  if (!user) return { error: "Not authenticated." };
  if (!userHasPermission(user, PERMISSIONS.JOB_CREATE)) return { error: "Forbidden." };

  const weekNoRaw = String(formData.get("weekNo") ?? "").trim();
  const weekNo = weekNoRaw ? parseInt(weekNoRaw.replace(/[^\d]/g, ""), 10) : null;
  if (weekNo === null || !Number.isFinite(weekNo) || weekNo < 1) {
    return { error: "Week number is required." };
  }

  // Title auto-generated from the week number; user can rename it on the detail page.
  const weekTitle = `Week ${String(weekNo).padStart(2, "0")}`;
  const { id } = await createSchedule({ weekTitle, weekNo, actor: user.email });

  revalidatePath("/shipment-schedule");
  redirect(`/shipment-schedule/${id}`);
}

export async function updateScheduleTitleAction(formData: FormData): Promise<void> {
  const user = await getSessionUser();
  if (!user || !userHasPermission(user, PERMISSIONS.JOB_CREATE)) return;
  const id = String(formData.get("id") ?? "");
  const weekTitle = String(formData.get("weekTitle") ?? "").trim();
  const weekNoRaw = String(formData.get("weekNo") ?? "").trim();
  const weekNo = weekNoRaw ? parseInt(weekNoRaw.replace(/[^\d]/g, ""), 10) : null;
  if (!id || !weekTitle) return;
  await updateScheduleTitle(id, weekTitle, Number.isFinite(weekNo as number) ? (weekNo as number) : null, user.email);
  revalidatePath(`/shipment-schedule/${id}`);
}

export async function addCutoffAction(formData: FormData): Promise<void> {
  const user = await getSessionUser();
  if (!user || !userHasPermission(user, PERMISSIONS.JOB_CREATE)) return;
  const scheduleId = String(formData.get("scheduleId") ?? "");
  const label = String(formData.get("label") ?? "").trim();
  const date = String(formData.get("date") ?? "").trim();
  if (!scheduleId || !label) return;
  await addCutoff(scheduleId, label, date, user.email);
  revalidatePath(`/shipment-schedule/${scheduleId}`);
}

export async function updateCutoffAction(formData: FormData): Promise<void> {
  const user = await getSessionUser();
  if (!user || !userHasPermission(user, PERMISSIONS.JOB_CREATE)) return;
  const id = String(formData.get("id") ?? "");
  const scheduleId = String(formData.get("scheduleId") ?? "");
  const label = String(formData.get("label") ?? "").trim();
  const date = String(formData.get("date") ?? "").trim();
  if (!id || !label) return;
  await updateCutoff(id, label, date, user.email);
  revalidatePath(`/shipment-schedule/${scheduleId}`);
}

export async function deleteCutoffAction(formData: FormData): Promise<void> {
  const user = await getSessionUser();
  if (!user || !userHasPermission(user, PERMISSIONS.JOB_CREATE)) return;
  const id = String(formData.get("id") ?? "");
  const scheduleId = String(formData.get("scheduleId") ?? "");
  if (!id) return;
  await deleteCutoff(id, user.email);
  revalidatePath(`/shipment-schedule/${scheduleId}`);
}

export async function moveRowToCutoffAction(formData: FormData): Promise<void> {
  const user = await getSessionUser();
  if (!user || !userHasPermission(user, PERMISSIONS.JOB_CREATE)) return;
  const rowId = String(formData.get("rowId") ?? "");
  const cutoffId = String(formData.get("cutoffId") ?? "");
  const scheduleId = String(formData.get("scheduleId") ?? "");
  if (!rowId || !cutoffId) return;
  await moveRowToCutoff(rowId, cutoffId, user.email);
  revalidatePath(`/shipment-schedule/${scheduleId}`);
}

export interface AllocateInvoiceState {
  ok?: boolean;
  error?: string;
  message?: string;
}

export async function allocateInvoiceNumbersAction(
  _prev: AllocateInvoiceState,
  formData: FormData,
): Promise<AllocateInvoiceState> {
  const user = await getSessionUser();
  if (!user) return { error: "Not authenticated." };
  if (!userHasPermission(user, PERMISSIONS.JOB_CREATE)) return { error: "Forbidden." };
  const scheduleId = String(formData.get("scheduleId") ?? "").trim();
  const startRaw = String(formData.get("startNumber") ?? "").trim();
  if (!scheduleId) return { error: "Missing scheduleId." };
  if (!/^\d+$/.test(startRaw)) return { error: "Starting invoice number must be a whole number." };
  try {
    const r = await allocateInvoiceNumbers({ scheduleId, startNumber: Number(startRaw), actor: user.email });
    revalidatePath(`/shipment-schedule/${scheduleId}`);
    if (r.updated === 0) return { ok: true, message: "No rows in this week yet — nothing to number." };
    return {
      ok: true,
      message: `Allocated ${r.updated} invoice number(s): ${r.firstAssigned} → ${r.lastAssigned}.`,
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Allocation failed." };
  }
}

export async function deleteRowAction(formData: FormData): Promise<void> {
  const user = await getSessionUser();
  if (!user || !userHasPermission(user, PERMISSIONS.JOB_CREATE)) return;
  const rowId = String(formData.get("rowId") ?? "");
  const scheduleId = String(formData.get("scheduleId") ?? "");
  if (!rowId) return;
  await deleteRow(rowId, user.email);
  revalidatePath(`/shipment-schedule/${scheduleId}`);
}

export interface EditRowState {
  ok?: boolean;
  errors?: string[];
}

/**
 * Apply a whole-row inline edit. Each FormData entry whose key is an editable
 * field name becomes a candidate change; only values that actually differ from
 * the stored row (after normalisation) are persisted. Each change is recorded
 * in ShipmentScheduleRowEdit (append-only history) with the editor + a reason.
 * Validation errors on any field abort the whole save (no partial writes).
 */
export async function editRowAction(_prev: EditRowState, formData: FormData): Promise<EditRowState> {
  const user = await getSessionUser();
  if (!user) return { errors: ["Not authenticated."] };
  if (!userHasPermission(user, PERMISSIONS.JOB_CREATE)) return { errors: ["Forbidden."] };

  const rowId = String(formData.get("rowId") ?? "");
  const scheduleId = String(formData.get("scheduleId") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  if (!rowId) return { errors: ["Missing rowId."] };

  const row = await prisma.shipmentScheduleRow.findUnique({ where: { id: rowId } });
  if (!row) return { errors: ["Row not found."] };

  // Collect edits from the form, validate each.
  const errors: string[] = [];
  const patch: Record<string, string | number | null> = {};
  const changes: { field: EditableField; oldValue: string; newValue: string }[] = [];
  for (const [key, raw] of formData.entries()) {
    if (!isEditableField(key)) continue;
    const v = validateField(key, String(raw));
    if (!v.ok) {
      errors.push(v.error ?? `Invalid value for ${key}.`);
      continue;
    }
    const stored = (row as Record<string, unknown>)[key];
    const storedNorm = stored == null ? "" : String(stored);
    const nextNorm = v.normalized == null ? "" : String(v.normalized);
    if (storedNorm === nextNorm) continue; // no-op
    patch[key] = v.normalized;
    changes.push({ field: key, oldValue: storedNorm, newValue: nextNorm });
  }

  if (errors.length > 0) return { errors };
  if (changes.length === 0) return { ok: true };

  // Global uniqueness: one invoiceNo lives on at most one row across every
  // schedule + cut-off. If this edit is trying to set a value that another
  // row already owns, reject with a message pointing at the conflicting row.
  const invoiceEdit = changes.find((c) => c.field === "invoiceNo");
  if (invoiceEdit && invoiceEdit.newValue.trim() !== "") {
    const owner = await findRowOwningInvoiceNo(invoiceEdit.newValue, rowId);
    if (owner) {
      return {
        errors: [
          `Invoice No. "${invoiceEdit.newValue}" is already used on Order ${owner.orderNo} in “${owner.weekTitle} · ${owner.cutoffLabel}”. Each invoice number must be unique across every week.`,
        ],
      };
    }
  }

  // Mark the row edited.
  patch["editState"] = "edited";
  patch["editedBy"] = user.email;
  patch["editedAt"] = new Date() as unknown as string;

  await prisma.$transaction([
    prisma.shipmentScheduleRow.update({ where: { id: rowId }, data: patch }),
    ...changes.map((c) =>
      prisma.shipmentScheduleRowEdit.create({
        data: { rowId, field: c.field, oldValue: c.oldValue, newValue: c.newValue, reason, editor: user.email },
      }),
    ),
  ]);
  await audit({
    entityType: "shipment-schedule",
    entityId: scheduleId || row.scheduleId,
    action: "row.edited",
    actor: user.email,
    data: { rowId, changes: changes.map((c) => ({ field: c.field, oldValue: c.oldValue, newValue: c.newValue })), reason },
  });
  revalidatePath(`/shipment-schedule/${scheduleId || row.scheduleId}`);
  return { ok: true };
}
