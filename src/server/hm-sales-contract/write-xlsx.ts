import { copyFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import ExcelJS from "exceljs";
import type { HmSetResult, HmTemplateRow } from "./types";

/**
 * Append rows for one Sales Contract to the user's workbook, writing to a NEW
 * file (the original template is NEVER modified — user spec §7).
 *
 * The destination sheet is `H&M`. We locate the first truly empty row at the
 * bottom of its existing data (the live sheet already holds ~12 000 rows) and
 * append from there. Headers are preserved.
 */
export interface HmWriteOptions {
  /** Path to the user's untouched template workbook. */
  templatePath: string;
  /** Path the new workbook will be written to. */
  outputPath: string;
  /** Sales Contract-level header values that the user has set in the UI. These
   *  populate the A/B/C/D/E/P/Q/S cells for every row in the contract. Each is
   *  OPTIONAL; omitted fields stay blank. */
  header?: {
    marchentContNo?: string;
    date?: string | Date;
    buyerCode?: string;
    commercialContNo?: string;
    dateCommercial?: string | Date;
    merchandiserName?: string;
    packSet?: string | number;
    remarksDefault?: string;
  };
  /** All PO sets that belong under this Sales Contract. Blocked sets are
   *  skipped — their rows are not appended. */
  sets: HmSetResult[];
  /** User-edited row overrides, keyed by `${orderNo}:${marketCode}`. Any cell
   *  override replaces the extracted value for that row/column. */
  overrides?: Record<string, Partial<HmFlatCells>>;
}

export interface HmFlatCells {
  marchentContNo: string;      // A
  date: string | Date | null;   // B
  buyerCode: string;            // C
  commercialContNo: string;     // D
  dateCommercial: string | Date | null; // E
  orderNo: string;              // F
  orderQty: number | null;      // G
  styleNo: string;              // H
  fob: number | null;           // I
  itemDes: string;              // J
  cat: string;                  // K
  hts: string;                  // L
  // M (CONTRACT VALUE) is a formula on anchor rows
  tod: string;                  // N
  country: string;              // O
  remarks: string;              // P
  merchandiserName: string;     // Q
  // R (pack/set Qty) is a formula on anchor rows
  packSet: string | number | null; // S
  withoutDiscount: string;      // T
  discountFobDate: string;      // U
}

export interface HmWriteResult {
  outputPath: string;
  appendedRows: number;
  firstRow: number;
  lastRow: number;
  blockedSets: { orderNo: string; reasons: string[] }[];
}

const SHEET_NAME = "H&M";

export async function writeSalesContractWorkbook(opts: HmWriteOptions): Promise<HmWriteResult> {
  // Never overwrite the original template.
  await mkdir(dirname(opts.outputPath), { recursive: true });
  if (opts.outputPath !== opts.templatePath) {
    await copyFile(opts.templatePath, opts.outputPath);
  }

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(opts.outputPath);
  const sheet = wb.getWorksheet(SHEET_NAME);
  if (!sheet) throw new Error(`Workbook has no "${SHEET_NAME}" worksheet.`);

  // First empty row below the current data.
  const firstEmpty = findFirstEmptyRow(sheet);
  let rowIdx = firstEmpty;
  let appended = 0;

  const blocked: HmWriteResult["blockedSets"] = [];

  for (const set of opts.sets) {
    if (set.blockWrite) {
      blocked.push({ orderNo: set.orderNo, reasons: set.reasons });
      continue;
    }
    for (const r of set.rows) {
      const cells = applyOverrides(flattenRow(r, opts.header), opts.overrides?.[`${r.orderNo}:${r.marketCode}`]);
      writeRow(sheet, rowIdx, cells, r.isAnchor);
      rowIdx++;
      appended++;
    }
  }

  await wb.xlsx.writeFile(opts.outputPath);
  return {
    outputPath: opts.outputPath,
    appendedRows: appended,
    firstRow: firstEmpty,
    lastRow: rowIdx - 1,
    blockedSets: blocked,
  };
}

function flattenRow(r: HmTemplateRow, header: HmWriteOptions["header"]): HmFlatCells {
  return {
    marchentContNo: header?.marchentContNo ?? "",
    date: header?.date ?? null,
    buyerCode: header?.buyerCode ?? "",
    commercialContNo: header?.commercialContNo ?? "",
    dateCommercial: header?.dateCommercial ?? null,
    orderNo: r.orderNo,
    orderQty: r.orderQty,
    styleNo: r.styleNo,
    fob: r.fob,
    itemDes: r.itemDes,
    cat: "",
    hts: "",
    tod: r.tod,
    country: r.country,
    remarks: header?.remarksDefault ?? "",
    merchandiserName: header?.merchandiserName ?? "",
    packSet: header?.packSet ?? "",
    withoutDiscount: "",
    discountFobDate: "",
  };
}

function applyOverrides(cells: HmFlatCells, overrides?: Partial<HmFlatCells>): HmFlatCells {
  if (!overrides) return cells;
  return { ...cells, ...overrides };
}

function writeRow(sheet: ExcelJS.Worksheet, rowIdx: number, c: HmFlatCells, isAnchor: boolean): void {
  const row = sheet.getRow(rowIdx);
  row.getCell(1).value = c.marchentContNo;                            // A
  row.getCell(2).value = c.date ?? "";                                 // B
  row.getCell(3).value = c.buyerCode;                                  // C
  row.getCell(4).value = c.commercialContNo;                           // D
  row.getCell(5).value = c.dateCommercial ?? "";                       // E
  row.getCell(6).value = c.orderNo;                                    // F
  if (c.orderQty !== null) row.getCell(7).value = c.orderQty;          // G
  row.getCell(8).value = c.styleNo;                                    // H
  if (c.fob !== null) row.getCell(9).value = c.fob;                    // I
  row.getCell(10).value = c.itemDes;                                   // J
  row.getCell(11).value = c.cat;                                       // K
  row.getCell(12).value = c.hts;                                       // L
  if (isAnchor) {
    row.getCell(13).value = { formula: `G${rowIdx}*I${rowIdx}` };      // M — anchor only
  }
  row.getCell(14).value = c.tod;                                       // N
  row.getCell(15).value = c.country;                                   // O
  row.getCell(16).value = c.remarks;                                   // P
  row.getCell(17).value = c.merchandiserName;                          // Q
  if (isAnchor) {
    row.getCell(18).value = { formula: `S${rowIdx}*G${rowIdx}` };      // R — anchor only
  }
  row.getCell(19).value = c.packSet ?? "";                             // S
  row.getCell(20).value = c.withoutDiscount;                           // T
  row.getCell(21).value = c.discountFobDate;                           // U
  row.commit();
}

/** First row whose A..U are all empty, searching downward from row 2. The live
 *  H&M sheet already holds ~12 000 rows, so we scan the actual used range. */
function findFirstEmptyRow(sheet: ExcelJS.Worksheet): number {
  const last = sheet.actualRowCount;
  for (let r = Math.max(2, last + 1); r <= last + 1; r++) {
    if (isRowEmpty(sheet, r)) return r;
  }
  return last + 1;
}

function isRowEmpty(sheet: ExcelJS.Worksheet, r: number): boolean {
  for (let c = 1; c <= 21; c++) {
    const v = sheet.getRow(r).getCell(c).value;
    if (v !== null && v !== undefined && v !== "") return false;
  }
  return true;
}
