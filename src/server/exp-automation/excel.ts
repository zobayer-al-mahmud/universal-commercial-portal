import ExcelJS from "exceljs";
import {
  type ExpKind,
  type FieldMap,
  type ParsedExpRow,
  type ParseResult,
  fieldsForKind,
} from "./types";

/**
 * Parsers for the three operator EXP workbooks. Pure once a Buffer is in hand
 * (no DB / network). Values are preserved EXACTLY as the operator intends:
 *   - identifiers (ADSCODE, EXP Serial, EXP Year) stay strings with leading
 *     zeros intact (never coerced to a number);
 *   - amounts are cleaned of IEEE float noise (3012.7000000000003 → "3012.7")
 *     without losing real precision;
 *   - dates are rendered as `DD-MMM-YYYY` when the cell is a real date, else the
 *     operator's own text is kept verbatim (it already matches the portal).
 */

/* ----------------------------- cell helpers ----------------------------- */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function cellText(v: ExcelJS.CellValue): string {
  if (v == null) return "";
  if (v instanceof Date) return formatDate(v);
  if (typeof v === "number") return cleanNumber(v);
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "object") {
    if ("richText" in v) return (v as { richText: { text: string }[] }).richText.map((r) => r.text).join("");
    if ("text" in v) return String((v as { text: unknown }).text ?? "");
    if ("result" in v) {
      const r = (v as { result: unknown }).result;
      if (r instanceof Date) return formatDate(r);
      if (typeof r === "number") return cleanNumber(r);
      return String(r ?? "");
    }
    if ("hyperlink" in v) return String((v as { text?: unknown }).text ?? "");
  }
  return String(v);
}

/**
 * Render a JS Date as `DD-MMM-YYYY` (matches the operator's "04-Sep-2026").
 * An invalid Date (e.g. a broken workbook formula that evaluates to `#VALUE!`,
 * which ExcelJS surfaces as `new Date(NaN)`) yields "" — never the literal
 * "NaN--NaN", which would otherwise be typed into the portal and written back
 * into the exported workbook. A blank is then skipped by `skipIfBlank`.
 */
export function formatDate(d: Date): string {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return "";
  const day = String(d.getUTCDate()).padStart(2, "0");
  const mon = MONTHS[d.getUTCMonth()] ?? "";
  return `${day}-${mon}-${d.getUTCFullYear()}`;
}

/**
 * If the cell carries a Date (directly, or as a formula result) that is invalid,
 * return that Date so the caller can flag it; otherwise null. Lets the parser add
 * an honest "this date cell is broken in the workbook" note instead of silently
 * emitting a blank.
 */
function invalidDateInCell(v: ExcelJS.CellValue): boolean {
  const asDate = (x: unknown): Date | null => (x instanceof Date ? x : null);
  let d = asDate(v);
  if (!d && v && typeof v === "object" && "result" in v) d = asDate((v as { result: unknown }).result);
  return d != null && Number.isNaN(d.getTime());
}

/** Strip IEEE float artifacts while keeping genuine decimals. */
export function cleanNumber(n: number): string {
  if (!Number.isFinite(n)) return "";
  if (Number.isInteger(n)) return String(n);
  // Round to 6 significant decimals, then drop trailing zeros.
  const rounded = Math.round(n * 1e6) / 1e6;
  let s = rounded.toFixed(6);
  s = s.replace(/\.?0+$/, "");
  return s;
}

/** Canonicalise a header for matching: lowercase, strip *, punctuation, spaces. */
export function normHeader(h: string): string {
  return (h || "")
    .toLowerCase()
    .replace(/[*]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/* --------------------------- sheet selection ---------------------------- */

const SHEET_HINTS: Record<ExpKind, RegExp[]> = {
  correction: [/be\s*received/i, /correction/i],
  duplicate: [/data\s*for\s*dup/i, /dup/i],
  download: [/download/i, /ahsan/i],
};

/** Pick the data sheet for a kind; falls back to the first worksheet. */
function pickSheet(wb: ExcelJS.Workbook, kind: ExpKind): ExcelJS.Worksheet | undefined {
  const hints = SHEET_HINTS[kind];
  for (const ws of wb.worksheets) {
    if (hints.some((re) => re.test(ws.name))) return ws;
  }
  // Fallback: the sheet whose header row best matches the kind's expected columns.
  return wb.worksheets[0];
}

/** Locate the header row: the first row (within the top 15) that holds the key ids. */
function findHeaderRow(ws: ExcelJS.Worksheet, required: string[]): { rowNo: number; headers: Map<string, number> } | null {
  const wantedNorm = required.map(normHeader);
  const maxScan = Math.min(15, ws.rowCount || 15);
  for (let r = 1; r <= maxScan; r++) {
    const row = ws.getRow(r);
    const headers = new Map<string, number>();
    const span = Math.max(row.actualCellCount || 0, row.cellCount || 0, 40);
    for (let c = 1; c <= span; c++) {
      const txt = cellText(row.getCell(c).value).trim();
      if (txt) headers.set(normHeader(txt), c);
    }
    const hit = wantedNorm.filter((w) => headers.has(w)).length;
    if (hit >= Math.min(2, wantedNorm.length)) return { rowNo: r, headers };
  }
  return null;
}

/** Find a column index for any of the given header aliases. */
function colFor(headers: Map<string, number>, aliases: string[]): number | undefined {
  for (const a of aliases) {
    const c = headers.get(normHeader(a));
    if (c) return c;
  }
  return undefined;
}

/* ------------------------------ EXP No ---------------------------------- */

export interface ExpNoParts {
  adscode: string;
  expSerial: string;
  expYear: string;
  normalized: string; // AD-SERIAL-YEAR
}

/**
 * Parse an EXP No in either form:
 *   "00001558-020029-2026" (separated) or "000015580200292026" (18 digits).
 * Returns the components with their own widths preserved (AD 8, serial 6, yr 4).
 */
export function parseExpNo(raw: string): ExpNoParts | null {
  const s = (raw || "").trim();
  if (!s) return null;
  if (s.includes("-")) {
    const parts = s.split("-").map((p) => p.trim()).filter(Boolean);
    if (parts.length === 3) {
      const [adscode, expSerial, expYear] = parts;
      return { adscode, expSerial, expYear, normalized: `${adscode}-${expSerial}-${expYear}` };
    }
    return null;
  }
  const digits = s.replace(/\D/g, "");
  if (digits.length === 18) {
    const adscode = digits.slice(0, 8);
    const expSerial = digits.slice(8, 14);
    const expYear = digits.slice(14, 18);
    return { adscode, expSerial, expYear, normalized: `${adscode}-${expSerial}-${expYear}` };
  }
  return null;
}

/* ------------------------------ parsers --------------------------------- */

/** Correction + Duplicate share the same identifier columns and row shape. */
function parseFormWorkbook(ws: ExcelJS.Worksheet, kind: ExpKind): ParseResult {
  const fields = fieldsForKind(kind);
  const required = ["ADSCODE", "EXP Serial", "EXP Year"];
  const found = findHeaderRow(ws, required);
  const rows: ParsedExpRow[] = [];
  const skipped: { rowNo: number; reason: string }[] = [];
  const missingHeaders: string[] = [];

  if (!found) {
    return { kind, sheetName: ws.name, rows, skipped: [{ rowNo: 0, reason: "Could not find a header row with ADSCODE / EXP Serial / EXP Year." }], missingHeaders: required };
  }
  const { rowNo: headerRowNo, headers } = found;

  const adsCol = colFor(headers, ["ADSCODE"]);
  const serCol = colFor(headers, ["EXP Serial"]);
  const yrCol = colFor(headers, ["EXP Year"]);
  const expNoCol = colFor(headers, ["EXP_NO", "EXP No"]);
  const remarksCol = colFor(headers, ["Remarks"]);

  // Diagnostics for mapped fields that aren't present.
  for (const f of fields) if (colFor(headers, f.excelHeaders) === undefined) missingHeaders.push(f.portalLabel);

  const last = Math.max(ws.rowCount, ws.actualRowCount || 0);
  let dataNo = 0;
  for (let r = headerRowNo + 1; r <= last; r++) {
    const row = ws.getRow(r);
    const adscode = adsCol ? cellText(row.getCell(adsCol).value).trim() : "";
    const expSerial = serCol ? cellText(row.getCell(serCol).value).trim() : "";
    const expYear = yrCol ? cellText(row.getCell(yrCol).value).trim() : "";
    const expNo = expNoCol ? cellText(row.getCell(expNoCol).value).trim() : "";

    // A row with no identifiers at all = end padding / note row → skip silently.
    if (!adscode && !expSerial && !expYear && !expNo) continue;
    dataNo++;

    const notes: string[] = [];
    const values: Record<string, string> = {};
    const raw: Record<string, string> = {};
    for (const [hNorm, c] of headers) raw[hNorm] = cellText(row.getCell(c).value).trim();

    for (const f of fields) {
      const c = colFor(headers, f.excelHeaders);
      if (c === undefined) continue;
      const cellVal = row.getCell(c).value;
      const val = cellText(cellVal).trim();
      if (val) {
        values[f.key] = val;
      } else if (f.control === "date" && invalidDateInCell(cellVal)) {
        // The source cell holds a date that evaluates to an invalid value (a
        // broken workbook formula). Leave the field blank (never guess) but tell
        // the operator which column to fix.
        notes.push(`"${f.portalLabel}" has an invalid date in the workbook — left blank (fix the source cell).`);
      }
    }

    const remarks = remarksCol ? cellText(row.getCell(remarksCol).value).trim() : "";
    if (/^apply$/i.test(remarks)) notes.push('Marked "APPLY" in the workbook.');

    const invalid = !adscode || !expSerial || !expYear;
    rows.push({
      rowNo: dataNo,
      kind,
      adscode,
      expSerial,
      expYear,
      expNo,
      invoiceNo: values.invoiceNo ?? "",
      saveAs: "",
      values,
      raw,
      notes,
      invalid,
      invalidReason: invalid ? "Missing ADSCODE / EXP Serial / EXP Year (all three are required to search)." : undefined,
    });
  }

  return { kind, sheetName: ws.name, rows, skipped, missingHeaders };
}

/** Download sheet: editable cols are Save_As + EXP No (+ optional AD/Serial/Year). */
function parseDownloadWorkbook(ws: ExcelJS.Worksheet): ParseResult {
  const required = ["EXP NO"];
  const found = findHeaderRow(ws, ["EXP NO", "Save_As", "AD Code"]);
  const rows: ParsedExpRow[] = [];
  const skipped: { rowNo: number; reason: string }[] = [];

  if (!found) {
    return { kind: "download", sheetName: ws.name, rows, skipped: [{ rowNo: 0, reason: "Could not find a header row with EXP NO / Save_As." }], missingHeaders: required };
  }
  const { rowNo: headerRowNo, headers } = found;
  const saveCol = colFor(headers, ["Save_As", "Save As", "EXP Name"]);
  const expNoCol = colFor(headers, ["EXP NO", "EXP No"]);
  const adCol = colFor(headers, ["AD Code", "ADSCODE"]);
  const serCol = colFor(headers, ["EXP Serial"]);
  const yrCol = colFor(headers, ["EXP Year"]);

  const last = Math.max(ws.rowCount, ws.actualRowCount || 0);
  let dataNo = 0;
  for (let r = headerRowNo + 1; r <= last; r++) {
    const row = ws.getRow(r);
    const expNoRaw = expNoCol ? cellText(row.getCell(expNoCol).value).trim() : "";
    if (!expNoRaw) continue; // only rows with an EXP No are real data (cols A/B/C)
    dataNo++;

    const notes: string[] = [];
    let adscode = adCol ? cellText(row.getCell(adCol).value).trim() : "";
    let expSerial = serCol ? cellText(row.getCell(serCol).value).trim() : "";
    let expYear = yrCol ? cellText(row.getCell(yrCol).value).trim() : "";

    const parts = parseExpNo(expNoRaw);
    if (parts) {
      if (!adscode) { adscode = parts.adscode; notes.push("AD Code derived from EXP No."); }
      if (!expSerial) { expSerial = parts.expSerial; notes.push("EXP Serial derived from EXP No."); }
      if (!expYear) { expYear = parts.expYear; notes.push("EXP Year derived from EXP No."); }
    }

    const saveAs = (saveCol ? cellText(row.getCell(saveCol).value).trim() : "") || expSerial || parts?.normalized || `row-${dataNo}`;
    const invalid = !parts && !(adscode && expSerial && expYear);
    rows.push({
      rowNo: dataNo,
      kind: "download",
      adscode,
      expSerial,
      expYear,
      expNo: parts?.normalized || expNoRaw,
      invoiceNo: "",
      saveAs,
      values: {},
      raw: { expNo: expNoRaw, saveAs },
      notes,
      invalid,
      invalidReason: invalid ? "EXP No is not a valid 20-digit (with separators) or 18-digit value, and AD/Serial/Year are missing." : undefined,
    });
  }

  return { kind: "download", sheetName: ws.name, rows, skipped, missingHeaders: [] };
}

/** Load + parse a workbook buffer for the given workflow kind. */
export async function parseExpWorkbook(buffer: Buffer, kind: ExpKind): Promise<ParseResult> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  const ws = pickSheet(wb, kind);
  if (!ws) {
    return { kind, sheetName: "", rows: [], skipped: [{ rowNo: 0, reason: "The workbook has no worksheets." }], missingHeaders: [] };
  }
  if (kind === "download") return parseDownloadWorkbook(ws);
  return parseFormWorkbook(ws, kind);
}

/** Expose the field maps (used by preview + driver) without importing types.ts twice. */
export function kindFields(kind: ExpKind): FieldMap[] {
  return fieldsForKind(kind);
}
