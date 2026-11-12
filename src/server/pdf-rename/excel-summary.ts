/**
 * PDF File Rename — Excel summary generation (module 4, feature 2).
 *
 * After a bulk rename the operator can download an Excel summary in the shape of
 * one of the THREE reference extraction workbooks supplied for this module
 * (`PO Extraction`, `Bill Of Export Data`, `FCR Extraction`). The column names and
 * order are reproduced EXACTLY from those templates (dumped from their real Sheet1
 * headers); each processed PDF becomes one row.
 *
 * Non-negotiables (CLAUDE.md / task spec):
 *  - Never fabricate. Only values the extractor actually read are written; every
 *    other template column is left blank (not a guessed value).
 *  - Each row is linked to its source PDF via the template's own file column
 *    ("File Location" / "File Name"), so a row can always be traced back.
 *  - Failed/incomplete extractions are marked clearly (Success = false).
 *
 * `buildSummaryMatrix` is PURE (header + string/number/boolean cells) so it can be
 * unit-tested without exceljs; `buildSummaryWorkbook` renders it to an .xlsx.
 */

export type SummaryReport = "po" | "bill-of-export" | "fcr";

export interface SummaryRow {
  /** Original source path / filename — the link back to the PDF. */
  file: string;
  invoiceNumber?: string | null;
  fcrNumber?: string | null;
  containerNumber?: string | null;
  expNumber?: string | null;
  /** 0..1 confidence of the value used for the rename (optional). */
  confidence?: number | null;
  /** True when the selected field was extracted (renamed), false otherwise. */
  success: boolean;
  /** Free-text status / review reason for the row. */
  message?: string | null;
}

export type Cell = string | number | boolean | null;

/** Exact header rows of the three reference templates (order preserved). */
export const REPORT_COLUMNS: Record<SummaryReport, string[]> = {
  po: [
    "Sl No", "BE No", "BE Dt", "INV No", "INV Dt", "Exp No", "Exp DT", "Branch", "LC No", "Confidence", "Success", "File Location",
  ],
  "bill-of-export": [
    "Sl No", "BE Date", "BE No", "BE Date2", "BIN", "Bank Name", "Branch", "Carrier Code", "CRF/EXP No", "Carrier Name",
    "Consignor/Exporter", "Consignee/Importer", "Country Of Destination", "Country Of Export", "Country Of Origin", "Currency",
    "Declaration", "Delivery Terms", "Description Of Goods", "Invoice Date", "EXP Date", "Gross Weight (kg)", "HS Code",
    "Invoice No", "Column2", "LC No", "Mode Of Transport Code", "Mode Of Transport Name", "Identity of transport",
    "Nationality of transport", "Place Of Loading Name", "Place Of Loading Code", "Net Weight (kg)", "Office of Dispatch/Export",
    "Package Code", "Quantity", "TIN", "Total Invoiced Value", "Total Packages", "Unit", "UP/UD", "File Name", "Success",
  ],
  fcr: [
    "Sl No", "File Name", "Working Date", "FCR No", "Port and Country of Origin", "Date of Receipt of Cargo", "Sailing Date",
    "Notify Party", "Vessel & Voyage", "Place of Receipt", "Port of Loading", "Port of Discharge", "Place of Delivery",
    "Packages", "Item", "Material", "Gross Weight", "Measurement", "Order No", "Style", "Invoice No", "Invoice Date",
    "EXP No", "EXP Date", "LC/Contact No", "LC/Contact Date", "H.S. Code", "Containers", "Trans Doc Type", "Size/Type",
    "Seal Number 1", "Seal Number 2", "Success", "Message",
  ],
};

export const REPORT_LABEL: Record<SummaryReport, string> = {
  po: "PO Extraction",
  "bill-of-export": "Bill Of Export Data",
  fcr: "FCR Extraction",
};

export function isSummaryReport(v: string): v is SummaryReport {
  return v === "po" || v === "bill-of-export" || v === "fcr";
}

const blank = "";
function num(c?: number | null): Cell {
  return typeof c === "number" && isFinite(c) ? c : blank;
}
function str(v?: string | null): Cell {
  return v == null || v === "" ? blank : String(v);
}

/**
 * Map one processed PDF to the value for a given template COLUMN. Only columns the
 * extractor can fill are populated; every other column returns "" (blank), so the
 * summary never carries an invented value. The `serial` is the 1-based row number.
 */
function cellFor(report: SummaryReport, column: string, row: SummaryRow, serial: number): Cell {
  switch (column) {
    case "Sl No":
      return serial;
    case "Success":
      return row.success;
  }
  if (report === "po") {
    switch (column) {
      case "INV No": return str(row.invoiceNumber);
      case "Exp No": return str(row.expNumber);
      case "Confidence": return num(row.confidence);
      case "File Location": return str(row.file);
    }
    return blank;
  }
  if (report === "bill-of-export") {
    switch (column) {
      case "Invoice No": return str(row.invoiceNumber);
      case "CRF/EXP No": return str(row.expNumber);
      case "File Name": return str(row.file);
    }
    return blank;
  }
  // fcr
  switch (column) {
    case "File Name": return str(row.file);
    case "FCR No": return str(row.fcrNumber);
    case "Invoice No": return str(row.invoiceNumber);
    case "EXP No": return str(row.expNumber);
    case "Containers": return str(row.containerNumber);
    case "Message": return str(row.message);
  }
  return blank;
}

/** Pure header + data matrix for a report (testable without exceljs). */
export function buildSummaryMatrix(report: SummaryReport, rows: SummaryRow[]): Cell[][] {
  const cols = REPORT_COLUMNS[report];
  const header: Cell[] = [...cols];
  const body = rows.map((row, i) => cols.map((c) => cellFor(report, c, row, i + 1)));
  return [header, ...body];
}

/** Render the summary to an .xlsx buffer (exceljs). Sheet named "Sheet1" to match
 *  the reference workbooks; the header row is bold. */
export async function buildSummaryWorkbook(report: SummaryReport, rows: SummaryRow[]): Promise<Buffer> {
  const ExcelJS = (await import("exceljs")).default ?? (await import("exceljs"));
  const wb = new ExcelJS.Workbook();
  wb.creator = "Ananta UCP — PDF File Rename";
  wb.created = new Date();
  const ws = wb.addWorksheet("Sheet1");
  const matrix = buildSummaryMatrix(report, rows);
  for (const r of matrix) ws.addRow(r);
  ws.getRow(1).font = { bold: true };
  // Reasonable default widths so the report is readable on open.
  ws.columns.forEach((col) => {
    let max = 10;
    col.eachCell?.({ includeEmpty: false }, (cell) => {
      const len = cell.value == null ? 0 : String(cell.value).length;
      if (len > max) max = len;
    });
    col.width = Math.min(60, max + 2);
  });
  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out as ArrayBuffer);
}
