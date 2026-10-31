/**
 * Invoice-centric view of the Shipment Schedule — the data source for the
 * Customs Invoice Generation page (user rule 2026-10-28).
 *
 * The unique key is INVOICE NO. A row only appears here when the Shipment
 * Schedule row has BOTH:
 *   1. A booking-confirmation PDF already extracted (`pdfSha256 != ""`), AND
 *   2. An invoice number allocated (`invoiceNo != ""`).
 *
 * Everything the invoice needs (buyer, country+sub, FOB, qty, booking info,
 * ports, mode, gross weight, cartons, cbm) flows through from that one row.
 * Fields the PDFs don't carry are left blank for manual entry downstream.
 */
import { prisma } from "@/lib/db";
import { shortOrderKey } from "./pull-data";

export interface InvoiceReadyRow {
  invoiceNo: string;             // UNIQUE id, primary column
  rowId: string;                 // ShipmentScheduleRow.id

  // Order + sales-contract identity
  orderNo: string;               // short key, e.g. "643159"
  hmOrderNo: string;             // raw with suffix "643159-8756"
  contractNo: string;
  contractDate: string;
  buyerCode: string;

  // Country / template-selection keys
  countryCode: string;           // bare 2-letter market code
  countrySubCode: string;        // sub-code (goes to Country+Sub column)

  // Product
  styleNo: string;
  descriptionOfGoods: string;
  unitPrice: number | null;
  quantityPcs: number | null;    // per-market qty from the auto-router

  // Booking confirmation (hydrated by the folder scan)
  bcn: string;
  bookingRef: string;
  bookingStatus: string;
  portOfLoading: string;
  portOfDischarge: string;
  placeOfDelivery: string;
  transportMode: string;
  grossWeightKg: number | null;
  totalCartons: number | null;
  measurementCbm: number | null;

  // Downstream linkage
  hasInvoice: boolean;
  invoiceId: string | null;
  scheduleId: string;
  cutoffId: string;
  weekNo: number | null;
  weekTitle: string;
}

export async function listInvoiceReadyRows(): Promise<InvoiceReadyRow[]> {
  const [rows, invoices] = await Promise.all([
    prisma.shipmentScheduleRow.findMany({
      where: {
        AND: [
          { invoiceNo: { not: "" } },
          { pdfSha256: { not: "" } },
        ],
      },
      include: {
        schedule: { select: { weekNo: true, weekTitle: true } },
      },
      orderBy: [{ invoiceNo: "asc" }],
    }),
    prisma.customsInvoice.findMany({ select: { id: true, orderNo: true, invoiceNumber: true } }),
  ]);

  // Each (Order No., Invoice No.) pair is one invoice. We also keep an
  // Order-No-only fallback for invoices that were created before an Invoice
  // No. was allocated (invoiceNumber=""), so the row still shows "Open →"
  // when the shipment row later gets its Invoice No.
  const invoiceByPair = new Map<string, string>();
  const invoiceByOrderUnnumbered = new Map<string, string>();
  for (const inv of invoices) {
    const short = shortOrderKey(inv.orderNo);
    const key = `${short}|${inv.invoiceNumber}`;
    invoiceByPair.set(key, inv.id);
    if (!inv.invoiceNumber) invoiceByOrderUnnumbered.set(short, inv.id);
  }

  return rows.map<InvoiceReadyRow>((r) => {
    const short = shortOrderKey(r.orderNo);
    // Priority: exact (Order, Invoice No.) match → unnumbered legacy row.
    const existing =
      invoiceByPair.get(`${short}|${r.invoiceNo}`) ??
      invoiceByOrderUnnumbered.get(short) ??
      null;
    return {
      invoiceNo: r.invoiceNo,
      rowId: r.id,
      orderNo: short,
      hmOrderNo: r.orderNo,
      contractNo: r.contractNo,
      contractDate: r.contractDate,
      buyerCode: r.buyerCode,
      countryCode: r.marketCode,
      countrySubCode: r.marketSubCode,
      styleNo: r.style,
      descriptionOfGoods: r.composition,
      unitPrice: r.fob,
      quantityPcs: r.pcs,
      bcn: r.bcn,
      bookingRef: r.bookingRef,
      bookingStatus: r.bookingStatus,
      portOfLoading: r.portOfLoading,
      portOfDischarge: r.portOfDischarge,
      placeOfDelivery: r.placeOfDelivery,
      transportMode: r.transportMode,
      grossWeightKg: r.grossWeightKg,
      totalCartons: r.cartons,
      measurementCbm: r.measurementCbm,
      hasInvoice: !!existing,
      invoiceId: existing,
      scheduleId: r.scheduleId,
      cutoffId: r.cutoffId,
      weekNo: r.schedule.weekNo,
      weekTitle: r.schedule.weekTitle,
    };
  });
}
