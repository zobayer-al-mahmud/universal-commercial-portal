import type { FieldComparison, MatchResult, ExtractionResult } from "./batch-types";

/**
 * Compare the three required values extracted from the input PDF against the
 * values read back from the matched Damco booking (§9). Pure.
 *
 * Rules:
 *  - Gross Weight: numeric, compared within an explicit tolerance (kg).
 *  - Total Cartons: must match EXACTLY (integer).
 *  - Total Quantity: must match EXACTLY (integer pieces).
 *  - A missing value on either side is never a successful match.
 */

export interface BookingValues {
  grossWeight: string;
  cartons: string;
  quantity: string;
}

export interface MatchOptions {
  grossWeightToleranceKg: number;
}

function num(v: string): number | null {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : null;
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

  const anyMissing = comparisons.some((c) => c.difference === "missing value");
  const allMatch = comparisons.every((c) => c.match);

  let outcome: MatchResult["outcome"];
  if (anyMissing) {
    outcome = "NEEDS_REVIEW";
    notes.push("One or more required values is missing on the input or the booking; a missing value is never a match.");
  } else if (allMatch) {
    outcome = "MATCHED";
  } else {
    outcome = "MISMATCH";
    for (const c of comparisons) if (!c.match) notes.push(`${c.label}: ${c.difference}`);
  }

  return { outcome, comparisons, notes };
}
