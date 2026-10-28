"use server";

import { revalidatePath } from "next/cache";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { prisma } from "@/lib/db";
import { createInvoiceForOrder, deleteInvoice, updateInvoiceFields } from "@/server/customs-invoice/intake";
import { buildPrefill } from "@/server/customs-invoice/pull-data";
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
  const invoiceNo = String(formData.get("invoiceNo") ?? "").trim();

  try {
    const r = await createInvoiceForOrder(orderNo, { actor: user.email, invoiceNo });
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

export interface RefillInvoiceState {
  error?: string;
  updated?: number;
  message?: string;
}

/**
 * Backfill header fields on an existing invoice from the current Sales
 * Contract + Shipment Schedule prefill. Only writes fields that are STILL
 * BLANK on the invoice — never overwrites a user-edited value. Primarily used
 * so an invoice that was created before the shipment-schedule row carried an
 * Invoice No. / Expected Delivery can pick them up now, without a delete.
 */
export async function refillInvoiceFromSourcesAction(
  _prev: RefillInvoiceState,
  formData: FormData,
): Promise<RefillInvoiceState> {
  const user = await getSessionUser();
  if (!user) return { error: "Not authenticated." };
  if (!userHasPermission(user, PERMISSIONS.JOB_CREATE))
    return { error: "You do not have permission to refill invoices." };

  const invoiceId = String(formData.get("invoiceId") ?? "").trim();
  if (!invoiceId) return { error: "Invoice id is required." };

  const inv = await prisma.customsInvoice.findUnique({ where: { id: invoiceId } });
  if (!inv) return { error: "Invoice not found." };

  // Prefer the specific shipment row this invoice tracks (matched by its
  // Invoice No.). Falls back to Order-No-only prefill when the invoice has
  // no number yet.
  const prefill = await buildPrefill(inv.orderNo, { invoiceNo: inv.invoiceNumber });
  if (!prefill) return { error: "No sales-contract / shipment-schedule prefill available for this order." };

  // Mechanical / derived fields (country code + resolved template code) always
  // re-sync from the latest prefill, since they are derived from the shipment
  // row's sub-code deterministically rather than typed in by a user. This is
  // the only way an invoice created before the sub-code → country mapping was
  // fixed (e.g. a row showing marketCode="OE" when the real sub was MYW069 →
  // MY) can pick up the corrected country without a delete+recreate.
  const patch: Partial<InvoiceFields> = {};
  if (prefill.marketCode && prefill.marketCode !== inv.marketCode) patch.marketCode = prefill.marketCode;
  if (prefill.countryCode && prefill.countryCode !== inv.countryCode) patch.countryCode = prefill.countryCode;
  if (prefill.marketSubCode && prefill.marketSubCode !== inv.marketSubCode) patch.marketSubCode = prefill.marketSubCode;

  // Descriptive fields: only fill when still blank. User edits stay sticky.
  if (!inv.invoiceNumber && prefill.invoiceNo) patch.invoiceNumber = prefill.invoiceNo;
  if (!inv.invoiceDate && prefill.expectedDelivery) patch.invoiceDate = prefill.expectedDelivery;
  if (!inv.contractNo && prefill.contractNo) patch.contractNo = prefill.contractNo;
  if (!inv.contractDate && prefill.contractDate) patch.contractDate = prefill.contractDate;
  if (!inv.hmOrderNo && prefill.hmOrderNo) patch.hmOrderNo = prefill.hmOrderNo;
  if (!inv.buyerCode && prefill.buyerCode) patch.buyerCode = prefill.buyerCode;
  if (!inv.styleNo && prefill.styleNo) patch.styleNo = prefill.styleNo;
  if (!inv.descriptionOfGoods && prefill.descriptionOfGoods) patch.descriptionOfGoods = prefill.descriptionOfGoods;
  if (!inv.portOfLoading && prefill.portOfLoading) patch.portOfLoading = prefill.portOfLoading;
  if (!inv.portOfDischarge && prefill.portOfDischarge) patch.portOfDischarge = prefill.portOfDischarge;
  if (!inv.placeOfDelivery && prefill.placeOfDelivery) patch.placeOfDelivery = prefill.placeOfDelivery;
  if (!inv.transportMode && prefill.transportMode) patch.transportMode = prefill.transportMode;
  if (inv.unitPrice == null && prefill.unitPrice != null) patch.unitPrice = prefill.unitPrice;
  if (inv.quantityPcs == null && prefill.quantityPcs != null) patch.quantityPcs = prefill.quantityPcs;
  if (inv.grossWeightKg == null && prefill.grossWeightKg != null) patch.grossWeightKg = prefill.grossWeightKg;
  if (inv.totalCartons == null && prefill.totalCartons != null) patch.totalCartons = prefill.totalCartons;
  if (inv.measurementCbm == null && prefill.measurementCbm != null) patch.measurementCbm = prefill.measurementCbm;

  if (Object.keys(patch).length === 0) {
    return { updated: 0, message: "Already in sync — nothing to backfill from the sources." };
  }

  try {
    const r = await updateInvoiceFields(invoiceId, patch, { actor: user.email, source: "prefill" });
    revalidatePath(`/customs-invoice/${invoiceId}`);
    revalidatePath("/customs-invoice");
    return { updated: r.updated };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Refill failed." };
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
