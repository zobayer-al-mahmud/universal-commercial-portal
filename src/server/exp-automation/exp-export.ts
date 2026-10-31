import ExcelJS from "exceljs";
import { type ExpKind, fieldsForKind } from "./types";

/**
 * Rebuild an .xlsx from a job's CURRENT (possibly edited) rows. The original
 * uploaded workbook is preserved immutably on disk; this is the "download the
 * edited version" path, so per-row edits made in the UI are reflected without
 * ever touching the original. Columns come from the kind's field map + the shared
 * identifier columns, so the export mirrors the operator's own template shape.
 */

export interface ExportRow {
  rowNo: number;
  adscode: string;
  expSerial: string;
  expYear: string;
  expNo: string;
  saveAs: string;
  values: Record<string, string>;
}

const SHEET_NAME: Record<ExpKind, string> = {
  correction: "BE Received (Y N)",
  duplicate: "DATA FOR DUP.",
  download: "EXP DOWNLOAD",
};

export async function buildEditedWorkbook(kind: ExpKind, rows: ExportRow[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "AUCP EXP Automation";
  const ws = wb.addWorksheet(SHEET_NAME[kind]);

  if (kind === "download") {
    ws.addRow(["SL.No", "Save_As", "EXP NO", "AD Code", "EXP Serial", "EXP Year"]);
    rows.forEach((r) => ws.addRow([r.rowNo, r.saveAs, r.expNo, r.adscode, r.expSerial, r.expYear]));
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  const fields = fieldsForKind(kind);
  const hasExpNo = rows.some((r) => r.expNo);
  const idHeaders = ["SL.No", ...(hasExpNo ? ["EXP_NO"] : []), "ADSCODE", "EXP Serial", "EXP Year"];
  const fieldHeaders = fields.map((f) => f.excelHeaders[0] ?? f.portalLabel);
  ws.addRow([...idHeaders, ...fieldHeaders]);

  rows.forEach((r) => {
    const idCells: (string | number)[] = [r.rowNo, ...(hasExpNo ? [r.expNo] : []), r.adscode, r.expSerial, r.expYear];
    const fieldCells = fields.map((f) => r.values[f.key] ?? "");
    ws.addRow([...idCells, ...fieldCells]);
  });

  return Buffer.from(await wb.xlsx.writeBuffer());
}
