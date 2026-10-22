"use server";

import { revalidatePath } from "next/cache";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { createInvoiceForOrder, deleteInvoice, updateInvoiceFields } from "@/server/customs-invoice/intake";
import { INVOICE_FLOAT_FIELDS, INVOICE_INT_FIELDS, INVOICE_STRING_FIELDS, type InvoiceFields } from "@/server/customs-invoice/types";

export interface CustomsInvoiceCreateState {
  error?: string;
  invoiceId?: string;
  duplicate?: boolean;
}

export async function createInvoiceAction(
  _prev: CustomsInvoiceCreateState,
  formData: FormData,
): Promise<CustomsInvoiceCreateState> {
  const user = await getSessionUser();
  if (!user) return { error: "Not authenticated." };
  if (!userHasPermission(user, PERMISSIONS.JOB_CREATE))
    return { error: "You do not have permission to create invoices." };

  const orderNo = String(formData.get("orderNo") ?? "").trim();
  if (!orderNo) return { error: "Order No is required." };

  try {
    const r = await createInvoiceForOrder(orderNo, { actor: user.email });
    revalidatePath("/customs-invoice");
    revalidatePath(`/customs-invoice/${r.invoiceId}`);
    return { invoiceId: r.invoiceId, duplicate: r.duplicate };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Create failed." };
  }
}

export interface CustomsInvoiceEditState {
  error?: string;
  updated?: number;
}

export async function updateInvoiceAction(
  _prev: CustomsInvoiceEditState,
  formData: FormData,
): Promise<CustomsInvoiceEditState> {
  const user = await getSessionUser();
  if (!user) return { error: "Not authenticated." };
  if (!userHasPermission(user, PERMISSIONS.JOB_CREATE))
    return { error: "You do not have permission to edit invoices." };

  const invoiceId = String(formData.get("invoiceId") ?? "").trim();
  if (!invoiceId) return { error: "Invoice id is required." };

  const patch: Record<string, unknown> = {};
  for (const key of INVOICE_STRING_FIELDS) {
    const v = formData.get(key);
    if (v != null) patch[key] = String(v);
  }
  for (const key of INVOICE_INT_FIELDS) {
    const v = formData.get(key);
    if (v != null) patch[key] = v === "" ? null : Number.parseInt(String(v).replace(/[^\d-]/g, ""), 10);
  }
  for (const key of INVOICE_FLOAT_FIELDS) {
    const v = formData.get(key);
    if (v != null) patch[key] = v === "" ? null : Number.parseFloat(String(v).replace(/[^\d.-]/g, ""));
  }

  try {
    const r = await updateInvoiceFields(invoiceId, patch as Partial<InvoiceFields>, { actor: user.email, source: "user" });
    revalidatePath(`/customs-invoice/${invoiceId}`);
    revalidatePath("/customs-invoice");
    return { updated: r.updated };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Save failed." };
  }
}

export async function deleteInvoiceAction(formData: FormData): Promise<void> {
  const user = await getSessionUser();
  if (!user) return;
  if (!userHasPermission(user, PERMISSIONS.JOB_CREATE)) return;
  const invoiceId = String(formData.get("invoiceId") ?? "").trim();
  if (!invoiceId) return;
  try { await deleteInvoice(invoiceId, { actor: user.email }); } catch { /* ignore */ }
  revalidatePath("/customs-invoice");
}
