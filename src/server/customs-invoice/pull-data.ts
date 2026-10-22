import { prisma } from "@/lib/db";
import { listTemplates, resolveTemplate } from "./templates";
import type { InvoicePrefill } from "./types";

/**
 * The order-number key used across the three modules differs:
 *   - HmSalesContractPo.orderNo stores the SHORT key (e.g. "498160").
 *   - ShipmentScheduleRow.orderNo stores the SHORT key too; the raw PDF value
 *     (e.g. "498160/8757") lives in pdfOrderNo.
 * We normalise everything to the SHORT key for cross-module joining.
 */
export function shortOrderKey(raw: string): string {
  if (!raw) return "";
  const m = raw.match(/\d{6,}/);
  return m ? m[0] : raw.trim();
}

export interface OrderNoRow {
  orderNo: string; // short key — primary join field
  hmOrderNo: string; // raw with suffix if known
  marketCode: string;
  marketSubCode: string;
  contractNo: string;
  contractDate: string;
  buyerCode: string;
  styleNo: string;
  descriptionOfGoods: string;
  unitPrice: number | null;
  quantityPcs: number | null;
  portOfLoading: string;
  portOfDischarge: string;
  placeOfDelivery: string;
  transportMode: string;
  bookingRef: string;
  grossWeightKg: number | null;
  totalCartons: number | null;
  measurementCbm: number | null;
  foundInSalesContract: boolean;
  foundInShipmentSchedule: boolean;
  hasInvoice: boolean;
  invoiceId: string | null;
}

/**
 * List every unique Order No found across Sales Contract POs + Shipment
 * Schedule rows. For each one, surface the richest prefill we can derive
 * (sales-contract fields take precedence over schedule fields; schedule fills
 * the shipment side).
 */
export async function listOrderNosWithPrefill(): Promise<OrderNoRow[]> {
  // Load all three sources in parallel.
  const [pos, rows, invoices] = await Promise.all([
    prisma.hmSalesContractPo.findMany({
      where: { orderNo: { not: "" } },
      include: {
        contract: { select: { marchentContNo: true, contractDate: true, buyerCode: true } },
      },
    }),
    prisma.shipmentScheduleRow.findMany({ where: { orderNo: { not: "" } } }),
    prisma.customsInvoice.findMany({ select: { id: true, orderNo: true } }),
  ]);

  const invoiceByOrder = new Map<string, string>();
  for (const inv of invoices) invoiceByOrder.set(shortOrderKey(inv.orderNo), inv.id);

  const bucket = new Map<string, OrderNoRow>();
  const put = (short: string): OrderNoRow => {
    let row = bucket.get(short);
    if (!row) {
      row = {
        orderNo: short,
        hmOrderNo: "",
        marketCode: "",
        marketSubCode: "",
        contractNo: "",
        contractDate: "",
        buyerCode: "",
        styleNo: "",
        descriptionOfGoods: "",
        unitPrice: null,
        quantityPcs: null,
        portOfLoading: "",
        portOfDischarge: "",
        placeOfDelivery: "",
        transportMode: "",
        bookingRef: "",
        grossWeightKg: null,
        totalCartons: null,
        measurementCbm: null,
        foundInSalesContract: false,
        foundInShipmentSchedule: false,
        hasInvoice: invoiceByOrder.has(short),
        invoiceId: invoiceByOrder.get(short) ?? null,
      };
      bucket.set(short, row);
    }
    return row;
  };

  for (const po of pos) {
    const short = shortOrderKey(po.orderNo);
    if (!short) continue;
    const row = put(short);
    row.foundInSalesContract = true;
    row.hmOrderNo ||= po.orderNo;
    row.contractNo ||= po.contract?.marchentContNo ?? "";
    row.contractDate ||= po.contract?.contractDate ?? "";
    row.buyerCode ||= po.contract?.buyerCode ?? "";

    // Country codes extracted from the Country Breakdown PDF at upload time.
    // The first one becomes the invoice's country (Sales Contract is the
    // authoritative source — the Shipment Schedule's market code is only a
    // fallback for orders that never came through a Sales Contract upload).
    try {
      const codes = po.countryCodesJson ? JSON.parse(po.countryCodesJson) : [];
      if (Array.isArray(codes) && codes.length > 0) {
        const first = String(codes[0]).trim().toUpperCase();
        if (first && !row.marketCode) row.marketCode = first;
      }
    } catch {
      // ignore — countryCodesJson is best-effort
    }

    // Reach into the extraction JSON for style + description + unit price.
    try {
      const poExtract = po.poJson ? JSON.parse(po.poJson) : null;
      if (poExtract?.header?.productName) row.styleNo ||= String(poExtract.header.productName);
      if (poExtract?.header?.customsCustomerGroup || poExtract?.header?.productDescription) {
        row.descriptionOfGoods ||= [
          poExtract.header.customsCustomerGroup,
          poExtract.header.productDescription,
          poExtract.header.typeOfConstruction,
        ].filter(Boolean).join(" ").trim();
      }
      if (poExtract?.rows?.length) {
        const fobs = poExtract.rows
          .map((r: { fob?: number }) => r.fob)
          .filter((v: unknown): v is number => typeof v === "number" && v > 0);
        if (fobs.length && row.unitPrice == null) row.unitPrice = fobs[0];
        const qty = poExtract.rows.reduce((a: number, r: { qty?: number }) => a + (r.qty ?? 0), 0);
        if (qty > 0 && row.quantityPcs == null) row.quantityPcs = qty;
      }
    } catch {
      // ignore — poJson is best-effort
    }
  }

  for (const r of rows) {
    const short = shortOrderKey(r.orderNo);
    if (!short) continue;
    const row = put(short);
    row.foundInShipmentSchedule = true;
    row.hmOrderNo ||= r.pdfOrderNo || r.orderNo;
    row.contractNo ||= r.contractNo;
    row.contractDate ||= r.contractDate;
    row.buyerCode ||= r.buyerCode;
    row.styleNo ||= r.style;
    row.descriptionOfGoods ||= r.composition;
    if (row.unitPrice == null && r.fob != null) row.unitPrice = r.fob;
    if (row.quantityPcs == null && r.pcs != null) row.quantityPcs = r.pcs;
    row.marketCode ||= r.marketCode;
    row.marketSubCode ||= r.marketSubCode;
    row.portOfLoading ||= r.portOfLoading;
    row.portOfDischarge ||= r.portOfDischarge;
    row.placeOfDelivery ||= r.placeOfDelivery;
    row.transportMode ||= r.transportMode;
    row.bookingRef ||= r.bookingRef;
    if (row.grossWeightKg == null && r.grossWeightKg != null) row.grossWeightKg = r.grossWeightKg;
    if (row.totalCartons == null && r.cartons != null) row.totalCartons = r.cartons;
    if (row.measurementCbm == null && r.measurementCbm != null) row.measurementCbm = r.measurementCbm;
  }

  // Drop garbage orderNos (dashes, markers, anything that isn't 6+ digits).
  // Sort: orders with a resolvable country code first (OE / NH / … surface at
  // the top), then by order number.
  return [...bucket.values()]
    .filter((r) => /^\d{6,}$/.test(r.orderNo))
    .sort((a, b) => {
      const am = a.marketCode ? 0 : 1;
      const bm = b.marketCode ? 0 : 1;
      if (am !== bm) return am - bm;
      return a.orderNo.localeCompare(b.orderNo);
    });
}

/** Build the prefill for one Order No (lightweight — called at create time). */
export async function buildPrefill(orderNo: string): Promise<InvoicePrefill | null> {
  const short = shortOrderKey(orderNo);
  if (!short) return null;
  const all = await listOrderNosWithPrefill();
  const row = all.find((r) => r.orderNo === short);
  if (!row) return null;
  const templates = listTemplates();
  const t = resolveTemplate(row.marketCode, row.marketSubCode, templates);
  return {
    orderNo: short,
    countryCode: t?.countryCode ?? row.marketCode,
    marketCode: row.marketCode,
    marketSubCode: row.marketSubCode,
    contractNo: row.contractNo,
    contractDate: row.contractDate,
    hmOrderNo: row.hmOrderNo,
    buyerCode: row.buyerCode,
    styleNo: row.styleNo,
    descriptionOfGoods: row.descriptionOfGoods,
    unitPrice: row.unitPrice ?? undefined,
    quantityPcs: row.quantityPcs ?? undefined,
    portOfLoading: row.portOfLoading || "CHITTAGONG",
    portOfDischarge: row.portOfDischarge,
    placeOfDelivery: row.placeOfDelivery,
    transportMode: row.transportMode,
    bookingRef: row.bookingRef,
    grossWeightKg: row.grossWeightKg ?? undefined,
    totalCartons: row.totalCartons ?? undefined,
    measurementCbm: row.measurementCbm ?? undefined,
    foundInSalesContract: row.foundInSalesContract,
    foundInShipmentSchedule: row.foundInShipmentSchedule,
  };
}
