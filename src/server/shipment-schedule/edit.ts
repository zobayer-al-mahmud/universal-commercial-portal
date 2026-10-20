/**
 * Week-Wise Shipment Schedule — in-portal editing rules (§4.2 of the Oct-2026
 * "Module Enhancements" SRS addendum).
 *
 * Pure, deterministic field-level validation. No DB, no network. The action
 * layer applies the result and records an append-only edit history (original
 * value, edited value, editor, timestamp, change reason). Identity fields are
 * locked so a correction can never silently re-key a line (§4.1/§4.2).
 */

/** Fields an authorised user may correct in-portal. */
export const EDITABLE_FIELDS = [
  "style",
  "composition",
  "incoterm",
  "transport",
  "pcs",
  "fob",
  "marketCode",
  "invoiceNo",
  "cutOff",
  "firstCutOff",
  "secondCutOff",
] as const;

export type EditableField = (typeof EDITABLE_FIELDS)[number];

/** Identity / key fields that must never be edited (locked). */
export const LOCKED_FIELDS = ["orderNo", "weekNo", "buyerCode", "contractNo"];

export function isEditableField(field: string): field is EditableField {
  return (EDITABLE_FIELDS as readonly string[]).includes(field);
}

const DATE_RE = /^\d{2}\.\d{2}\.\d{4}$/; // DD.MM.YYYY, matching the week workbook

export interface EditValidation {
  ok: boolean;
  /** Normalised value to store (string form; numeric fields stay numeric-castable). */
  normalized: string;
  error?: string;
}

/**
 * Validate a single field edit. Returns the normalised value to persist, or an
 * error explaining why the edit is rejected. Mandatory fields may not be blanked.
 */
export function validateScheduleEdit(field: string, rawValue: string): EditValidation {
  if (LOCKED_FIELDS.includes(field)) {
    return { ok: false, normalized: "", error: `${field} is a locked identity field and cannot be edited.` };
  }
  if (!isEditableField(field)) {
    return { ok: false, normalized: "", error: `${field} is not an editable schedule field.` };
  }

  const value = rawValue.trim();

  switch (field) {
    case "pcs": {
      const n = Number(value.replace(/,/g, ""));
      if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
        return { ok: false, normalized: "", error: "PCS must be a whole number greater than 0." };
      }
      return { ok: true, normalized: String(n) };
    }
    case "fob": {
      const n = Number(value.replace(/,/g, ""));
      if (!Number.isFinite(n) || n < 0) {
        return { ok: false, normalized: "", error: "FOB must be a number of 0 or more." };
      }
      return { ok: true, normalized: String(n) };
    }
    case "cutOff": {
      const v = value.toLowerCase().replace(/\s+/g, "");
      if (v !== "1st" && v !== "2nd") {
        return { ok: false, normalized: "", error: 'Cut-off must be "1st" or "2nd".' };
      }
      return { ok: true, normalized: v };
    }
    case "firstCutOff":
    case "secondCutOff": {
      if (!DATE_RE.test(value)) {
        return { ok: false, normalized: "", error: "Cut-off date must be in DD.MM.YYYY format." };
      }
      return { ok: true, normalized: value };
    }
    case "marketCode": {
      if (!value) return { ok: false, normalized: "", error: "Market code is mandatory." };
      return { ok: true, normalized: value.toUpperCase() };
    }
    case "style": {
      if (!value) return { ok: false, normalized: "", error: "Style is mandatory." };
      return { ok: true, normalized: value };
    }
    default:
      // composition, incoterm, transport, invoiceNo — free text, may be blank.
      return { ok: true, normalized: value };
  }
}

/** Recompute line value (PCS × FOB) after a quantity/price edit. */
export function recomputeLineValue(pcs: number, fob: number): number {
  return Math.round(pcs * fob * 100) / 100;
}
