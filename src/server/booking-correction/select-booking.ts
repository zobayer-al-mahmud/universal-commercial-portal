/**
 * Booking Correction — pick the correct Damco booking among several candidates.
 *
 * A PO/SKU search on Damco often returns MORE THAN ONE booking (same PO + SKU,
 * different FR / different shipment). The decisive disambiguator is the **FR**
 * dynamic field: the correct booking is the candidate whose Damco Details FR
 * equals the packing-list row's FR. This is pure (no DOM/I-O) so the selection
 * rule is unit-tested independently of the live browser driver.
 *
 * The *totals* (gross weight / cartons / quantity) still gate the final state in
 * the caller: once FR has identified the booking, a totals mismatch flags it for
 * a manual Damco correction — it never silently picks a different booking.
 */

/** Uppercase alphanumeric core of an identifier (drops spaces/punctuation). */
function core(v: string | undefined): string {
  return String(v ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** What the caller knows about one inspected candidate after reading its Details. */
export interface CandidateView {
  /** FR read from the candidate's Damco Details tab ("" when unreadable/absent). */
  frCode?: string;
  /** matchBooking outcome === "MATCHED" (all required totals + identity agree). */
  matched: boolean;
  /** No identity (PO/SKU/FR) conflict — used only on the no-FR fallback path. */
  identityOk: boolean;
}

export type BookingSelection =
  /** Exactly one booking identified. `basis` says how (FR, or totals when no FR). */
  | { kind: "selected"; index: number; basis: "fr" | "totals" }
  /** Several candidates are indistinguishable on the basis — never choose blindly. */
  | { kind: "ambiguous"; indices: number[]; basis: "fr" | "totals" }
  /** The row carried an FR but NO candidate's FR matched it. */
  | { kind: "no-fr-candidate" }
  /** No FR on the row; identity matched one candidate but a total differs. */
  | { kind: "wrong-totals"; index: number }
  /** No FR on the row and nothing matched at all. */
  | { kind: "none" };

/**
 * Choose the booking for a packing-list row.
 *
 * @param candidates inspected candidates, in portal result order.
 * @param excelFr    the packing-list row's FR ("" when the row has none).
 */
export function selectBooking(candidates: CandidateView[], excelFr: string): BookingSelection {
  const fr = core(excelFr);

  // --- FR-primary path: the row carries an FR -----------------------------
  if (fr) {
    const frMatched: number[] = [];
    for (let i = 0; i < candidates.length; i++) {
      if (core(candidates[i].frCode) === fr) frMatched.push(i);
    }
    if (frMatched.length === 1) return { kind: "selected", index: frMatched[0], basis: "fr" };
    if (frMatched.length > 1) return { kind: "ambiguous", indices: frMatched, basis: "fr" };
    return { kind: "no-fr-candidate" };
  }

  // --- No-FR fallback: totals + identity (legacy PDF path / blank FR) ------
  const full: number[] = [];
  for (let i = 0; i < candidates.length; i++) {
    if (candidates[i].matched) full.push(i);
  }
  if (full.length === 1) return { kind: "selected", index: full[0], basis: "totals" };
  if (full.length > 1) return { kind: "ambiguous", indices: full, basis: "totals" };

  const wrong = candidates.findIndex((c) => !c.matched && c.identityOk);
  if (wrong >= 0) return { kind: "wrong-totals", index: wrong };
  return { kind: "none" };
}
