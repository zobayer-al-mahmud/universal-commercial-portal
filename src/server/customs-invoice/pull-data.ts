import { prisma } from "@/lib/db";
import { listTemplates, resolveTemplate } from "./templates";
import type { InvoicePrefill } from "./types";

/**
 * The order-number key used across the three modules differs:
 *   - SalesContractPo.orderNo stores the SHORT key (e.g. "498160").
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
  orderNo: string; // short key – primary join field
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
  invoiceNo: string;          // from ShipmentScheduleRow.invoiceNo (unique per week+week)
  expectedDelivery: string;   // from ShipmentScheduleRow.expectedDelivery (booking PDF)
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
    prisma.salesContractPo.findMany({
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
        invoiceNo: "",
        expectedDelivery: "",
        foundInSalesContract: false,
        foundInShipmentSchedule: false,
        hasInvoice: invoiceByOrder.has(short),
        invoiceId: invoiceByOrder.get(short) ?? null,
      };
      bucket.set(short, row);
    }
    return row;
  };

  // Process SHIPMENT ROWS FIRST so their market/sub/booking data wins — the
  // Sales Contract PO's `countryCodesJson` only carries H&M's market-GROUP
  // code (e.g. "OE"), not the destination country, so it must only act as a
  // last-ditch fallback. Within shipment rows, the row with an allocated
  // Invoice No. (and a parsed PDF) is prioritised: that's the row the invoice
  // actually tracks per the user flow (Invoice No. + Order No. → shipment row
  // → country → template), so its data must be the authoritative source.
  const sortedRows = [...rows].sort((a, b) => {
    const aInv = a.invoiceNo && a.invoiceNo.trim() !== "" ? 0 : 1;
    const bInv = b.invoiceNo && b.invoiceNo.trim() !== "" ? 0 : 1;
    if (aInv !== bInv) return aInv - bInv;
    const aPdf = a.pdfSha256 && a.pdfSha256 !== "" ? 0 : 1;
    const bPdf = b.pdfSha256 && b.pdfSha256 !== "" ? 0 : 1;
    if (aPdf !== bPdf) return aPdf - bPdf;
    return (b.updatedAt?.getTime?.() ?? 0) - (a.updatedAt?.getTime?.() ?? 0);
  });

  for (const r of sortedRows) {
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
    // Carry the invoiceNo + Expected Delivery across so Customs Invoice can
    // use them as the Invoice No. / Invoice date prefill. Only overwrite when
    // still blank — the first (highest-priority) schedule row that has them wins.
    if (!row.invoiceNo && r.invoiceNo) row.invoiceNo = r.invoiceNo;
    if (!row.expectedDelivery && r.expectedDelivery) row.expectedDelivery = r.expectedDelivery;
  }

  for (const po of pos) {
    const short = shortOrderKey(po.orderNo);
    if (!short) continue;
    const row = put(short);
    row.foundInSalesContract = true;
    row.hmOrderNo ||= po.orderNo;
    row.contractNo ||= po.contract?.marchentContNo ?? "";
    row.contractDate ||= po.contract?.contractDate ?? "";
    row.buyerCode ||= po.contract?.buyerCode ?? "";

    // Country-group fallback ONLY — countryCodesJson carries H&M's market
    // GROUP (e.g. "OE" = Office Europe) rather than a destination country,
    // so it never overrides a shipment-row-derived market code. Kept here so
    // orders that never had a booking PDF still show something.
    try {
      const codes = po.countryCodesJson ? JSON.parse(po.countryCodesJson) : [];
      if (Array.isArray(codes) && codes.length > 0) {
        const first = String(codes[0]).trim().toUpperCase();
        if (first && !row.marketCode) row.marketCode = first;
      }
    } catch {
      // ignore – countryCodesJson is best-effort
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
      // ignore – poJson is best-effort
    }
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

/**
 * The real destination country lives in the FIRST TWO LETTERS of the shipment
 * row's sub-code (e.g. "MYW069" → MY = Malaysia, "AUW118" → AU = Australia,
 * "PEW153" → PE = Peru). The Sales Contract PO's `countryCodesJson` carries
 * H&M's market-GROUP code (e.g. "OE" = Office Europe group), which is NOT
 * the destination country and must never be shown as such on the customs
 * invoice (user rule 2026-10-28).
 *
 * This helper returns the preferred 2-letter country code for a row, picking
 * the sub-code's leading letters whenever they look like a real ISO/H&M
 * country code. Falls back to the row's stored marketCode when the sub-code
 * is blank or malformed.
 */
export function preferredCountryCode(row: Pick<OrderNoRow, "marketCode" | "marketSubCode">): string {
  const sub = (row.marketSubCode ?? "").trim().toUpperCase();
  // Sub-codes look like `${CC}${BUYER}` (e.g. "MYW069") or `${GROUP}-${CC}${BUYER}`
  // (e.g. "OW-NLW195"). In the hyphenated form the country is after the dash;
  // in the simple form it's the first two letters.
  const hy = sub.match(/^[A-Z]{2}-([A-Z]{2})[A-Z0-9]/);
  if (hy) return hy[1];
  const simple = sub.match(/^([A-Z]{2})[A-Z0-9]/);
  if (simple) return simple[1];
  return (row.marketCode ?? "").trim().toUpperCase();
}

/**
 * Build the prefill for one invoice.
 *
 * When `opts.invoiceNo` is given, the ONE shipment-schedule row whose
 * `invoiceNo` matches is used as the authoritative source — that's the row
 * the invoice tracks. Otherwise the merged "best-row" for the Order No. is
 * used (the row with an invoice No. and a parsed PDF wins the first-wins
 * merge, by sortedRows priority in `listOrderNosWithPrefill`).
 */
export async function buildPrefill(
  orderNo: string,
  opts: { invoiceNo?: string } = {},
): Promise<InvoicePrefill | null> {
  const short = shortOrderKey(orderNo);
  if (!short) return null;
  const invoiceNo = (opts.invoiceNo ?? "").trim();

  // When we have a specific Invoice No., read directly from the one shipment
  // row that owns it. This guarantees per-invoice country/template fidelity
  // regardless of how many shipment rows share the same Order No.
  if (invoiceNo) {
    const r = await prisma.shipmentScheduleRow.findFirst({
      where: { invoiceNo, orderNo: { startsWith: short } },
    });
    const fallback = r ?? await prisma.shipmentScheduleRow.findFirst({ where: { invoiceNo } });
    if (fallback) {
      // Also hydrate contract metadata from the Sales Contract PO when possible.
      const po = await prisma.salesContractPo.findFirst({
        where: { orderNo: { startsWith: short } },
        include: { contract: { select: { marchentContNo: true, contractDate: true, buyerCode: true } } },
      });
      const templates = listTemplates();
      const country = preferredCountryCode(fallback);
      const t = resolveTemplate(country, fallback.marketSubCode, templates);
      return {
        orderNo: short,
        countryCode: t?.countryCode ?? country,
        marketCode: country,
        marketSubCode: fallback.marketSubCode,
        contractNo: fallback.contractNo || po?.contract?.marchentContNo || "",
        contractDate: fallback.contractDate || po?.contract?.contractDate || "",
        hmOrderNo: fallback.pdfOrderNo || fallback.orderNo,
        buyerCode: fallback.buyerCode || po?.contract?.buyerCode || "",
        styleNo: fallback.style,
        descriptionOfGoods: fallback.composition,
        unitPrice: fallback.fob ?? undefined,
        quantityPcs: fallback.pcs ?? undefined,
        portOfLoading: fallback.portOfLoading,
        portOfDischarge: fallback.portOfDischarge,
        placeOfDelivery: fallback.placeOfDelivery,
        transportMode: fallback.transportMode,
        bookingRef: fallback.bookingRef,
        grossWeightKg: fallback.grossWeightKg ?? undefined,
        totalCartons: fallback.cartons ?? undefined,
        measurementCbm: fallback.measurementCbm ?? undefined,
        invoiceNo: fallback.invoiceNo,
        expectedDelivery: fallback.expectedDelivery,
        foundInSalesContract: !!po,
        foundInShipmentSchedule: true,
      };
    }
  }

  const all = await listOrderNosWithPrefill();
  const row = all.find((r) => r.orderNo === short);
  if (!row) return null;
  const templates = listTemplates();
  // The invoice's country code is the shipment destination (MY / AU / NL),
  // not the H&M market-group code. Template resolution and the on-screen
  // "Country code" field both use this preferred value.
  const country = preferredCountryCode(row);
  const t = resolveTemplate(country, row.marketSubCode, templates);
  return {
    orderNo: short,
    countryCode: t?.countryCode ?? country,
    marketCode: country,
    marketSubCode: row.marketSubCode,
    contractNo: row.contractNo,
    contractDate: row.contractDate,
    hmOrderNo: row.hmOrderNo,
    buyerCode: row.buyerCode,
    styleNo: row.styleNo,
    descriptionOfGoods: row.descriptionOfGoods,
    unitPrice: row.unitPrice ?? undefined,
    quantityPcs: row.quantityPcs ?? undefined,
    portOfLoading: row.portOfLoading,
    portOfDischarge: row.portOfDischarge,
    placeOfDelivery: row.placeOfDelivery,
    transportMode: row.transportMode,
    bookingRef: row.bookingRef,
    grossWeightKg: row.grossWeightKg ?? undefined,
    totalCartons: row.totalCartons ?? undefined,
    measurementCbm: row.measurementCbm ?? undefined,
    invoiceNo: row.invoiceNo,
    expectedDelivery: row.expectedDelivery,
    foundInSalesContract: row.foundInSalesContract,
    foundInShipmentSchedule: row.foundInShipmentSchedule,
  };
}
