import ExcelJS from "exceljs";

/**
 * Per-cut-off Excel workbook writer.
 *
 * Layout matches the real sample (`Week 43 1st cut off 19.10.2026 2nd 23.10.2026.xlsx`):
 *   Row 1: title spanning all columns, orange bold text on a light background
 *          (e.g. "Week 43 — 1st cut off (19.10.2026)").
 *   Row 2: green header row — 15 columns.
 *   Row 3+: one data row per ShipmentScheduleRow.
 *
 * Pure (except that it builds a Buffer): no DB, no filesystem.
 */

export interface XlsxRow {
  buyerCode: string;
  contractNo: string;
  contractDate: string;
  orderNo: string;
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

export interface XlsxOptions {
  weekTitle: string;      // full week title (shown in a subtitle line)
  cutoffLabel: string;    // "1st cut off"
  cutoffDate: string;     // "19.10.2026" (may be blank)
}

const HEADERS = [
  "Buyer Code",
  "Cont.No.",
  "Date",
  "OrderNo.",
  "PCS",
  "STYLE",
  "FOB",
  "COMPOSITION",
  "CAT",
  "HTS",
  "Value",
  "INVOICE",
  "Country+Sub",
  "Country",
  "Mode",
] as const;

export async function buildCutoffWorkbook(rows: XlsxRow[], opts: XlsxOptions): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "AUCP";
  wb.created = new Date();
  const ws = wb.addWorksheet(safeSheetName(opts.cutoffLabel));

  // Column widths (approximate from the sample).
  const widths = [12, 20, 12, 16, 10, 24, 10, 36, 8, 8, 12, 12, 18, 10, 10];
  widths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });

  // Row 1: title.
  const titleParts: string[] = [];
  if (opts.weekTitle) titleParts.push(opts.weekTitle);
  const cutoffPiece = opts.cutoffDate ? `${opts.cutoffLabel} — ${opts.cutoffDate}` : opts.cutoffLabel;
  titleParts.push(cutoffPiece);
  const title = titleParts.join(" · ");
  ws.mergeCells(1, 1, 1, HEADERS.length);
  const titleCell = ws.getCell(1, 1);
  titleCell.value = title;
  titleCell.font = { bold: true, color: { argb: "FFD9480F" }, size: 16 };
  titleCell.alignment = { horizontal: "center", vertical: "middle" };
  titleCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF8FAFC" } };
  ws.getRow(1).height = 32;

  // Row 2: green header.
  HEADERS.forEach((h, i) => {
    const c = ws.getCell(2, i + 1);
    c.value = h;
    c.font = { bold: true, color: { argb: "FF14532D" } };
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFBBF7D0" } };
    c.alignment = { horizontal: "center", vertical: "middle" };
    c.border = {
      top: { style: "thin", color: { argb: "FF86EFAC" } },
      bottom: { style: "thin", color: { argb: "FF86EFAC" } },
      left: { style: "thin", color: { argb: "FF86EFAC" } },
      right: { style: "thin", color: { argb: "FF86EFAC" } },
    };
  });
  ws.getRow(2).height = 22;

  // Row 3+: data.
  const USD_FORMAT = "#,##0.00";
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const row = 3 + i;
    const cells: (string | number | null | { formula: string })[] = [
      r.buyerCode,
      r.contractNo,
      r.contractDate,
      r.orderNo,
      r.pcs,
      r.style,
      r.fob,
      r.composition,
      r.cat,
      r.hts,
      // Value = PCS * FOB — emit as a live formula when both are present,
      // otherwise blank; never invent a number from a missing input.
      r.pcs != null && r.fob != null ? { formula: `E${row}*G${row}` } : null,
      r.invoiceNo,
      r.marketSubCode,
      r.marketCode,
      r.transportMode,
    ];
    cells.forEach((v, c) => {
      const cell = ws.getCell(row, c + 1);
      cell.value = v as ExcelJS.CellValue;
    });
    ws.getCell(row, 7).numFmt = USD_FORMAT;  // FOB
    ws.getCell(row, 11).numFmt = USD_FORMAT; // Value
  }

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

/** Excel sheet names cannot exceed 31 chars and cannot contain : \ / ? * [ ]. */
function safeSheetName(label: string): string {
  const cleaned = label.replace(/[\\\/\?\*\[\]:]/g, "-").trim();
  const limited = cleaned.slice(0, 31) || "Sheet1";
  return limited;
}

/**
 * Build ONE workbook that contains EVERY cut-off of a week stacked on a
 * single sheet. The top title row reads e.g.
 *   "Week 27  1st cut off 29.06.2026 - 2nd cut off 03.07.2026"
 * (format fixed by the user 2026-10-28). Each cut-off's rows are then
 * printed under their own cut-off sub-title + green header, with a blank
 * spacer row in between.
 */
export interface XlsxWeekSection {
  cutoffLabel: string;      // "1st cut off"
  cutoffDate: string;       // "29.06.2026" (may be blank)
  rows: XlsxRow[];
}
export interface XlsxWeekOptions {
  weekNo: number | null;
  sections: XlsxWeekSection[];
}

export async function buildWeekWorkbook(opts: XlsxWeekOptions): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "AUCP";
  wb.created = new Date();
  const ws = wb.addWorksheet(`Week ${opts.weekNo ?? ""}`.trim().slice(0, 31) || "Week");

  const widths = [12, 20, 12, 16, 10, 24, 10, 36, 8, 8, 12, 12, 18, 10, 10];
  widths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });

  // Row 1: whole-week title.
  const parts: string[] = [];
  if (opts.weekNo != null) parts.push(`Week ${opts.weekNo}`);
  const cutoffPieces = opts.sections
    .map((s) => s.cutoffDate ? `${s.cutoffLabel} ${s.cutoffDate}` : s.cutoffLabel)
    .filter(Boolean);
  if (cutoffPieces.length) parts.push(cutoffPieces.join(" - "));
  const title = parts.join("  ");
  ws.mergeCells(1, 1, 1, HEADERS.length);
  const titleCell = ws.getCell(1, 1);
  titleCell.value = title;
  titleCell.font = { bold: true, color: { argb: "FFD9480F" }, size: 16 };
  titleCell.alignment = { horizontal: "center", vertical: "middle" };
  titleCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF8FAFC" } };
  ws.getRow(1).height = 32;

  const USD_FORMAT = "#,##0.00";
  let r = 2;
  for (const section of opts.sections) {
    // Cut-off sub-title (merged, orange text on light bg).
    const sub = section.cutoffDate
      ? `${section.cutoffLabel} — ${section.cutoffDate}`
      : section.cutoffLabel;
    ws.mergeCells(r, 1, r, HEADERS.length);
    const subCell = ws.getCell(r, 1);
    subCell.value = sub;
    subCell.font = { bold: true, color: { argb: "FFD9480F" }, size: 13 };
    subCell.alignment = { horizontal: "left", vertical: "middle" };
    subCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF7ED" } };
    ws.getRow(r).height = 24;
    r++;

    // Green header row.
    HEADERS.forEach((h, i) => {
      const c = ws.getCell(r, i + 1);
      c.value = h;
      c.font = { bold: true, color: { argb: "FF14532D" } };
      c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFBBF7D0" } };
      c.alignment = { horizontal: "center", vertical: "middle" };
      c.border = {
        top: { style: "thin", color: { argb: "FF86EFAC" } },
        bottom: { style: "thin", color: { argb: "FF86EFAC" } },
        left: { style: "thin", color: { argb: "FF86EFAC" } },
        right: { style: "thin", color: { argb: "FF86EFAC" } },
      };
    });
    ws.getRow(r).height = 22;
    r++;

    // Data rows.
    for (const row of section.rows) {
      const cells: (string | number | null | { formula: string })[] = [
        row.buyerCode,
        row.contractNo,
        row.contractDate,
        row.orderNo,
        row.pcs,
        row.style,
        row.fob,
        row.composition,
        row.cat,
        row.hts,
        row.pcs != null && row.fob != null ? { formula: `E${r}*G${r}` } : null,
        row.invoiceNo,
        row.marketSubCode,
        row.marketCode,
        row.transportMode,
      ];
      cells.forEach((v, c) => {
        const cell = ws.getCell(r, c + 1);
        cell.value = v as ExcelJS.CellValue;
      });
      ws.getCell(r, 7).numFmt = USD_FORMAT;
      ws.getCell(r, 11).numFmt = USD_FORMAT;
      r++;
    }
    // Spacer row before the next cut-off section.
    r++;
  }

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}
