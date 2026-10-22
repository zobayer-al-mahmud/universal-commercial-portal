import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import ExcelJS from "exceljs";
import type { HmSetResult, HmTemplateRow } from "./types";

/**
 * Build a FRESH Sales Contract master Excel from scratch, containing ONLY the
 * data extracted from the uploaded PDFs for this contract. No template is
 * inherited — the user explicitly rejected appending to a template that already
 * holds historical rows (2026-10-20 follow-up).
 *
 * Layout (one worksheet named "Sales Contract", mirrors the user's prototype):
 *   Row 1 : (reserved for a company logo cell — plain text "PULS TRADING" for now)
 *   Row 3 : "Block Contract Ref:  : <marchentContNo>"            Date: <contractDate>
 *   Row 5 : "Revise: <N>"                                        Date: <latest update>
 *   Row 7 : Column headers (blue, bold)
 *   Row 8+: ONE row per PO with every field pulled from the PDFs — missing
 *           values stay blank. Column headers never contain field names or
 *           missing values (template-safe). The exported .xlsx remains editable
 *           in Excel: no fields are locked.
 */
export interface HmWriteOptions {
  /** Optional — ignored by the new writer, kept so existing callers compile. */
  templatePath?: string;
  /** Path the new workbook will be written to. */
  outputPath: string;
  /** Sales Contract-level fields the user has set in the UI. */
  header?: {
    marchentContNo?: string;
    date?: string | Date;
    buyerCode?: string;
    commercialContNo?: string;
    dateCommercial?: string | Date;
    merchandiserName?: string;
    packSet?: string | number;
    remarksDefault?: string;
    reviseNo?: string | number;
  };
  /** All PO sets that belong under this Sales Contract. Blocked sets are
   *  skipped — their rows are not written. */
  sets: HmSetResult[];
  /** User-edited row overrides, keyed by orderNo. Any cell override replaces
   *  the extracted value for that PO's row. */
  overrides?: Record<string, Partial<HmFlatCells>>;
}

export interface HmFlatCells {
  marchentContNo: string;
  date: string | Date | null;
  buyerCode: string;
  commercialContNo: string;
  dateCommercial: string | Date | null;
  orderNo: string;
  orderQty: number | null;
  styleNo: string;
  fob: number | null;
  itemDes: string;
  cat: string;
  hts: string;
  tod: string;
  country: string;
  remarks: string;
  merchandiserName: string;
  packSet: string | number | null;
  withoutDiscount: string;
  discountFobDate: string;
  // User-editable overrides for the two calculated Excel columns. When
  // present, they REPLACE the Order Qty × packSet / Order Qty × FOB
  // calculation on export — the user's typed value wins.
  totalWithPacks: number | null;
  value: number | null;
}

export interface HmWriteResult {
  outputPath: string;
  appendedRows: number;
  firstRow: number;
  lastRow: number;
  blockedSets: { orderNo: string; reasons: string[] }[];
}

const SHEET_NAME = "Sales Contract";
const BLUE = "FF0000FF";
// User spec (2026-10-20 revision): a small banner at the top holds the two
// fields the user types manually in the UI — Block Contract Ref + Revise.
// They are NEVER sourced from a PDF; a blank UI value → a blank banner line.
// Column headers follow at row 5, data rows start at row 6.
const BANNER_REF_ROW = 1;
const BANNER_REVISE_ROW = 3;
const HEADER_ROW = 5;
const DATA_START_ROW = 6;

const COLUMNS: { header: string; width: number; alignment?: Partial<ExcelJS.Alignment> }[] = [
  { header: "Order No.", width: 14, alignment: { horizontal: "left" } },
  { header: "Style No.", width: 22, alignment: { horizontal: "left" } },
  { header: "Description", width: 40, alignment: { horizontal: "left" } },
  { header: "Order Qty", width: 11, alignment: { horizontal: "right" } },
  { header: "Total Qty With Packs", width: 13, alignment: { horizontal: "right" } },
  { header: "Unit Price", width: 11, alignment: { horizontal: "right" } },
  { header: "Value", width: 14, alignment: { horizontal: "right" } },
  { header: "Time of Delivery", width: 22, alignment: { horizontal: "left", wrapText: true, vertical: "top" } },
];

export async function writeSalesContractWorkbook(opts: HmWriteOptions): Promise<HmWriteResult> {
  await mkdir(dirname(opts.outputPath), { recursive: true });

  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet(SHEET_NAME);
  COLUMNS.forEach((c, i) => { sheet.getColumn(i + 1).width = c.width; });

  // --- Banner (user-typed only; blank fields → the whole banner line stays blank) ---
  const ref = safeStr(opts.header?.marchentContNo);
  if (ref) {
    const refCell = sheet.getCell(BANNER_REF_ROW, 1);
    refCell.value = `Block Contract Ref:  : ${ref}`;
    refCell.font = { bold: true, color: { argb: BLUE } };
  }
  const rev = safeStr(opts.header?.reviseNo);
  if (rev) {
    const revCell = sheet.getCell(BANNER_REVISE_ROW, 1);
    revCell.value = `Revise: ${rev}`;
    revCell.font = { bold: true, color: { argb: BLUE } };
  }

  // --- Column header row ---
  const headerRow = sheet.getRow(HEADER_ROW);
  COLUMNS.forEach((c, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = c.header;
    cell.font = { bold: true, color: { argb: BLUE } };
    cell.alignment = { horizontal: c.alignment?.horizontal ?? "left", vertical: "middle" };
    cell.border = {
      top: { style: "thin", color: { argb: "FF000000" } },
      bottom: { style: "thin", color: { argb: "FF000000" } },
    };
  });
  headerRow.height = 20;

  // --- Data rows: ONE row per PO ---
  let rowIdx = DATA_START_ROW;
  let appended = 0;
  const blocked: HmWriteResult["blockedSets"] = [];

  for (const set of opts.sets) {
    if (set.blockWrite) {
      blocked.push({ orderNo: set.orderNo, reasons: set.reasons });
      continue;
    }
    for (const r of set.rows) {
      const cells = applyOverrides(flattenRow(r, set, opts.header), opts.overrides?.[r.orderNo]);
      writeDataRow(sheet, rowIdx, cells);
      rowIdx++;
      appended++;
    }
  }

  await wb.xlsx.writeFile(opts.outputPath);
  return {
    outputPath: opts.outputPath,
    appendedRows: appended,
    firstRow: DATA_START_ROW,
    lastRow: rowIdx - 1,
    blockedSets: blocked,
  };
}

/** Build the per-row cell payload. Only PDF-sourced fields are used — never
 * invented. The source for each visible column:
 *   Style No.   = Product Name  (po.header.productName)
 *   Description = Customs group + Product description + Type of construction
 *   Order Qty   = PO total quantity
 *   Total Qty With Packs = Order Qty × packSet (header, default 1 when blank)
 *   Unit Price  = Invoice average price
 *   Value       = Order Qty × Unit Price (written as a live formula)
 *   Time of Delivery = multi-line, one TOD per market (deduplicated)
 */
function flattenRow(r: HmTemplateRow, set: HmSetResult, header: HmWriteOptions["header"]): HmFlatCells {
  const productName = set.po?.header.productName ?? "";
  const description = r.itemDes;
  return {
    marchentContNo: header?.marchentContNo ?? "",
    date: header?.date ?? null,
    buyerCode: header?.buyerCode ?? "",
    commercialContNo: header?.commercialContNo ?? "",
    dateCommercial: header?.dateCommercial ?? null,
    orderNo: r.orderNo,
    orderQty: r.orderQty,
    styleNo: productName,            // Style No. column — product name from the PO
    fob: r.fob,
    itemDes: description,            // Description column
    cat: "",
    hts: "",
    tod: r.tod,
    country: r.country,
    remarks: header?.remarksDefault ?? "",
    merchandiserName: header?.merchandiserName ?? "",
    packSet: header?.packSet ?? "",
    withoutDiscount: "",
    discountFobDate: "",
    // Calculated-by-default; a user override will replace these on write.
    totalWithPacks: null,
    value: null,
  };
}

function applyOverrides(cells: HmFlatCells, overrides?: Partial<HmFlatCells>): HmFlatCells {
  if (!overrides) return cells;
  return { ...cells, ...overrides };
}

function writeDataRow(sheet: ExcelJS.Worksheet, rowIdx: number, c: HmFlatCells): void {
  const row = sheet.getRow(rowIdx);
  const packSetN = Number(c.packSet);
  const packs = Number.isFinite(packSetN) && packSetN > 0 ? packSetN : 1;

  row.getCell(1).value = safeStr(c.orderNo);                              // A — Order No.
  row.getCell(2).value = safeStr(c.styleNo);                              // B — Style No.
  row.getCell(3).value = safeStr(c.itemDes);                              // C — Description
  if (c.orderQty !== null && c.orderQty !== undefined) {
    row.getCell(4).value = c.orderQty;                                    // D — Order Qty
  }
  // E — Total Qty With Packs: user override wins; otherwise orderQty × packs.
  if (c.totalWithPacks !== null && c.totalWithPacks !== undefined) {
    row.getCell(5).value = c.totalWithPacks;
  } else if (c.orderQty !== null && c.orderQty !== undefined) {
    row.getCell(5).value = c.orderQty * packs;
  }
  if (c.fob !== null && c.fob !== undefined) {
    row.getCell(6).value = c.fob;                                         // F — Unit Price
    row.getCell(6).numFmt = '"USD "#,##0.00';
  }
  // G — Value: user override wins; otherwise live formula =D×F.
  if (c.value !== null && c.value !== undefined) {
    row.getCell(7).value = c.value;
    row.getCell(7).numFmt = '"USD "#,##0.00';
  } else if (c.orderQty !== null && c.orderQty !== undefined && c.fob !== null && c.fob !== undefined) {
    row.getCell(7).value = { formula: `D${rowIdx}*F${rowIdx}` };
    row.getCell(7).numFmt = '"USD "#,##0.00';
  }
  row.getCell(8).value = safeStr(c.tod);                                  // H — Time of Delivery
  row.getCell(8).alignment = { ...(row.getCell(8).alignment ?? {}), wrapText: true, vertical: "top" };

  // Match the prototype's blue bold data style and thin bottom border.
  for (let col = 1; col <= COLUMNS.length; col++) {
    const cell = row.getCell(col);
    cell.font = { bold: true, color: { argb: BLUE } };
    cell.border = { bottom: { style: "thin", color: { argb: "FF000000" } } };
    const align = COLUMNS[col - 1].alignment;
    cell.alignment = { ...(cell.alignment ?? {}), ...(align ?? {}), vertical: "top" };
  }
  row.commit();
}

/** `""` for null/undefined; refuses to persist the literal strings
 * "null"/"undefined" into a cell (template-safe per user spec). */
function safeStr(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return s === "null" || s === "undefined" ? "" : s;
}
