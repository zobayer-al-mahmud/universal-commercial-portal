/**
 * Bulk-import ShipmentScheduleRow entries from an uploaded .xlsx.
 *
 * Expected columns (case-insensitive; header row located by scanning for
 * "OrderNo." in the first 20 rows). Any subset works; unknown columns are
 * ignored, missing columns leave the field blank:
 *   OrderNo. · Buyer Code · Cont.No. · Date · PCS · STYLE · FOB · COMPOSITION
 *   · CAT · HTS · INVOICE · Market+Sub · Market · Mode · BCN · Booking Ref
 *   · Status · POL · POD · POD2 · Gross Weight · Cartons · CBM
 *
 * Rows are placed under the schedule's FIRST cut-off (sortOrder = 1). For each
 * row whose OrderNo matches an existing READY SalesContractPo, Sales-Contract
 * fields (buyer, contract, style, fob, composition, pcs) are hydrated – the
 * user's own value in the Excel wins when provided.
 */

import ExcelJS from "exceljs";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { matchByOrderNoPrefix } from "./match-sales-contract";
import type { SalesContractLookup } from "./types";

export interface ImportedShipmentRow {
  orderNo: string;
  buyerCode: string;
  contractNo: string;
  contractDate: string;
  pcs: number | null;
  style: string;
  fob: number | null;
  composition: string;
  cat: string;
  hts: string;
  invoiceNo: string;
  marketSubCode: string;
  marketCode: string;
  transportMode: string;
  bcn: string;
  bookingRef: string;
  bookingStatus: string;
  portOfLoading: string;
  portOfDischarge: string;
  placeOfDelivery: string;
  grossWeightKg: number | null;
  cartons: number | null;
  measurementCbm: number | null;
}

export interface ImportResult {
  totalRows: number;
  created: number;
  updated: number;
  hydrated: number;
  skippedBlank: number;
  rejected: { row: number; reason: string }[];
}

type Key = keyof ImportedShipmentRow;

const CANONICAL: Record<string, Key> = {
  "orderno": "orderNo",
  "orderno.": "orderNo",
  "order no": "orderNo",
  "order no.": "orderNo",
  "buyer code": "buyerCode",
  "buyercode": "buyerCode",
  "cont.no.": "contractNo",
  "cont.no": "contractNo",
  "cont no.": "contractNo",
  "cont no": "contractNo",
  "contract no": "contractNo",
  "date": "contractDate",
  "pcs": "pcs",
  "style": "style",
  "style no.": "style",
  "fob": "fob",
  "unit price": "fob",
  "composition": "composition",
  "item des.": "composition",
  "cat": "cat",
  "hts": "hts",
  "invoice": "invoiceNo",
  "invoice no": "invoiceNo",
  "invoice no.": "invoiceNo",
  "market+sub": "marketSubCode",
  "market sub": "marketSubCode",
  "market": "marketCode",
  "mode": "transportMode",
  "bcn": "bcn",
  "booking ref": "bookingRef",
  "bookingref": "bookingRef",
  "status": "bookingStatus",
  "booking status": "bookingStatus",
  "pol": "portOfLoading",
  "port of loading": "portOfLoading",
  "pod": "portOfDischarge",
  "port of discharge": "portOfDischarge",
  "place of delivery": "placeOfDelivery",
  "gross weight": "grossWeightKg",
  "gross weight (kg)": "grossWeightKg",
  "cartons": "cartons",
  "cbm": "measurementCbm",
  "measurement": "measurementCbm",
};

function norm(s: unknown): string {
  return String(s ?? "").trim().toLowerCase();
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

const STRING_KEYS: Key[] = [
  "orderNo", "buyerCode", "contractNo", "contractDate", "style", "composition",
  "cat", "hts", "invoiceNo", "marketSubCode", "marketCode", "transportMode",
  "bcn", "bookingRef", "bookingStatus", "portOfLoading", "portOfDischarge",
  "placeOfDelivery",
];
const NUM_KEYS: Key[] = ["pcs", "fob", "grossWeightKg", "cartons", "measurementCbm"];

export async function parseShipmentScheduleXlsx(buffer: Buffer): Promise<{
  rows: ImportedShipmentRow[];
  rejected: { row: number; reason: string }[];
}> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  const sheet = wb.worksheets[0];
  if (!sheet) return { rows: [], rejected: [{ row: 0, reason: "Workbook has no worksheets." }] };

  // Find the header row – any row whose cells include at least "OrderNo" plus
  // one other known column.
  let headerRow = -1;
  const colMap = new Map<Key, number>();
  const maxScan = Math.min(20, Math.max(sheet.rowCount, 20));
  for (let r = 1; r <= maxScan; r++) {
    const row = sheet.getRow(r);
    const tentative = new Map<Key, number>();
    for (let c = 1; c <= Math.max(row.actualCellCount, 25); c++) {
      const label = norm(toStr(row.getCell(c).value));
      if (!label) continue;
      const key = CANONICAL[label];
      if (key && !tentative.has(key)) tentative.set(key, c);
    }
    if (tentative.has("orderNo") && tentative.size >= 2) {
      headerRow = r;
      tentative.forEach((v, k) => colMap.set(k, v));
      break;
    }
  }
  if (headerRow === -1) {
    return { rows: [], rejected: [{ row: 0, reason: 'Could not find a header row containing "OrderNo."' }] };
  }

  const rows: ImportedShipmentRow[] = [];
  const rejected: { row: number; reason: string }[] = [];
  const last = Math.max(sheet.rowCount, sheet.actualRowCount);
  for (let r = headerRow + 1; r <= last; r++) {
    const row = sheet.getRow(r);
    if (!row || row.actualCellCount === 0) continue;
    const orderNoCol = colMap.get("orderNo");
    if (!orderNoCol) continue;
    const orderNo = toStr(row.getCell(orderNoCol).value).trim();
    if (!orderNo) continue;

    const out: ImportedShipmentRow = {
      orderNo, buyerCode: "", contractNo: "", contractDate: "", pcs: null, style: "",
      fob: null, composition: "", cat: "", hts: "", invoiceNo: "", marketSubCode: "",
      marketCode: "", transportMode: "", bcn: "", bookingRef: "", bookingStatus: "",
      portOfLoading: "", portOfDischarge: "", placeOfDelivery: "", grossWeightKg: null,
      cartons: null, measurementCbm: null,
    };
    const bag = out as unknown as Record<string, unknown>;
    for (const k of STRING_KEYS) {
      const col = colMap.get(k);
      if (col) bag[k] = toStr(row.getCell(col).value);
    }
    for (const k of NUM_KEYS) {
      const col = colMap.get(k);
      if (col) bag[k] = toNum(row.getCell(col).value);
    }
    rows.push(out);
  }
  return { rows, rejected };
}

/**
 * Import parsed rows into a Shipment Schedule. Each row is placed under the
 * schedule's first cut-off (by sortOrder). For each row, we try to hydrate
 * Sales-Contract fields by matching the OrderNo prefix against READY
 * SalesContractPo entries. The user's own values in the Excel always win.
 */
export async function importShipmentRowsIntoSchedule(
  scheduleId: string,
  rows: ImportedShipmentRow[],
  opts: { actor?: string } = {},
): Promise<ImportResult> {
  const actor = opts.actor ?? "system";
  const result: ImportResult = {
    totalRows: rows.length, created: 0, updated: 0, hydrated: 0, skippedBlank: 0, rejected: [],
  };

  const firstCutoff = await prisma.shipmentScheduleCutoff.findFirst({
    where: { scheduleId },
    orderBy: { sortOrder: "asc" },
  });
  if (!firstCutoff) {
    result.rejected.push({ row: 0, reason: "Schedule has no cut-offs." });
    return result;
  }

  for (const r of rows) {
    if (!r.orderNo) { result.skippedBlank++; continue; }

    const prefix = r.orderNo.split("-")[0] || r.orderNo;
    const pos = await prisma.salesContractPo.findMany({
      where: { orderNo: { startsWith: prefix + "-" } },
      include: { contract: true },
      take: 20,
    });
    const lookups: SalesContractLookup[] = pos.map((p) => ({
      contract: {
        marchentContNo: p.contract.marchentContNo,
        contractDate: p.contract.contractDate,
        buyerCode: p.contract.buyerCode,
        commercialContNo: p.contract.commercialContNo,
        commercialDate: p.contract.commercialDate,
      },
      orderNo: p.orderNo,
      state: p.state,
      rowsJson: p.rowsJson,
    }));
    const match = matchByOrderNoPrefix(prefix, lookups);
    const h = match.hydrated;
    if (match.matched) result.hydrated++;

    const data = {
      scheduleId,
      cutoffId: firstCutoff.id,
      orderNo: r.orderNo || h?.orderNo || "",
      buyerCode: r.buyerCode || h?.buyerCode || "",
      contractNo: r.contractNo || h?.contractNo || "",
      contractDate: r.contractDate || h?.contractDate || "",
      pcs: r.pcs ?? h?.pcs ?? null,
      style: r.style || h?.style || "",
      fob: r.fob ?? h?.fob ?? null,
      composition: r.composition || h?.composition || "",
      cat: r.cat || h?.cat || "",
      hts: r.hts || h?.hts || "",
      invoiceNo: r.invoiceNo || "",
      // Market+Sub = country code + sub (e.g. "AUW118"); Market = country code
      // alone (e.g. "AU"). Fall back to the matched Sales Contract when the
      // Excel row leaves them blank.
      marketSubCode: r.marketSubCode || h?.marketSubCode || "",
      marketCode: r.marketCode || h?.marketCode || "",
      transportMode: r.transportMode || "",
      bcn: r.bcn || "",
      bookingRef: r.bookingRef || "",
      bookingStatus: r.bookingStatus || "",
      portOfLoading: r.portOfLoading || "",
      portOfDischarge: r.portOfDischarge || "",
      placeOfDelivery: r.placeOfDelivery || "",
      pdfOrderNo: "",
      skuItem: "",
      pdfPcs: r.pcs ?? null,
      grossWeightKg: r.grossWeightKg,
      cartons: r.cartons,
      measurementCbm: r.measurementCbm,
      pdfFileName: "",
      pdfSha256: "",
      pdfPath: "",
      matched: match.matched,
      matchReason: match.reason,
    };

    try {
      const existing = await prisma.shipmentScheduleRow.findFirst({
        where: { scheduleId, orderNo: r.orderNo },
      });
      if (existing) {
        await prisma.shipmentScheduleRow.update({ where: { id: existing.id }, data });
        result.updated++;
      } else {
        await prisma.shipmentScheduleRow.create({ data });
        result.created++;
      }
    } catch (e) {
      result.rejected.push({ row: 0, reason: `${r.orderNo}: ${e instanceof Error ? e.message : "upsert failed"}` });
    }
  }

  await audit({
    entityType: "shipment-schedule",
    entityId: scheduleId,
    action: "xlsx.imported",
    actor,
    data: { totalRows: result.totalRows, created: result.created, updated: result.updated, hydrated: result.hydrated },
  });

  return result;
}
