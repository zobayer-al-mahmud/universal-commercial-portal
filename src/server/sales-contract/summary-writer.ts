/**
 * Consolidated H&M Sales Contract Summary Excel writer (2026-10-26 spec §9, §11, §12).
 *
 * Workbook layout: one worksheet "H&M" with the 21-column header the user
 * requires. Rows are grouped by (commercialContNo, folderLetter) sections,
 * sorted by contract number ascending then by the folder's configured
 * sequence.
 *
 * The writer ALWAYS builds a fresh workbook from the given PO payload (user
 * rule 2026-11-03). Template-based merging was removed because it could
 * preserve stale rows from an older PO version when a newer-dated scan
 * replaced it — a direct contradiction of the "no old PO data remains
 * anywhere" rule enforced by the Sales Contract intake pipeline.
 */
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import ExcelJS from "exceljs";
import type { SalesContractSummaryRow } from "./summary-rows";
import { mapToSummaryRows, type SalesContractSummaryConfig } from "./summary-rows";
import type { SalesContractPoExtract } from "./types";

/** 21-column header, in order (spec §9). */
export const SUMMARY_HEADERS = [
  "Marchent Cont. No.",
  "Date",
  "Buyer Code",
  "Commercial Cont. No.",
  "Date",
  "Order No.",
  "Order Qty",
  "Style No.",
  "FOB",
  "Item Des.",
  "Cat",
  "HTS",
  "CONTRACT VALUE",
  "TOD",
  "COUNTRY",
  "REMARKS",
  "Merchandiser Name",
  "pack/set Qty",
  "pack/set",
  "Without Discount / Old FOB",
  "Discount FOB con: date",
] as const;

const SHEET_NAME = "H&M";
const HEADER_ROW = 1;
const DATA_START_ROW = 2;

export interface SalesContractSummaryWriteOptions {
  /** Where the workbook is written. */
  outputPath: string;
  /** PO extraction + per-PO config for every PO in scope. */
  pos: { poId: string; po: SalesContractPoExtract; config: SalesContractSummaryConfig }[];
  /** Sort order for folder letters (`[{ folderLetter: "A", sequence: 0 }, …]`).
   *  Folders not listed sort last, alphabetically. */
  folderSequence: { folderLetter: string; sequence: number }[];
}

export interface SalesContractSummaryWriteResult {
  outputPath: string;
  totalRows: number;
  insertedRows: number;
}

interface BuiltRow {
  commercialContNo: string;
  folderLetter: string;
  folderSequence: number;
  poSequence: number;
  orderNo: string;
  marketCode: string;
  isFirstForPo: boolean;
  values: (string | number | null)[];
}

export async function writeSummaryWorkbook(opts: SalesContractSummaryWriteOptions): Promise<SalesContractSummaryWriteResult> {
  await mkdir(dirname(opts.outputPath), { recursive: true });

  const folderSeq = new Map<string, number>();
  for (const f of opts.folderSequence) folderSeq.set(f.folderLetter.toUpperCase(), f.sequence);
  const seqOf = (f: string): number => {
    const upper = (f ?? "").toUpperCase();
    const s = folderSeq.get(upper);
    return typeof s === "number" ? s : Number.MAX_SAFE_INTEGER;
  };

  // Build summary rows for every PO in scope. Only the current DB state
  // contributes — no template, no preserved history.
  const built: BuiltRow[] = [];
  opts.pos.forEach(({ poId, po, config }, poIdx) => {
    const rows = mapToSummaryRows(po, config, poId);
    if (rows.length === 0) return;
    const commercialContNo = config.contractNo.trim();
    const folderLetter = config.folderLetter.trim().toUpperCase();
    for (const r of rows) {
      built.push({
        commercialContNo,
        folderLetter,
        folderSequence: seqOf(folderLetter),
        poSequence: poIdx,
        orderNo: r.orderNo,
        marketCode: r.marketCode,
        isFirstForPo: r.isFirstForPo,
        values: summaryRowToCells(r),
      });
    }
  });

  // Deterministic sort: contract number ASC, then folder sequence ASC, then
  // folder letter, then PO insertion order, then order no., then isFirstForPo
  // (anchor row for each PO comes first), then market code.
  built.sort((a, b) => {
    const n = cmpNum(a.commercialContNo, b.commercialContNo);
    if (n !== 0) return n;
    if (a.folderSequence !== b.folderSequence) return a.folderSequence - b.folderSequence;
    if (a.folderLetter !== b.folderLetter) return a.folderLetter.localeCompare(b.folderLetter);
    if (a.poSequence !== b.poSequence) return a.poSequence - b.poSequence;
    if (a.orderNo !== b.orderNo) return a.orderNo.localeCompare(b.orderNo);
    if (a.isFirstForPo !== b.isFirstForPo) return a.isFirstForPo ? -1 : 1;
    return a.marketCode.localeCompare(b.marketCode);
  });

  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet(SHEET_NAME);
  const headerRow = sheet.getRow(HEADER_ROW);
  SUMMARY_HEADERS.forEach((h, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = h;
    cell.font = { bold: true };
  });
  sheet.columns = SUMMARY_HEADERS.map((h) => ({ header: h, width: Math.max(10, Math.min(32, h.length + 4)) }));

  built.forEach((row, idx) => {
    const r = sheet.getRow(DATA_START_ROW + idx);
    row.values.forEach((v, col) => {
      // col is 0-based; cells are 1-based.
      const cell = r.getCell(col + 1);
      if (v === null || v === undefined) return;
      cell.value = v;
    });
    r.commit();
  });

  await wb.xlsx.writeFile(opts.outputPath);
  return {
    outputPath: opts.outputPath,
    totalRows: built.length,
    insertedRows: built.length,
  };
}

function summaryRowToCells(r: SalesContractSummaryRow): (string | number | null)[] {
  // 21 columns, in header order.
  //   Column B = merchandiser entry date per (contract × folder); re-used
  //              on every row from the same folder in the same contract.
  //              Carried in `folderCommercialDate` from summary.ts.
  //   Column E = Sales Contract date (one date per contract). Carried in
  //              `contractDate` from summary.ts.
  return [
    r.marchentContNo,                       // A
    r.folderCommercialDate,                 // B — per (contract × folder) merchandiser date
    r.buyerCode,                            // C
    r.commercialContNo,                     // D
    r.contractDate,                         // E — Sales Contract date (one per contract)
    r.orderNo,                              // F
    r.orderQty,                             // G
    r.styleNo,                              // H
    r.fob,                                  // I
    r.itemDes,                              // J
    r.cat,                                  // K
    r.hts,                                  // L
    r.contractValue,                        // M
    r.tod,                                  // N
    r.country,                              // O
    r.remarks,                              // P
    r.merchandiserName,                     // Q
    r.packSetQty,                           // R
    r.packSet,                              // S
    r.withoutDiscountOldFob,                // T
    r.discountFobConDate,                   // U
  ];
}

/**
 * Extract the H&M market code from a COUNTRY cell string. Handles both the
 * new-format cell (`"OE (OLCEU)"` / `"OE (OLCEU) [art 051]"`) and the legacy
 * merged format the live tracker uses in historical rows
 * (`"29 Jun, 2026 OE (OLCEU) 3 544 87%"`). Kept as an exported helper for
 * unit tests that still parse the live tracker.
 */
export function extractMarketCode(country: string): string {
  const s = String(country ?? "").trim();
  if (!s) return "";
  const paren = s.match(/\b([A-Z]{2,3})\s*\(/);  // "<CODE> ("
  if (paren) return paren[1];
  const token = s.match(/^([A-Z]{2,3})\b/);       // bare "<CODE>"
  if (token) return token[1];
  const anywhere = s.match(/\b([A-Z]{2,3})\b/);   // last resort
  return anywhere ? anywhere[1] : "";
}

/** Compare two strings numerically when both are integers; fall back to lex. */
function cmpNum(a: string, b: string): number {
  const na = Number(a), nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return a.localeCompare(b);
}
