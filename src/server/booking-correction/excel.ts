/**
 * Booking Correction — Excel entry point (module 5, Excel-driven workflow).
 *
 * The supplied `PackingLists.xlsx` is the authoritative input: one booking per
 * data row, already carrying every value the Damco match needs. This replaces
 * the per-PDF extraction entirely — there is nothing to "read" from a PDF on the
 * input side; the spreadsheet IS the source of truth.
 *
 * Workbook layout (header row 1, verified against the real file, 7 columns):
 *   PO Number | SKU/Item | Select Shipper | FR | Quantity | Packages/CARTON | Gross weight
 *
 * Field mapping into the existing engine:
 *   PO Number       → poNumber
 *   SKU/Item        → sku (drives the Damco `#searchSO_SKU` field with a trailing *)
 *   Select Shipper  → shipper (matched against the booking line's Manufacturer/vendor)
 *   FR              → frCode (matched against the booking's FR dynamic field)
 *   Quantity        → quantity
 *   Packages/CARTON → cartons
 *   Gross weight    → grossWeight
 *
 * This module is PURE (parse/validate/serialise); persistence lives in batch.ts.
 */

import { createHash } from "crypto";
import ExcelJS from "exceljs";
import { normalizeNumber } from "./extract";

export interface PackingRow {
  rowNo: number; // 1-based DATA row (header is sheet row 1, so data row 1 = sheet row 2)
  poNumber: string;
  sku: string;
  shipper: string;
  frCode: string;
  quantity: string; // normalised numeric string ("" when missing/invalid)
  cartons: string;
  grossWeight: string;
  valid: boolean;
  errors: string[]; // per-row validation problems (empty when valid)
}

export interface PackingParseResult {
  rows: PackingRow[]; // every non-empty data row (valid + invalid)
  headerOk: boolean; // the required columns were located
  missingColumns: string[]; // required headers not found
  sheetName: string;
}

type ColKey = "poNumber" | "sku" | "shipper" | "frCode" | "quantity" | "cartons" | "grossWeight";

/** Canonical header (lowercased, non-alphanumerics stripped) → row key. */
const HEADER_MAP: Record<string, ColKey> = {
  ponumber: "poNumber",
  po: "poNumber",
  skuitem: "sku",
  sku: "sku",
  item: "sku",
  selectshipper: "shipper",
  shipper: "shipper",
  fr: "frCode",
  frcode: "frCode",
  quantity: "quantity",
  qty: "quantity",
  packagescarton: "cartons",
  packagescartons: "cartons",
  packages: "cartons",
  cartons: "cartons",
  carton: "cartons",
  grossweight: "grossWeight",
  grossweightkg: "grossWeight",
  gw: "grossWeight",
};

const REQUIRED: ColKey[] = ["poNumber", "sku", "quantity", "cartons", "grossWeight"];

const REQUIRED_LABELS: Record<ColKey, string> = {
  poNumber: "PO Number",
  sku: "SKU/Item",
  shipper: "Select Shipper",
  frCode: "FR",
  quantity: "Quantity",
  cartons: "Packages/CARTON",
  grossWeight: "Gross weight",
};

function canon(s: unknown): string {
  return String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Flatten any exceljs cell value (richText / formula result / hyperlink) to text. */
function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") {
    const o = v as unknown as Record<string, unknown>;
    if ("richText" in o) return ((o.richText as { text: string }[]) ?? []).map((r) => r.text).join("");
    if ("result" in o) return o.result == null ? "" : String(o.result);
    if ("text" in o) return typeof o.text === "string" ? o.text : String(o.text ?? "");
    if ("hyperlink" in o && "text" in o) return String(o.text ?? "");
  }
  return String(v).trim();
}

/** Parse the packing-list workbook. Invalid rows are flagged, never dropped. */
export async function parsePackingListXlsx(buffer: Buffer): Promise<PackingParseResult> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];
  if (!ws) return { rows: [], headerOk: false, missingColumns: REQUIRED.map((k) => REQUIRED_LABELS[k]), sheetName: "" };

  // Locate columns from the header row (row 1). Map column index → key.
  const colToKey = new Map<number, ColKey>();
  const headerRow = ws.getRow(1);
  for (let c = 1; c <= ws.columnCount; c++) {
    const key = HEADER_MAP[canon(cellText(headerRow.getCell(c).value))];
    if (key && ![...colToKey.values()].includes(key)) colToKey.set(c, key);
  }

  const foundKeys = new Set(colToKey.values());
  const missingColumns = REQUIRED.filter((k) => !foundKeys.has(k)).map((k) => REQUIRED_LABELS[k]);
  const headerOk = missingColumns.length === 0;

  const rows: PackingRow[] = [];
  if (!headerOk) return { rows, headerOk, missingColumns, sheetName: ws.name };

  let dataRowNo = 0;
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const raw: Record<ColKey, string> = { poNumber: "", sku: "", shipper: "", frCode: "", quantity: "", cartons: "", grossWeight: "" };
    for (const [col, key] of colToKey) raw[key] = cellText(row.getCell(col).value).trim();

    // Skip wholly-empty rows (trailing blanks in the sheet).
    if (!Object.values(raw).some((v) => v !== "")) continue;
    dataRowNo++;

    const errors: string[] = [];
    const poNumber = raw.poNumber.trim();
    const sku = raw.sku.trim().toUpperCase();
    const shipper = raw.shipper.trim();
    const frCode = raw.frCode.trim().toUpperCase();
    const quantity = normalizeNumber(raw.quantity);
    const cartons = normalizeNumber(raw.cartons);
    const grossWeight = normalizeNumber(raw.grossWeight);

    if (!poNumber) errors.push("PO Number is required.");
    if (!sku) errors.push("SKU/Item is required.");
    if (!quantity || Number(quantity) <= 0) errors.push("Quantity must be a positive number.");
    if (!cartons || Number(cartons) <= 0) errors.push("Packages/Cartons must be a positive number.");
    if (!grossWeight || Number(grossWeight) <= 0) errors.push("Gross weight must be a positive number.");

    rows.push({ rowNo: dataRowNo, poNumber, sku, shipper, frCode, quantity, cartons, grossWeight, valid: errors.length === 0, errors });
  }

  return { rows, headerOk, missingColumns, sheetName: ws.name };
}

/** Stable content hash for de-duplicating identical rows within a batch. */
export function rowHash(r: Pick<PackingRow, "poNumber" | "sku" | "shipper" | "frCode" | "quantity" | "cartons" | "grossWeight">): string {
  const key = [r.poNumber, r.sku, r.shipper, r.frCode, r.quantity, r.cartons, r.grossWeight]
    .map((v) => String(v ?? "").trim().toUpperCase())
    .join("|");
  return createHash("sha256").update(key).digest("hex");
}

export const PACKING_HEADERS = ["PO Number", "SKU/Item", "Select Shipper", "FR", "Quantity", "Packages/CARTON", "Gross weight"] as const;

/** Serialise rows back to a workbook with the same 7-column layout (round-trip / download). */
export async function writePackingListXlsx(
  rows: Pick<PackingRow, "poNumber" | "sku" | "shipper" | "frCode" | "quantity" | "cartons" | "grossWeight">[],
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "UCP Booking Correction";
  const ws = wb.addWorksheet("PackingLists");
  const header = ws.addRow([...PACKING_HEADERS]);
  header.font = { bold: true };
  for (const r of rows) {
    ws.addRow([
      r.poNumber,
      r.sku,
      r.shipper,
      r.frCode,
      r.quantity === "" ? "" : Number(r.quantity),
      r.cartons === "" ? "" : Number(r.cartons),
      r.grossWeight === "" ? "" : Number(r.grossWeight),
    ]);
  }
  ws.columns.forEach((c) => { c.width = 18; });
  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out);
}
