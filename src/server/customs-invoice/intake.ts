import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { buildPrefill, shortOrderKey } from "./pull-data";
import {
  DEFAULT_BUYER,
  DEFAULT_EXPORTER,
  INVOICE_FLOAT_FIELDS,
  INVOICE_INT_FIELDS,
  INVOICE_STRING_FIELDS,
  type InvoiceFields,
} from "./types";

export interface CreateInvoiceResult {
  invoiceId: string;
  orderNo: string;
  duplicate: boolean;
}

/** Create (or return existing) a CustomsInvoice for an Order No, prefilled from
 *  Sales Contract + Shipment Schedule. */
export async function createInvoiceForOrder(
  rawOrderNo: string,
  opts: { actor?: string } = {},
): Promise<CreateInvoiceResult> {
  const actor = opts.actor ?? "system";
  const orderNo = shortOrderKey(rawOrderNo);
  if (!orderNo) throw new Error("Order No is required.");

  const existing = await prisma.customsInvoice.findUnique({ where: { orderNo } });
  if (existing) return { invoiceId: existing.id, orderNo, duplicate: true };

  const prefill = await buildPrefill(orderNo);
  if (!prefill) throw new Error(`Order No ${orderNo} not found in Sales Contract or Shipment Schedule.`);

  const inv = await prisma.customsInvoice.create({
    data: {
      orderNo,
      countryCode: prefill.countryCode,
      marketCode: prefill.marketCode,
      marketSubCode: prefill.marketSubCode,
      contractNo: prefill.contractNo,
      contractDate: prefill.contractDate,
      hmOrderNo: prefill.hmOrderNo,
      buyerCode: prefill.buyerCode,
      styleNo: prefill.styleNo,
      descriptionOfGoods: prefill.descriptionOfGoods,
      unitPrice: prefill.unitPrice ?? null,
      quantityPcs: prefill.quantityPcs ?? null,
      portOfLoading: prefill.portOfLoading || "CHITTAGONG",
      portOfDischarge: prefill.portOfDischarge,
      placeOfDelivery: prefill.placeOfDelivery,
      transportMode: prefill.transportMode,
      grossWeightKg: prefill.grossWeightKg ?? null,
      totalCartons: prefill.totalCartons ?? null,
      measurementCbm: prefill.measurementCbm ?? null,
      exporterName: DEFAULT_EXPORTER,
      buyerName: DEFAULT_BUYER,
      consigneeName: DEFAULT_BUYER,
      createdBy: actor,
    },
  });

  await audit({
    entityType: "customs-invoice",
    entityId: inv.id,
    action: "customs-invoice.created",
    actor,
    data: { orderNo, countryCode: inv.countryCode },
  });

  return { invoiceId: inv.id, orderNo, duplicate: false };
}

/**
 * Apply a partial field patch to an invoice. Only known columns are written;
 * each changed field becomes a CustomsInvoiceEdit entry (append-only).
 */
export async function updateInvoiceFields(
  invoiceId: string,
  patch: Partial<InvoiceFields>,
  opts: { actor?: string; source?: "user" | "pdf-extract" | "prefill" } = {},
): Promise<{ updated: number }> {
  const actor = opts.actor ?? "system";
  const source = opts.source ?? "user";
  const current = await prisma.customsInvoice.findUnique({ where: { id: invoiceId } });
  if (!current) throw new Error("Invoice not found.");

  // Build the data object + edit entries from the patch, skipping no-op values.
  const data: Record<string, unknown> = {};
  const edits: { field: string; oldValue: string; newValue: string }[] = [];
  const strSet = new Set<string>(INVOICE_STRING_FIELDS as string[]);
  const intSet = new Set<string>(INVOICE_INT_FIELDS as string[]);
  const floatSet = new Set<string>(INVOICE_FLOAT_FIELDS as string[]);
  const cur = current as unknown as Record<string, unknown>;

  for (const [key, val] of Object.entries(patch)) {
    if (strSet.has(key)) {
      const next = typeof val === "string" ? val : val == null ? "" : String(val);
      const old = typeof cur[key] === "string" ? (cur[key] as string) : "";
      if (next === old) continue;
      data[key] = next;
      edits.push({ field: key, oldValue: old, newValue: next });
    } else if (intSet.has(key)) {
      const next = val == null || val === "" ? null : Number.parseInt(String(val).replace(/[^\d-]/g, ""), 10);
      const parsed = Number.isFinite(next as number) ? (next as number) : null;
      const old = (cur[key] as number | null) ?? null;
      if (parsed === old) continue;
      data[key] = parsed;
      edits.push({ field: key, oldValue: String(old ?? ""), newValue: String(parsed ?? "") });
    } else if (floatSet.has(key)) {
      const next = val == null || val === "" ? null : Number.parseFloat(String(val).replace(/[^\d.-]/g, ""));
      const parsed = Number.isFinite(next as number) ? (next as number) : null;
      const old = (cur[key] as number | null) ?? null;
      if (parsed === old) continue;
      data[key] = parsed;
      edits.push({ field: key, oldValue: String(old ?? ""), newValue: String(parsed ?? "") });
    }
    // Unknown fields are silently ignored (never trust client-side input).
  }

  if (edits.length === 0) return { updated: 0 };

  await prisma.$transaction([
    prisma.customsInvoice.update({ where: { id: invoiceId }, data }),
    ...edits.map((e) =>
      prisma.customsInvoiceEdit.create({
        data: { invoiceId, field: e.field, oldValue: e.oldValue, newValue: e.newValue, source, editedBy: actor },
      }),
    ),
  ]);

  await audit({
    entityType: "customs-invoice",
    entityId: invoiceId,
    action: "customs-invoice.edited",
    actor,
    data: { fields: edits.map((e) => e.field), source },
  });

  return { updated: edits.length };
}

export async function deleteInvoice(invoiceId: string, opts: { actor?: string } = {}): Promise<void> {
  const actor = opts.actor ?? "system";
  await prisma.customsInvoice.delete({ where: { id: invoiceId } });
  await audit({
    entityType: "customs-invoice",
    entityId: invoiceId,
    action: "customs-invoice.deleted",
    actor,
  });
}
