import type { FieldComparison, MatchResult, ExtractionResult } from "./batch-types";

/**
 * Compare an Excel row (or legacy PDF extraction) against the values read back
 * from a candidate Damco booking (§9). Pure.
 *
 * Required totals (always decide MATCHED/MISMATCH/NEEDS_REVIEW):
 *  - Gross Weight: numeric, within an explicit tolerance (kg).
 *  - Total Cartons: exact integer.
 *  - Total Quantity: exact integer (pieces).
 *  - A missing value on either side is never a successful match.
 *
 * Identity / disambiguation fields (verify the right booking was picked):
 *  - PO Number, SKU/Item, Shipper (= booking line Manufacturer), FR.
 *  These are only checked when BOTH sides supply a value; a value present on both
 *  that disagrees makes the candidate a MISMATCH (so multi-candidate selection in
 *  live-run.ts never accepts the wrong booking). A field missing on the booking
 *  side is informational (cannot contradict), so the legacy PDF path is unaffected.
 */

export interface BookingValues {
  grossWeight: string;
  cartons: string;
  quantity: string;
  // Identity fields read from the booking Details tab (optional).
  poNumber?: string;
  sku?: string;
  shipper?: string; // booking line Manufacturer/vendor
  frCode?: string;
}

export interface MatchOptions {
  grossWeightToleranceKg: number;
}

function num(v: string | undefined): number | null {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** Uppercase alphanumeric core of an identifier (drops punctuation/spaces). */
function idCore(v: string | undefined): string {
  return String(v ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** PO/SKU match: the booking value often carries a suffix (e.g. PO "728045/5-2027"
 *  for Excel "728045"; SKU "OF/7656" for "OF"). Match when either core is a prefix
 *  of the other. */
function prefixMatch(a: string | undefined, b: string | undefined): boolean {
  const x = idCore(a);
  const y = idCore(b);
  if (!x || !y) return false;
  return x.startsWith(y) || y.startsWith(x);
}

/** Shipper/Manufacturer match: Excel "ABM Fashions Ltd (134715)" vs booking
 *  "ABM FASHIONS…". Strip a trailing vendor code "(123456)" and common company
 *  suffixes, then compare cores by prefix (portal often truncates the name). */
function shipperMatch(a: string | undefined, b: string | undefined): boolean {
  const norm = (v: string | undefined) =>
    String(v ?? "")
      .replace(/\(\s*\d{3,}\s*\)/g, " ") // drop "(134715)" vendor code
      .toUpperCase()
      .replace(/\b(LTD|LIMITED|LTD\.|CO|COMPANY|INC|THE|AND|&)\b/g, " ")
      .replace(/[^A-Z0-9]/g, "");
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  return x.startsWith(y) || y.startsWith(x);
}

export function matchBooking(
  extraction: ExtractionResult,
  booking: BookingValues,
  opts: MatchOptions,
): MatchResult {
  const notes: string[] = [];
  const comparisons: FieldComparison[] = [];

  const inGross = extraction.grossWeight?.normalized ?? "";
  const inCtn = extraction.cartons?.normalized ?? "";
  const inQty = extraction.quantity?.normalized ?? "";

  // --- Required totals ----------------------------------------------------
  // Gross weight (tolerance).
  {
    const a = num(inGross);
    const b = num(booking.grossWeight);
    let match = false;
    let difference = "";
    if (a == null || b == null) {
      difference = "missing value";
    } else {
      const delta = Math.abs(a - b);
      match = delta <= opts.grossWeightToleranceKg;
      difference = match ? "" : `Δ ${delta.toFixed(2)} kg (tolerance ${opts.grossWeightToleranceKg} kg)`;
    }
    comparisons.push({ field: "grossWeight", label: "Gross Weight", input: inGross, booking: booking.grossWeight, match, difference, rule: `±${opts.grossWeightToleranceKg} kg tolerance` });
  }

  // Cartons (exact integer).
  {
    const a = num(inCtn);
    const b = num(booking.cartons);
    let match = false;
    let difference = "";
    if (a == null || b == null) difference = "missing value";
    else {
      match = a === b;
      difference = match ? "" : `${a} vs ${b}`;
    }
    comparisons.push({ field: "cartons", label: "Total Cartons", input: inCtn, booking: booking.cartons, match, difference, rule: "exact" });
  }

  // Quantity (exact integer).
  {
    const a = num(inQty);
    const b = num(booking.quantity);
    let match = false;
    let difference = "";
    if (a == null || b == null) difference = "missing value";
    else {
      match = a === b;
      difference = match ? "" : `${a} vs ${b}`;
    }
    comparisons.push({ field: "quantity", label: "Total Quantity", input: inQty, booking: booking.quantity, match, difference, rule: "exact" });
  }

  const requiredComparisons = [...comparisons];
  const anyMissing = requiredComparisons.some((c) => c.difference === "missing value");
  const requiredAllMatch = requiredComparisons.every((c) => c.match);

  // --- Identity / disambiguation fields -----------------------------------
  // Only verified when BOTH sides provide a value; otherwise informational
  // (match=true so they never block the legacy PDF path). A present-on-both
  // disagreement means the wrong booking was picked → not a MATCHED candidate.
  let identityConflict = false;
  const addIdentity = (field: FieldComparison["field"], label: string, input: string, bk: string, ok: boolean, rule: string) => {
    const bothPresent = idCore(input) !== "" && idCore(bk) !== "";
    const match = bothPresent ? ok : true;
    if (bothPresent && !ok) identityConflict = true;
    comparisons.push({ field, label, input, booking: bk, match, difference: bothPresent ? (ok ? "" : `${input} vs ${bk}`) : "not verified", rule });
  };
  addIdentity("poNumber", "PO Number", extraction.poNumber ?? "", booking.poNumber ?? "", prefixMatch(extraction.poNumber, booking.poNumber), "prefix");
  addIdentity("sku", "SKU/Item", extraction.countryCode ?? "", booking.sku ?? "", prefixMatch(extraction.countryCode, booking.sku), "prefix");
  addIdentity("shipper", "Shipper", extraction.shipper ?? "", booking.shipper ?? "", shipperMatch(extraction.shipper, booking.shipper), "manufacturer");
  addIdentity("frCode", "FR", extraction.frCode ?? "", booking.frCode ?? "", idCore(extraction.frCode) === idCore(booking.frCode), "exact");

  let outcome: MatchResult["outcome"];
  if (anyMissing) {
    outcome = "NEEDS_REVIEW";
    notes.push("One or more required values is missing on the input or the booking; a missing value is never a match.");
  } else if (requiredAllMatch && !identityConflict) {
    outcome = "MATCHED";
  } else {
    outcome = "MISMATCH";
    for (const c of comparisons) if (!c.match) notes.push(`${c.label}: ${c.difference}`);
  }

  return { outcome, comparisons, notes };
}
