/**
 * Pure validators + normalisers for row-level inline edits on a
 * ShipmentScheduleRow. Returns the typed update patch ready for Prisma, plus
 * a human-readable `errors` list. No I/O.
 *
 * Every field on the row is editable (user spec 2026-10-20). Numeric fields
 * accept blank input ("" → null) so a user can explicitly clear them.
 */

export type EditableField =
  | "buyerCode" | "contractNo" | "contractDate" | "orderNo"
  | "pcs" | "style" | "fob" | "composition" | "cat" | "hts"
  | "pdfOrderNo" | "marketCode" | "marketSubCode" | "skuItem"
  | "bookingRef" | "bcn" | "bookingStatus"
  | "portOfLoading" | "portOfDischarge" | "placeOfDelivery" | "transportMode"
  | "pdfPcs" | "grossWeightKg" | "cartons" | "measurementCbm"
  | "expectedDelivery"
  | "invoiceNo";

const EDITABLE_FIELDS: readonly EditableField[] = [
  "buyerCode", "contractNo", "contractDate", "orderNo",
  "pcs", "style", "fob", "composition", "cat", "hts",
  "pdfOrderNo", "marketCode", "marketSubCode", "skuItem",
  "bookingRef", "bcn", "bookingStatus",
  "portOfLoading", "portOfDischarge", "placeOfDelivery", "transportMode",
  "pdfPcs", "grossWeightKg", "cartons", "measurementCbm",
  "expectedDelivery",
  "invoiceNo",
] as const;

const INT_FIELDS = new Set<EditableField>(["pcs", "pdfPcs", "cartons"]);
const FLOAT_FIELDS = new Set<EditableField>(["fob", "grossWeightKg", "measurementCbm"]);

export function isEditableField(f: string): f is EditableField {
  return (EDITABLE_FIELDS as readonly string[]).includes(f);
}

export interface FieldValidation {
  ok: boolean;
  normalized: string | number | null;  // the value to store (null = cleared numeric)
  error?: string;
}

export function validateField(field: EditableField, raw: string): FieldValidation {
  const trimmed = raw.trim();

  if (INT_FIELDS.has(field)) {
    if (trimmed === "") return { ok: true, normalized: null };
    const n = Number(trimmed);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
      return { ok: false, normalized: null, error: `${field} must be a non-negative integer.` };
    }
    return { ok: true, normalized: n };
  }

  if (FLOAT_FIELDS.has(field)) {
    if (trimmed === "") return { ok: true, normalized: null };
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n < 0) {
      return { ok: false, normalized: null, error: `${field} must be a non-negative number.` };
    }
    return { ok: true, normalized: n };
  }

  // String fields — allow any value including empty (user may clear a cell).
  // Reject newlines inside booking refs / codes to keep CSV/.xlsx tidy.
  const stringField = field; // narrowed by exhaustion below
  if (
    stringField === "bcn" || stringField === "bookingRef" || stringField === "orderNo" ||
    stringField === "marketCode" || stringField === "marketSubCode" || stringField === "invoiceNo"
  ) {
    if (/[\r\n\t]/.test(trimmed)) return { ok: false, normalized: null, error: `${field} must not contain line breaks or tabs.` };
  }
  return { ok: true, normalized: trimmed };
}

/** Should we recompute `value` after this edit? (pcs or fob changed) */
export function changesLineValue(field: EditableField): boolean {
  return field === "pcs" || field === "fob";
}

/** The sample workbook keeps `Value` as a live formula PCS*FOB. We don't
 *  persist it as a column, so this helper is only used by the writer. */
export function computeValue(pcs: number | null, fob: number | null): number | null {
  if (pcs == null || fob == null) return null;
  return Math.round(pcs * fob * 100) / 100;
}
