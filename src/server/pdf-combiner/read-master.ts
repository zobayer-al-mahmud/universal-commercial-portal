import ExcelJS from "exceljs";
import { parseCsv } from "@/lib/csv";
import { parseMasterGrid, type MasterParseResult } from "./master";

/** Stringify an exceljs cell value (rich text, hyperlink, formula result, …). */
function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return String(v);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    if ("richText" in v && Array.isArray(v.richText)) return v.richText.map((t) => t.text).join("");
    if ("text" in v && v.text !== undefined) return cellText(v.text as ExcelJS.CellValue);
    if ("result" in v) return cellText(v.result as ExcelJS.CellValue);
  }
  return String(v);
}

/** Read the first worksheet of a master .xlsx (or a .csv) into master rows. */
export async function readMaster(fileName: string, data: Buffer): Promise<MasterParseResult> {
  if (/\.csv$/i.test(fileName)) return parseMasterGrid(parseCsv(data.toString("utf8").replace(/^﻿/, "")));
  if (!/\.xlsx$/i.test(fileName)) throw new Error("Master file must be .xlsx or .csv.");

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(data as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];
  if (!ws) throw new Error("Master workbook has no worksheet.");
  const grid: string[][] = [];
  ws.eachRow({ includeEmpty: true }, (row, rowNo) => {
    const values: string[] = [];
    for (let c = 1; c <= row.cellCount; c++) values.push(cellText(row.getCell(c).value));
    grid[rowNo - 1] = values;
  });
  for (let i = 0; i < grid.length; i++) grid[i] ??= [];
  return parseMasterGrid(grid);
}

/** A blank master template the user can download and fill in. */
export async function buildMasterTemplate(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Master");
  ws.addRow(["Output PDF Name", "File 1", "File 2", "File 3", "File 4", "File 5"]);
  ws.addRow(["45237 OB", "45237 OB Invoice.pdf", "FCR 45237.pdf", "Bill of Export 45237.pdf"]);
  ws.addRow(["45254 EN", "45254 EN Invoice", "Folder A/Sub/FCR 45254.pdf"]);
  ws.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0F5132" } };
  ws.columns.forEach((c) => (c.width = 28));
  const notes = wb.addWorksheet("How to use");
  [
    "One row = one combined PDF. Files are merged left to right.",
    "Output PDF Name (column A) is optional; blank → Row_<n>.pdf.",
    "A file name may omit .pdf. Matching is case-insensitive.",
    "Files are searched in every selected folder, including nested sub-folders.",
    "If the same file name exists in two places, qualify it: Folder A/Sub/name.pdf.",
    "A row with any missing / ambiguous / unreadable file produces NO PDF (reported instead).",
  ].forEach((t) => notes.addRow([t]));
  notes.getColumn(1).width = 100;
  return Buffer.from(await wb.xlsx.writeBuffer());
}
