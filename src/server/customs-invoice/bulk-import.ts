/**
 * Bulk Customs Invoice generation from an uploaded .xlsx.
 *
 * Workflow:
 *   1. Parse the Excel — one row per Order No. The ONLY required column is
 *      "Order No." (any of these headers also work: "OrderNo", "OrderNo.",
 *      "Order", "Order Number"). Every editable InvoiceFields column may
 *      appear as an optional override — case-insensitive, matched against
 *      INVOICE_FIELD_LABELS and the field keys themselves.
 *   2. For each row: create or reuse the CustomsInvoice (prefills from the
 *      matching Sales Contract + Shipment Schedule), apply the row's
 *      overrides (so the user can override Country code, invoice no, dates,
 *      consignee, etc. per row), then generate the .xlsx using the per-country
 *      template that matches the invoice's countryCode / marketCode.
 *   3. Pack every generated .xlsx into a single ZIP that the API returns to
 *      the browser.
 *
 * Templates and the resolution strategy are owned by `templates.ts`; this
 * module only orchestrates. If a row has NO template match the writer falls
 * back to the fresh-workbook mode so the user still gets a downloadable file
 * (clearly named NO_TEMPLATE).
 */

import ExcelJS from "exceljs";
import JSZip from "jszip";
import { createInvoiceForOrder, updateInvoiceFields } from "./intake";
import { writeInvoiceXlsx } from "./write-xlsx";
import { prisma } from "@/lib/db";
import {
  INVOICE_FIELD_LABELS,
  INVOICE_FLOAT_FIELDS,
  INVOICE_INT_FIELDS,
  INVOICE_STRING_FIELDS,
  type InvoiceFields,
} from "./types";

type Overrides = Partial<InvoiceFields>;

export interface BulkRow {
  rowNo: number;              // 1-indexed Excel row
  orderNo: string;
  overrides: Overrides;
}

export interface BulkRowResult {
  rowNo: number;
  orderNo: string;
  invoiceId: string | null;
  templateUsed: string | null;
  countryCode: string | null;
  fileName: string | null;
  mode: "template" | "fresh" | "error";
  error?: string;
}

export interface BulkParseResult {
  rows: BulkRow[];
  rejected: { row: number; reason: string }[];
}

// ---------------------------------------------------------------------------
// Pure: parse an xlsx buffer into BulkRow[]
// ---------------------------------------------------------------------------

const ORDER_HEADER_ALIASES = ["order no.", "order no", "orderno.", "orderno", "order", "order number"];

/** Reverse index: lower-case label OR field key → canonical InvoiceFields key. */
function buildCanonicalMap(): Map<string, keyof InvoiceFields> {
  const m = new Map<string, keyof InvoiceFields>();
  for (const [key, label] of Object.entries(INVOICE_FIELD_LABELS)) {
    m.set(key.toLowerCase(), key as keyof InvoiceFields);
    m.set(label.toLowerCase().trim(), key as keyof InvoiceFields);
  }
  // Common synonyms we see in the user's spreadsheets.
  m.set("country code", "countryCode");
  m.set("fob", "unitPrice");
  m.set("qty", "quantityPcs");
  m.set("pcs", "quantityPcs");
  m.set("cartons", "totalCartons");
  m.set("gross weight", "grossWeightKg");
  m.set("gross weight (kg)", "grossWeightKg");
  m.set("net weight", "netWeightKg");
  m.set("net weight (kg)", "netWeightKg");
  m.set("cbm", "measurementCbm");
  m.set("measurement", "measurementCbm");
  m.set("hs code", "hsCode");
  m.set("style no", "styleNo");
  m.set("style no.", "styleNo");
  m.set("buyer code", "buyerCode");
  m.set("invoice no", "invoiceNumber");
  m.set("invoice no.", "invoiceNumber");
  m.set("invoice number", "invoiceNumber");
  m.set("invoice date", "invoiceDate");
  m.set("contract no", "contractNo");
  m.set("contract no.", "contractNo");
  m.set("exp no", "expNo");
  m.set("exp no.", "expNo");
  return m;
}

function toStr(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object" && v !== null && "text" in v) {
    const parts = ((v as { richText?: { text: string }[] }).richText ?? []).map((r) => r.text);
    if (parts.length) return parts.join("");
    const t = (v as { text?: string }).text;
    if (typeof t === "string") return t;
  }
  if (typeof v === "object" && v !== null && "result" in v) {
    const r = (v as { result?: unknown }).result;
    return r === null || r === undefined ? "" : String(r);
  }
  return String(v).trim();
}

function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "object" && v !== null && "result" in v) {
    const r = (v as { result?: unknown }).result;
    if (typeof r === "number") return Number.isFinite(r) ? r : null;
    const n = Number(r);
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(String(v).replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

export async function parseBulkInvoiceXlsx(buffer: Buffer): Promise<BulkParseResult> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  const sheet = wb.worksheets[0];
  if (!sheet) return { rows: [], rejected: [{ row: 0, reason: "Workbook has no worksheets." }] };

  const canonical = buildCanonicalMap();
  const strSet = new Set<string>(INVOICE_STRING_FIELDS as string[]);
  const intSet = new Set<string>(INVOICE_INT_FIELDS as string[]);
  const floatSet = new Set<string>(INVOICE_FLOAT_FIELDS as string[]);

  // Find the header row — any row that contains an order-no header AND at
  // least one more recognised column.
  let headerRow = -1;
  let orderCol = -1;
  const colMap = new Map<keyof InvoiceFields, number>();
  const maxScan = Math.min(20, Math.max(sheet.rowCount, 20));
  for (let r = 1; r <= maxScan; r++) {
    const row = sheet.getRow(r);
    let foundOrder = -1;
    const tentative = new Map<keyof InvoiceFields, number>();
    for (let c = 1; c <= Math.max(row.actualCellCount, 25); c++) {
      const label = toStr(row.getCell(c).value).toLowerCase().trim();
      if (!label) continue;
      if (foundOrder === -1 && ORDER_HEADER_ALIASES.includes(label)) {
        foundOrder = c;
        continue;
      }
      const key = canonical.get(label);
      if (key && !tentative.has(key)) tentative.set(key, c);
    }
    if (foundOrder !== -1) {
      headerRow = r;
      orderCol = foundOrder;
      tentative.forEach((v, k) => colMap.set(k, v));
      break;
    }
  }
  if (headerRow === -1) {
    return { rows: [], rejected: [{ row: 0, reason: 'Could not find a header row containing "Order No."' }] };
  }

  const rows: BulkRow[] = [];
  const rejected: { row: number; reason: string }[] = [];
  const last = Math.max(sheet.rowCount, sheet.actualRowCount);
  for (let r = headerRow + 1; r <= last; r++) {
    const row = sheet.getRow(r);
    if (!row || row.actualCellCount === 0) continue;
    const orderNo = toStr(row.getCell(orderCol).value).trim();
    if (!orderNo) continue;

    const overrides: Overrides = {};
    colMap.forEach((col, key) => {
      const raw = row.getCell(col).value;
      if (raw === null || raw === undefined || raw === "") return;
      if (intSet.has(key)) {
        const n = toNum(raw);
        if (n !== null) (overrides as Record<string, unknown>)[key] = Math.round(n);
      } else if (floatSet.has(key)) {
        const n = toNum(raw);
        if (n !== null) (overrides as Record<string, unknown>)[key] = n;
      } else if (strSet.has(key)) {
        const s = toStr(raw);
        if (s !== "") (overrides as Record<string, unknown>)[key] = s;
      }
    });

    rows.push({ rowNo: r, orderNo, overrides });
  }
  return { rows, rejected };
}

// ---------------------------------------------------------------------------
// DB + file: generate every invoice and pack into a single ZIP.
// ---------------------------------------------------------------------------

function invoiceFromDb(inv: Record<string, unknown>): InvoiceFields {
  return {
    invoiceNumber: String(inv.invoiceNumber ?? ""),
    invoiceDate: String(inv.invoiceDate ?? ""),
    contractNo: String(inv.contractNo ?? ""),
    contractDate: String(inv.contractDate ?? ""),
    hmOrderNo: String(inv.hmOrderNo ?? ""),
    marketCode: String(inv.marketCode ?? ""),
    marketSubCode: String(inv.marketSubCode ?? ""),
    countryCode: String(inv.countryCode ?? ""),
    expNo: String(inv.expNo ?? ""),
    expDate: String(inv.expDate ?? ""),
    portOfLoading: String(inv.portOfLoading ?? ""),
    portOfDischarge: String(inv.portOfDischarge ?? ""),
    placeOfDelivery: String(inv.placeOfDelivery ?? ""),
    countryOfOrigin: String(inv.countryOfOrigin ?? ""),
    countryOfFinalDestination: String(inv.countryOfFinalDestination ?? ""),
    transportMode: String(inv.transportMode ?? ""),
    termsOfDelivery: String(inv.termsOfDelivery ?? ""),
    termsOfPayment: String(inv.termsOfPayment ?? ""),
    vesselName: String(inv.vesselName ?? ""),
    voyageNo: String(inv.voyageNo ?? ""),
    sailingDate: String(inv.sailingDate ?? ""),
    currency: String(inv.currency ?? ""),
    exporterName: String(inv.exporterName ?? ""),
    buyerName: String(inv.buyerName ?? ""),
    consigneeName: String(inv.consigneeName ?? ""),
    cargoDeliveryName: String(inv.cargoDeliveryName ?? ""),
    issuingBank: String(inv.issuingBank ?? ""),
    descriptionOfGoods: String(inv.descriptionOfGoods ?? ""),
    styleNo: String(inv.styleNo ?? ""),
    buyerCode: String(inv.buyerCode ?? ""),
    hsCode: String(inv.hsCode ?? ""),
    category: String(inv.category ?? ""),
    quantityPcs: (inv.quantityPcs ?? null) as number | null,
    unitPrice: (inv.unitPrice ?? null) as number | null,
    totalCartons: (inv.totalCartons ?? null) as number | null,
    grossWeightKg: (inv.grossWeightKg ?? null) as number | null,
    netWeightKg: (inv.netWeightKg ?? null) as number | null,
    measurementCbm: (inv.measurementCbm ?? null) as number | null,
    dimension: String(inv.dimension ?? ""),
    packSet: String(inv.packSet ?? ""),
  };
}

export interface BulkGenerateOptions {
  actor?: string;
}

export interface BulkGenerateOutcome {
  zipBuffer: Buffer;
  results: BulkRowResult[];
  summary: {
    totalRows: number;
    generated: number;
    templated: number;
    freshFallback: number;
    errors: number;
  };
}

export async function generateBulkInvoices(
  rows: BulkRow[],
  opts: BulkGenerateOptions = {},
): Promise<BulkGenerateOutcome> {
  const actor = opts.actor ?? "system";
  const zip = new JSZip();
  const results: BulkRowResult[] = [];
  const summary = { totalRows: rows.length, generated: 0, templated: 0, freshFallback: 0, errors: 0 };

  for (const r of rows) {
    try {
      // 1. Ensure the invoice exists (prefills from SC + SS on first create).
      const create = await createInvoiceForOrder(r.orderNo, { actor });
      // 2. Apply row-level overrides so the Excel wins.
      if (Object.keys(r.overrides).length > 0) {
        await updateInvoiceFields(create.invoiceId, r.overrides, { actor, source: "prefill" });
      }
      // 3. Reload the invoice from DB so the writer sees the applied overrides.
      const inv = await prisma.customsInvoice.findUnique({ where: { id: create.invoiceId } });
      if (!inv) throw new Error("Invoice vanished after create.");
      const fields = invoiceFromDb(inv as unknown as Record<string, unknown>);
      // 4. Generate .xlsx — writer picks the per-country template automatically.
      const out = await writeInvoiceXlsx(fields);
      const safeOrder = r.orderNo.replace(/[^\w.-]+/g, "-");
      const safeCountry = (fields.countryCode || fields.marketCode || "NO_TEMPLATE").replace(/[^\w.-]+/g, "-");
      const fileName = `CustomsInvoice_${safeOrder}_${safeCountry}.xlsx`;
      zip.file(fileName, out.buffer);
      results.push({
        rowNo: r.rowNo,
        orderNo: r.orderNo,
        invoiceId: create.invoiceId,
        templateUsed: out.templateUsed,
        countryCode: fields.countryCode || fields.marketCode || null,
        fileName,
        mode: out.mode,
      });
      summary.generated++;
      if (out.mode === "template") summary.templated++;
      else summary.freshFallback++;
    } catch (e) {
      summary.errors++;
      results.push({
        rowNo: r.rowNo,
        orderNo: r.orderNo,
        invoiceId: null,
        templateUsed: null,
        countryCode: null,
        fileName: null,
        mode: "error",
        error: e instanceof Error ? e.message : "generation failed",
      });
    }
  }

  // Include the per-row result log in the ZIP for traceability.
  const log =
    "Order No,Country,Template,Mode,Error\n" +
    results
      .map((r) =>
        [r.orderNo, r.countryCode ?? "", r.templateUsed ?? "", r.mode, (r.error ?? "").replace(/[\r\n,]+/g, " ")]
          .map((s) => `"${String(s).replace(/"/g, '""')}"`)
          .join(","),
      )
      .join("\n");
  zip.file("_bulk-generation-log.csv", log);

  const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });
  return { zipBuffer, results, summary };
}
