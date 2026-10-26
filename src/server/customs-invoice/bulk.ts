/**
 * Bulk Customs-Invoice generation from an .xlsx.
 *
 * Each row = one invoice. A country/market-code column picks the template
 * (honoring the editable config's overrides). Every row upserts a
 * CustomsInvoice (keyed by the short Order No. — so it appears in the list and
 * stays editable) and is generated into a .xlsx bundled in one ZIP. Fail-closed:
 * rows without an Order No. or a code are rejected (not generated); a row with
 * no matching template is still persisted + generated via the clear
 * non-template fallback and flagged `no-template`. Nothing is fabricated.
 */

import { randomUUID } from "crypto";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import ExcelJS from "exceljs";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { audit } from "@/lib/audit";
import { buildZip, type ZipEntry } from "@/server/booking-correction/zip";
import { listTemplates, resolveTemplateWithOverrides } from "./templates";
import { getGenerationConfig } from "./config";
import { writeInvoiceXlsx } from "./write-xlsx";
import { updateInvoiceFields } from "./intake";
import { shortOrderKey } from "./pull-data";
import {
  DEFAULT_BUYER, DEFAULT_EXPORTER,
  INVOICE_FIELD_LABELS, INVOICE_STRING_FIELDS, INVOICE_INT_FIELDS, INVOICE_FLOAT_FIELDS,
  type InvoiceFields,
} from "./types";

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Column header (normalized) → InvoiceFields key. Built from the field labels
 *  plus common aliases staff use in their spreadsheets. */
const CANONICAL: Record<string, keyof InvoiceFields> = (() => {
  const m: Record<string, keyof InvoiceFields> = {};
  for (const [field, label] of Object.entries(INVOICE_FIELD_LABELS)) {
    m[norm(label)] = field as keyof InvoiceFields;
  }
  Object.assign(m, {
    [norm("order no")]: "hmOrderNo", [norm("order no.")]: "hmOrderNo", [norm("orderno")]: "hmOrderNo", [norm("orderno.")]: "hmOrderNo",
    [norm("order number")]: "hmOrderNo", [norm("h&m order no")]: "hmOrderNo",
    [norm("country")]: "marketCode", [norm("market")]: "marketCode", [norm("country code")]: "marketCode",
    [norm("market+sub")]: "marketSubCode", [norm("sub code")]: "marketSubCode", [norm("sub-code")]: "marketSubCode",
    [norm("qty")]: "quantityPcs", [norm("quantity")]: "quantityPcs", [norm("pcs")]: "quantityPcs",
    [norm("fob")]: "unitPrice", [norm("unit price")]: "unitPrice",
    [norm("cartons")]: "totalCartons", [norm("ctns")]: "totalCartons",
    [norm("gross weight")]: "grossWeightKg", [norm("gw")]: "grossWeightKg",
    [norm("net weight")]: "netWeightKg", [norm("nw")]: "netWeightKg",
    [norm("hs code")]: "hsCode", [norm("hscode")]: "hsCode",
    [norm("style")]: "styleNo", [norm("style no")]: "styleNo",
    [norm("description")]: "descriptionOfGoods", [norm("composition")]: "descriptionOfGoods",
    [norm("buyer code")]: "buyerCode",
    [norm("invoice")]: "invoiceNumber", [norm("invoice no")]: "invoiceNumber",
    [norm("exp no")]: "expNo", [norm("exp date")]: "expDate",
    [norm("cbm")]: "measurementCbm", [norm("measurement")]: "measurementCbm",
  } satisfies Record<string, keyof InvoiceFields>);
  return m;
})();

function norm(s: unknown): string { return String(s ?? "").trim().toLowerCase(); }

function cellStr(v: ExcelJS.CellValue): string {
  if (v == null) return "";
  if (typeof v === "object") {
    if ("richText" in v) return (v as { richText: { text: string }[] }).richText.map((t) => t.text).join("");
    if ("result" in v) return String((v as { result: unknown }).result ?? "");
    if ("text" in v) return String((v as { text: unknown }).text ?? "");
  }
  return String(v).trim();
}

const INT_SET = new Set<string>(INVOICE_INT_FIELDS as string[]);
const FLOAT_SET = new Set<string>(INVOICE_FLOAT_FIELDS as string[]);
const STR_SET = new Set<string>(INVOICE_STRING_FIELDS as string[]);

export interface BulkInvoiceRow {
  orderKey: string;             // short Order No. (unique key)
  marketCode: string;
  marketSubCode: string;
  fields: Partial<InvoiceFields>;
}

export interface BulkParseResult {
  rows: BulkInvoiceRow[];
  rejected: { row: number; reason: string }[];
}

/** Parse a bulk invoice .xlsx into per-row field patches. Pure. */
export async function parseInvoiceBulkXlsx(buffer: Buffer): Promise<BulkParseResult> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  const sheet = wb.worksheets[0];
  if (!sheet) return { rows: [], rejected: [{ row: 0, reason: "Workbook has no worksheets." }] };

  // Find the header row (first 20 physical rows) + the column of each known label.
  let headerRow = -1;
  const colMap = new Map<keyof InvoiceFields, number>();
  const maxScan = Math.min(20, Math.max(sheet.rowCount, 20));
  for (let r = 1; r <= maxScan; r++) {
    const row = sheet.getRow(r);
    const tentative = new Map<keyof InvoiceFields, number>();
    for (let c = 1; c <= Math.max(row.actualCellCount, 25); c++) {
      const key = CANONICAL[norm(cellStr(row.getCell(c).value))];
      if (key && !tentative.has(key)) tentative.set(key, c);
    }
    // A valid header has an Order No. column + a country/market column + ≥1 more.
    if (tentative.has("hmOrderNo") && tentative.has("marketCode") && tentative.size >= 3) {
      headerRow = r;
      for (const [k, v] of tentative) colMap.set(k, v);
      break;
    }
  }
  if (headerRow === -1) {
    return { rows: [], rejected: [{ row: 0, reason: 'Could not find a header row with an "Order No." column and a "Country/Market" column.' }] };
  }

  const rows: BulkInvoiceRow[] = [];
  const rejected: { row: number; reason: string }[] = [];
  const last = Math.max(sheet.rowCount, sheet.actualRowCount);
  for (let r = headerRow + 1; r <= last; r++) {
    const row = sheet.getRow(r);
    if (!row || row.actualCellCount === 0) continue;
    const fields: Partial<InvoiceFields> = {};
    for (const [field, col] of colMap) {
      const raw = cellStr(row.getCell(col).value).trim();
      if (raw === "") continue;
      if (INT_SET.has(field)) { const n = Number.parseInt(raw.replace(/[^\d-]/g, ""), 10); if (Number.isFinite(n)) (fields as Record<string, unknown>)[field] = n; }
      else if (FLOAT_SET.has(field)) { const n = Number.parseFloat(raw.replace(/[^\d.-]/g, "")); if (Number.isFinite(n)) (fields as Record<string, unknown>)[field] = n; }
      else if (STR_SET.has(field)) { (fields as Record<string, unknown>)[field] = raw; }
    }
    const orderRaw = String(fields.hmOrderNo ?? "").trim();
    const orderKey = shortOrderKey(orderRaw);
    const marketCode = String(fields.marketCode ?? "").trim();
    if (!orderKey || !/\d{6,}/.test(orderKey)) { rejected.push({ row: r, reason: `Row ${r}: missing or invalid Order No.` }); continue; }
    if (!marketCode) { rejected.push({ row: r, reason: `Row ${r} (${orderKey}): missing country/market code.` }); continue; }
    rows.push({ orderKey, marketCode, marketSubCode: String(fields.marketSubCode ?? "").trim(), fields });
  }
  return { rows, rejected };
}

// ---------------------------------------------------------------------------
// Generation + persistence
// ---------------------------------------------------------------------------

/** Build the flat InvoiceFields view from a stored CustomsInvoice row. */
function fieldsFromRow(inv: Record<string, unknown>): InvoiceFields {
  const s = (k: string) => String(inv[k] ?? "");
  const n = (k: string) => (inv[k] == null ? null : (inv[k] as number));
  return {
    invoiceNumber: s("invoiceNumber"), invoiceDate: s("invoiceDate"), contractNo: s("contractNo"), contractDate: s("contractDate"),
    hmOrderNo: s("hmOrderNo"), marketCode: s("marketCode"), marketSubCode: s("marketSubCode"), countryCode: s("countryCode"),
    expNo: s("expNo"), expDate: s("expDate"), portOfLoading: s("portOfLoading"), portOfDischarge: s("portOfDischarge"),
    placeOfDelivery: s("placeOfDelivery"), countryOfOrigin: s("countryOfOrigin"), countryOfFinalDestination: s("countryOfFinalDestination"),
    transportMode: s("transportMode"), termsOfDelivery: s("termsOfDelivery"), termsOfPayment: s("termsOfPayment"),
    vesselName: s("vesselName"), voyageNo: s("voyageNo"), sailingDate: s("sailingDate"), currency: s("currency"),
    exporterName: s("exporterName"), buyerName: s("buyerName"), consigneeName: s("consigneeName"), cargoDeliveryName: s("cargoDeliveryName"),
    issuingBank: s("issuingBank"), descriptionOfGoods: s("descriptionOfGoods"), styleNo: s("styleNo"), buyerCode: s("buyerCode"),
    hsCode: s("hsCode"), category: s("category"), quantityPcs: n("quantityPcs"), unitPrice: n("unitPrice"),
    totalCartons: n("totalCartons"), grossWeightKg: n("grossWeightKg"), netWeightKg: n("netWeightKg"), measurementCbm: n("measurementCbm"),
    dimension: s("dimension"), packSet: s("packSet"),
  };
}

export interface BulkRowResult {
  orderNo: string;
  invoiceId: string;
  created: boolean;
  templateFile: string | null;
  mode: "template" | "fresh";
  note: string;
}

export interface BulkGenerateResult {
  runId: string;
  created: number;
  updated: number;
  noTemplate: number;
  failed: number;
  zipPath: string;
  zipBytes: number;
  rows: BulkRowResult[];
  rejected: { row: number; reason: string }[];
}

/** Where bulk ZIPs are written. */
export function bulkZipPath(runId: string): string {
  return join(env.STORAGE_ROOT, "customs-invoice", "bulk", `${runId}.zip`);
}

export async function generateBulkInvoices(opts: {
  rows: BulkInvoiceRow[];
  rejected?: { row: number; reason: string }[];
  actor: string;
}): Promise<BulkGenerateResult> {
  const { rows, actor } = opts;
  const config = await getGenerationConfig();
  const templates = listTemplates();
  const runId = randomUUID();

  const entries: ZipEntry[] = [];
  const usedNames = new Set<string>();
  const results: BulkRowResult[] = [];
  let created = 0, updated = 0, noTemplate = 0, failed = 0;

  for (const row of rows) {
    try {
      const resolved = resolveTemplateWithOverrides(row.marketCode, row.marketSubCode, templates, config.templateOverrides);
      const templateFile = resolved?.filename ?? "";
      const countryCode = resolved?.countryCode ?? row.marketCode.toUpperCase();

      let inv = await prisma.customsInvoice.findUnique({ where: { orderNo: row.orderKey } });
      let isNew = false;
      if (!inv) {
        inv = await prisma.customsInvoice.create({
          data: {
            orderNo: row.orderKey,
            countryCode, marketCode: row.marketCode, marketSubCode: row.marketSubCode, templateFile,
            exporterName: DEFAULT_EXPORTER, buyerName: DEFAULT_BUYER, consigneeName: DEFAULT_BUYER,
            createdBy: actor,
          },
        });
        isNew = true;
      } else {
        await prisma.customsInvoice.update({ where: { id: inv.id }, data: { countryCode, templateFile, marketCode: row.marketCode || inv.marketCode, marketSubCode: row.marketSubCode || inv.marketSubCode } });
      }

      // Apply the Excel row's field values (append-only edit history).
      await updateInvoiceFields(inv.id, row.fields, { actor, source: "prefill" });

      const fresh = await prisma.customsInvoice.findUnique({ where: { id: inv.id } });
      const fields = fieldsFromRow(fresh as unknown as Record<string, unknown>);
      const out = await writeInvoiceXlsx(fields, { columnPlan: config.columnPlan, templateOverrides: config.templateOverrides });

      let name = `CustomsInvoice_${row.orderKey}_${(countryCode || "NO_TEMPLATE").replace(/[^\w.-]+/g, "-")}.xlsx`;
      if (usedNames.has(name)) name = name.replace(/\.xlsx$/, `_${inv.id.slice(0, 5)}.xlsx`);
      usedNames.add(name);
      entries.push({ name, data: out.buffer });

      if (isNew) created++; else updated++;
      if (out.mode !== "template") noTemplate++;
      results.push({
        orderNo: row.orderKey, invoiceId: inv.id, created: isNew,
        templateFile: out.templateUsed ? templateFile : null, mode: out.mode,
        note: out.mode === "template" ? "" : "No matching country template — generated a plain fallback workbook.",
      });
    } catch (e) {
      failed++;
      results.push({ orderNo: row.orderKey, invoiceId: "", created: false, templateFile: null, mode: "fresh", note: `Failed: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  const zip = buildZip(entries);
  const zipPath = bulkZipPath(runId);
  await mkdir(join(env.STORAGE_ROOT, "customs-invoice", "bulk"), { recursive: true });
  await writeFile(zipPath, zip);

  await audit({ entityType: "customs-invoice", entityId: runId, action: "customs-invoice.bulk-generated", actor, data: { created, updated, noTemplate, failed, total: rows.length } });

  return { runId, created, updated, noTemplate, failed, zipPath, zipBytes: zip.byteLength, rows: results, rejected: opts.rejected ?? [] };
}
