/**
 * Booking Correction — pure interpretation of a Damco booking's Details tab.
 *
 * The live driver (`damco-live.ts`) reads raw values out of the portal DOM in a
 * `page.evaluate`; interpreting those raw values — picking the FR dynamic field,
 * rejecting label echoes and dropdown placeholders, normalising identifiers — is
 * kept here as PURE, unit-testable logic (no DOM, no I/O), per the project's
 * extraction→interpret split.
 *
 * The real DOM failure this fixes: the FR *dynamic field* was being read back as
 * the literal label "FR" (and the Manufacturer `<select>` as its "Select..."
 * placeholder), so a booking whose FR is e.g. "PLW256" compared as "PLW256 vs
 * FR" and never matched. We now only ever accept a genuine field *value*.
 */

/** One label→value pair harvested from the booking Details DOM. */
export interface DynamicField {
  label: string;
  value: string;
}

/** Raw values read from the portal (before interpretation). */
export interface RawBookingDetails {
  grossWeight: string;
  cartons: string;
  quantity: string;
  status: string;
  confirmationNumber: string;
  poNumber: string;
  sku: string;
  manufacturer: string;
  /** Every label→control-value pair found on the Details tab (for FR + fallbacks). */
  dynamicFields: DynamicField[];
}

export interface BookingDetailValues {
  grossWeight: string;
  cartons: string;
  quantity: string;
  status: string;
  confirmationNumber: string;
  poNumber: string;
  sku: string;
  frCode: string;
  manufacturer: string;
}

/**
 * Dropdown placeholders and "no value" markers that must never be treated as a
 * real field value (e.g. an unset `<select>` showing "Select..."). Matched on
 * the whole, trimmed value.
 */
const PLACEHOLDER_RE =
  /^(select(\s*(one|a\w*|\.{2,}|…))?|please\s*select|choose(\s*one)?|--+|\.{2,}|…|n\/?a|none|null|-)$/i;

/** Collapse internal whitespace and trim. */
function tidy(v: string | undefined | null): string {
  return String(v ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Accept a raw control value only when it is a genuine field value: not empty,
 * not an echo of its own label, and not a dropdown placeholder. Returns "" for
 * anything rejected (a missing value is never a match downstream).
 */
export function sanitizeFieldValue(value: string | undefined, label?: string): string {
  const v = tidy(value);
  if (!v) return "";
  if (label && v.toUpperCase() === tidy(label).toUpperCase()) return ""; // grabbed the label
  if (PLACEHOLDER_RE.test(v)) return ""; // "Select...", "--", "N/A", …
  return v;
}

/**
 * Return the sanitised value of the first dynamic field whose label matches
 * `labelPattern`. Skips fields whose value sanitises away (label echo /
 * placeholder) and keeps looking, so a stray label match never wins over a real
 * value elsewhere.
 */
export function pickDynamicFieldValue(fields: DynamicField[] | undefined, labelPattern: RegExp): string {
  for (const f of fields ?? []) {
    if (!labelPattern.test(tidy(f.label))) continue;
    const v = sanitizeFieldValue(f.value, f.label);
    if (v) return v;
  }
  return "";
}

/**
 * Extract the booking's FR dynamic-field value. The portal's label is exactly
 * "FR"; we also tolerate a trailing marker ("FR:", "FR -") and a stray suffix
 * ("FR Code") so formatting variations don't defeat the read. The returned
 * value is the field value, never the label.
 */
export function extractFrCode(fields: DynamicField[] | undefined): string {
  return (
    pickDynamicFieldValue(fields, /^FR$/i) ||
    pickDynamicFieldValue(fields, /^FR\s*(code|no\.?|number|value)?\s*[:#_-]?\s*$/i) ||
    pickDynamicFieldValue(fields, /^FR\b/i)
  );
}

/**
 * Assemble the final interpreted Details values from the raw DOM read. Totals
 * are already normalised by the browser read; identity fields are sanitised and
 * FR is picked from the dynamic fields with the browser's direct read as a
 * fallback.
 */
export function assembleBookingDetails(raw: RawBookingDetails): BookingDetailValues {
  return {
    grossWeight: tidy(raw.grossWeight),
    cartons: tidy(raw.cartons),
    quantity: tidy(raw.quantity),
    status: tidy(raw.status).toUpperCase(),
    confirmationNumber: tidy(raw.confirmationNumber),
    poNumber: sanitizeFieldValue(raw.poNumber, "PO number"),
    sku: sanitizeFieldValue(raw.sku, "SKU/Item"),
    frCode: extractFrCode(raw.dynamicFields),
    manufacturer: sanitizeFieldValue(raw.manufacturer, "Manufacturer"),
  };
}
