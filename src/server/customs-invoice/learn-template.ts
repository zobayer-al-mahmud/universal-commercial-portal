import ExcelJS from "exceljs";
import { readFile } from "fs/promises";
import { existsSync } from "fs";
import type { InvoiceFields } from "./types";

/**
 * Per-template layout learned from the PAYMENT INVOICE sheet.
 * The 54 archived templates share one column layout — only the row number of
 * the "input row" varies (72…84 observed). The learner finds that row by
 * searching for an AGL/H&M contract reference string and returns the mapping.
 */
export interface LearnedLayout {
  sheet: string; // Always "PAYMENT INVOICE" in the archived set.
  inputRow: number;
  /** Column letter per field. Blank means the writer should skip that field. */
  columns: Record<keyof InvoiceFields, string>;
  /** Which fields had a value already on this row (confirms column meaning). */
  observed: Partial<Record<keyof InvoiceFields, string>>;
  /** Health status + any warnings for the UI. */
  warnings: string[];
}

const DEFAULT_COLUMNS: Record<keyof InvoiceFields, string> = {
  invoiceNumber: "J",
  invoiceDate: "", // Invoice date lives in the sheet header area; the input row usually only has EXP date.
  contractNo: "B",
  contractDate: "C",
  hmOrderNo: "D",
  marketCode: "K", // The country code in column K (template's own idea of market).
  marketSubCode: "", // Not in the input row.
  countryCode: "K", // Alias (same cell).
  expNo: "P",
  expDate: "Q",
  portOfLoading: "",
  portOfDischarge: "",
  placeOfDelivery: "",
  countryOfOrigin: "",
  countryOfFinalDestination: "",
  transportMode: "",
  termsOfDelivery: "",
  termsOfPayment: "",
  vesselName: "",
  voyageNo: "",
  sailingDate: "",
  currency: "",
  exporterName: "",
  buyerName: "",
  consigneeName: "",
  cargoDeliveryName: "",
  issuingBank: "",
  descriptionOfGoods: "G",
  styleNo: "E",
  buyerCode: "A",
  hsCode: "I",
  category: "H",
  quantityPcs: "M",
  unitPrice: "F",
  totalCartons: "L",
  grossWeightKg: "O",
  netWeightKg: "N",
  measurementCbm: "",
  dimension: "",
  packSet: "",
};

const CONTRACT_RE = /AGL\s*\/\s*H\s*&?\s*M\s*\/\s*\d+\s*\/\s*\d{4}/i;

/** Convert a 1-based column index to its letter (A, B, …, Z, AA, …). */
export function colLetter(c: number): string {
  let s = "";
  let n = c;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function cellText(v: ExcelJS.CellValue): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (typeof v === "object") {
    if ("richText" in v) return (v as { richText: { text: string }[] }).richText.map((t) => t.text).join("");
    if ("result" in v && typeof (v as { result: unknown }).result === "string") return String((v as { result: unknown }).result);
    if ("result" in v && typeof (v as { result: unknown }).result === "number") return String((v as { result: unknown }).result);
    if ("formula" in v) return ""; // Formula result unknown here.
  }
  return String(v);
}

/**
 * Scan a loaded workbook for the input row. Returns null when no AGL/H&M
 * reference is found (which means we fall back to UCP OVERRIDES only).
 */
export function learnLayoutFromWorkbook(wb: ExcelJS.Workbook): LearnedLayout | null {
  const ws = wb.getWorksheet("PAYMENT INVOICE");
  if (!ws) return null;

  let bestRow = -1;
  for (let r = 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    for (let c = 1; c <= Math.min(26, ws.columnCount); c++) {
      const t = cellText(row.getCell(c).value);
      if (CONTRACT_RE.test(t)) {
        bestRow = r; // Later matches override — the LAST row with a ref is the actual input row (header refs appear earlier).
        break;
      }
    }
  }
  if (bestRow === -1) return null;

  const warnings: string[] = [];
  const observed: Partial<Record<keyof InvoiceFields, string>> = {};
  const row = ws.getRow(bestRow);
  for (const [field, letter] of Object.entries(DEFAULT_COLUMNS) as [keyof InvoiceFields, string][]) {
    if (!letter) continue;
    const colIndex = letter.charCodeAt(0) - 64;
    const v = cellText(row.getCell(colIndex).value);
    if (v) observed[field] = v;
  }

  // Sanity checks: the row we picked should look like a real input row.
  if (!observed.contractNo) warnings.push("Column B does not contain a contract reference on the learned row — layout may differ.");
  if (!observed.invoiceNumber || !/^\d+$/.test(observed.invoiceNumber)) warnings.push("Column J (invoice number) is not a plain integer — verify before trusting the layout.");
  if (!observed.hmOrderNo) warnings.push("Column D (H&M order no.) is empty — this template may need manual mapping.");

  return { sheet: "PAYMENT INVOICE", inputRow: bestRow, columns: { ...DEFAULT_COLUMNS }, observed, warnings };
}

/** Load a template file and run the learner. */
export async function learnLayout(templatePath: string): Promise<LearnedLayout | null> {
  if (!templatePath || !existsSync(templatePath)) return null;
  const buf = await readFile(templatePath);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  return learnLayoutFromWorkbook(wb);
}
