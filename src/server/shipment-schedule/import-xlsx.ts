/**
 * Bulk import of Shipment Schedule rows from an .xlsx that mirrors the exported
 * per-cut-off layout (see write-xlsx.ts HEADERS). Pure parse → preview →
 * commit. Rows are matched by Order No. against the H&M Sales Contract POs for
 * hydration/traceability; invalid Order Nos are rejected and duplicates (same
 * Order No. already in this schedule) are skipped. Existing schedules, rows and
 * PDF uploads are never touched.
 */

import ExcelJS from "exceljs";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";

export interface ScheduleImportRow {
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
}

/** Column header (lower-cased, trimmed) → ScheduleImportRow key. */
const CANONICAL: Record<string, keyof ScheduleImportRow> = {
  "orderno.": "orderNo", "orderno": "orderNo", "order no.": "orderNo", "order no": "orderNo",
  "buyer code": "buyerCode", "buyercode": "buyerCode",
  "cont.no.": "contractNo", "cont.no": "contractNo", "cont no.": "contractNo", "contract no.": "contractNo", "contract no": "contractNo",
  "date": "contractDate",
  "pcs": "pcs",
  "style": "style",
  "fob": "fob",
  "composition": "composition",
  "cat": "cat",
  "hts": "hts",
  "invoice": "invoiceNo", "invoice no": "invoiceNo", "invoice no.": "invoiceNo",
  "market+sub": "marketSubCode", "market + sub": "marketSubCode", "marketsub": "marketSubCode",
  "market": "marketCode",
  "mode": "transportMode",
};

const STRING_KEYS: (keyof ScheduleImportRow)[] = [
  "orderNo", "buyerCode", "contractNo", "contractDate", "style", "composition", "cat", "hts", "invoiceNo", "marketSubCode", "marketCode", "transportMode",
];
const INT_KEYS: (keyof ScheduleImportRow)[] = ["pcs"];
const FLOAT_KEYS: (keyof ScheduleImportRow)[] = ["fob"];

function normalise(s: unknown): string { return String(s ?? "").trim().toLowerCase(); }

function toStr(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") {
    if ("richText" in v) return ((v as { richText?: { text: string }[] }).richText ?? []).map((r) => r.text).join("");
    if ("result" in v) { const r = (v as { result?: unknown }).result; return r == null ? "" : String(r); }
    if ("text" in v) { const t = (v as { text?: unknown }).text; if (typeof t === "string") return t; }
  }
  return String(v).trim();
}

function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "object" && "result" in v) {
    const r = (v as { result?: unknown }).result;
    const n = typeof r === "number" ? r : Number(r);
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(String(v).replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** A valid order number has at least 6 consecutive digits somewhere in it. */
export function isValidOrderNo(orderNo: string): boolean {
  return /\d{6,}/.test(orderNo);
}

/** Short join key — the leading 6+ digit run (shared with pull-data.shortOrderKey). */
export function orderShortKey(orderNo: string): string {
  const m = (orderNo || "").match(/\d{6,}/);
  return m ? m[0] : (orderNo || "").trim();
}

export interface ParseResult {
  rows: ScheduleImportRow[];
  rejected: { row: number; reason: string }[];
}

/** Parse an .xlsx buffer into ScheduleImportRow[] (pure). */
export async function parseScheduleXlsx(buffer: Buffer): Promise<ParseResult> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  const sheet = wb.worksheets[0];
  if (!sheet) return { rows: [], rejected: [{ row: 0, reason: "Workbook has no worksheets." }] };

  // Locate the header row by scanning the first 20 physical rows for "OrderNo.".
  let headerRowIdx = -1;
  const colMap = {} as Record<keyof ScheduleImportRow, number>;
  for (const k of [...STRING_KEYS, ...INT_KEYS, ...FLOAT_KEYS]) colMap[k] = -1;
  const maxScan = Math.min(20, Math.max(sheet.rowCount, 20));
  for (let r = 1; r <= maxScan; r++) {
    const row = sheet.getRow(r);
    const tentative = { ...colMap };
    let hits = 0;
    for (let c = 1; c <= Math.max(row.actualCellCount, 20); c++) {
      const key = CANONICAL[normalise(toStr(row.getCell(c).value))];
      if (key && tentative[key] === -1) { tentative[key] = c; hits++; }
    }
    if (tentative.orderNo !== -1 && hits >= 2) { headerRowIdx = r; Object.assign(colMap, tentative); break; }
  }
  if (headerRowIdx === -1) return { rows: [], rejected: [{ row: 0, reason: 'Could not find a header row containing "OrderNo.".' }] };

  const rows: ScheduleImportRow[] = [];
  const rejected: { row: number; reason: string }[] = [];
  const last = Math.max(sheet.rowCount, sheet.actualRowCount);
  for (let r = headerRowIdx + 1; r <= last; r++) {
    const row = sheet.getRow(r);
    if (!row || row.actualCellCount === 0) continue;
    const orderNo = toStr(row.getCell(colMap.orderNo).value).trim();
    if (!orderNo) continue; // skip blank rows silently
    const get = (k: keyof ScheduleImportRow) => (colMap[k] !== -1 ? row.getCell(colMap[k]).value : null);
    const rec: ScheduleImportRow = {
      orderNo,
      buyerCode: toStr(get("buyerCode")),
      contractNo: toStr(get("contractNo")),
      contractDate: toStr(get("contractDate")),
      pcs: toNum(get("pcs")),
      style: toStr(get("style")),
      fob: toNum(get("fob")),
      composition: toStr(get("composition")),
      cat: toStr(get("cat")),
      hts: toStr(get("hts")),
      invoiceNo: toStr(get("invoiceNo")),
      marketSubCode: toStr(get("marketSubCode")),
      marketCode: toStr(get("marketCode")),
      transportMode: toStr(get("transportMode")),
    };
    rows.push(rec);
  }
  return { rows, rejected };
}

export type Disposition = "new" | "duplicate" | "invalid";

export interface PreviewRow extends ScheduleImportRow {
  disposition: Disposition;
  matched: boolean; // a Sales Contract PO exists for this Order No.
  note: string;
}

export interface PreviewResult {
  rows: PreviewRow[];
  counts: { total: number; new: number; duplicate: number; invalid: number; matched: number };
}

/** Classify parsed rows against the schedule (existing rows) + Sales Contract POs. No writes. */
export async function previewScheduleImport(scheduleId: string, parsed: ScheduleImportRow[]): Promise<PreviewResult> {
  const existing = await prisma.shipmentScheduleRow.findMany({ where: { scheduleId }, select: { orderNo: true } });
  const existingKeys = new Set(existing.map((e) => orderShortKey(e.orderNo)));

  // All SC PO order keys (for match flagging).
  const pos = await prisma.hmSalesContractPo.findMany({ select: { orderNo: true } });
  const poKeys = new Set(pos.map((p) => orderShortKey(p.orderNo)).filter(Boolean));

  const seenInBatch = new Set<string>();
  const rows: PreviewRow[] = parsed.map((rec) => {
    const key = orderShortKey(rec.orderNo);
    let disposition: Disposition;
    let note = "";
    if (!isValidOrderNo(rec.orderNo)) { disposition = "invalid"; note = "Order No. has no 6+ digit run."; }
    else if (existingKeys.has(key) || seenInBatch.has(key)) { disposition = "duplicate"; note = "Order No. already in this schedule."; }
    else { disposition = "new"; seenInBatch.add(key); }
    const matched = poKeys.has(key);
    if (disposition === "new" && !matched) note = "No Sales Contract PO for this Order No. — imported for manual review.";
    return { ...rec, disposition, matched, note };
  });

  const counts = {
    total: rows.length,
    new: rows.filter((r) => r.disposition === "new").length,
    duplicate: rows.filter((r) => r.disposition === "duplicate").length,
    invalid: rows.filter((r) => r.disposition === "invalid").length,
    matched: rows.filter((r) => r.matched).length,
  };
  return { rows, counts };
}

export interface CommitResult {
  created: number;
  skippedDuplicates: number;
  skippedInvalid: number;
  cutoffId: string;
}

/**
 * Insert the "new" rows into the schedule under the chosen cut-off (defaults to
 * the schedule's first cut-off). Duplicates + invalids are skipped. Each new row
 * is flagged matched/unmatched against the Sales Contract POs for traceability.
 */
export async function commitScheduleImport(
  scheduleId: string,
  parsed: ScheduleImportRow[],
  opts: { cutoffId?: string; actor: string },
): Promise<CommitResult> {
  const schedule = await prisma.shipmentSchedule.findUnique({ where: { id: scheduleId }, include: { cutoffs: { orderBy: { sortOrder: "asc" } } } });
  if (!schedule) throw new Error("Shipment schedule not found.");
  const cutoff = opts.cutoffId
    ? schedule.cutoffs.find((c) => c.id === opts.cutoffId)
    : schedule.cutoffs[0];
  if (!cutoff) throw new Error("This schedule has no cut-off to import into.");

  const preview = await previewScheduleImport(scheduleId, parsed);
  const result: CommitResult = { created: 0, skippedDuplicates: 0, skippedInvalid: 0, cutoffId: cutoff.id };

  for (const row of preview.rows) {
    if (row.disposition === "invalid") { result.skippedInvalid++; continue; }
    if (row.disposition === "duplicate") { result.skippedDuplicates++; continue; }
    await prisma.shipmentScheduleRow.create({
      data: {
        scheduleId,
        cutoffId: cutoff.id,
        buyerCode: row.buyerCode,
        contractNo: row.contractNo,
        contractDate: row.contractDate,
        orderNo: row.orderNo,
        pcs: row.pcs,
        style: row.style,
        fob: row.fob,
        composition: row.composition,
        cat: row.cat,
        hts: row.hts,
        invoiceNo: row.invoiceNo,
        marketSubCode: row.marketSubCode,
        marketCode: row.marketCode,
        transportMode: row.transportMode,
        pdfFileName: "(imported from .xlsx)",
        matched: row.matched,
        matchReason: row.matched ? "matched" : "imported_no_sales_contract_po",
      },
    });
    result.created++;
  }

  await audit({ entityType: "shipment-schedule", entityId: scheduleId, action: "schedule.import.committed", actor: opts.actor, data: { ...result, total: parsed.length } });
  return result;
}
