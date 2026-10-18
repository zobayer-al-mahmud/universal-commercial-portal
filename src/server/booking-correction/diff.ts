import {
  FIELD_LABELS,
  LOCKED_FIELDS,
  type BookingRecord,
  type CorrectionChange,
  type CorrectionResult,
} from "./types";

const EMPTY: BookingRecord = {
  orderNo: "", market: "", marketCode: "", soNumber: "", style: "", cartons: "",
  pcs: "", grossWeight: "", netWeight: "", measurement: "", containerNo: "",
  sealNo: "", vessel: "", sailingDate: "", portOfLoading: "", portOfDischarge: "",
};

const LABEL_TO_FIELD: Record<string, keyof BookingRecord> = Object.fromEntries(
  Object.entries(FIELD_LABELS).map(([field, label]) => [label.toLowerCase(), field as keyof BookingRecord]),
);

/**
 * Parse "Label: value" lines into a BookingRecord. Also accepts a packing-list
 * filename stem "<OrderNo> <market> <marketcode>" on its own line.
 */
export function parseBookingText(text: string): BookingRecord {
  const rec: BookingRecord = { ...EMPTY };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    const m = line.match(/^([A-Za-z /]+?)\s*[:=]\s*(.+)$/);
    if (m) {
      const field = LABEL_TO_FIELD[m[1].trim().toLowerCase()];
      if (field) rec[field] = m[2].trim();
      continue;
    }
    // Filename-style key line: "698757 VN VNW221"
    const fn = line.match(/^(\d{6,7})\s+([A-Z]{2})\s+([A-Z]{2,3}W\d{2,3})/);
    if (fn) {
      rec.orderNo ||= fn[1];
      rec.market ||= fn[2];
      rec.marketCode ||= fn[3];
    }
  }
  return rec;
}

/**
 * Diff a corrected booking against the original. Pure.
 *
 * - Identity fields (OrderNo/Market/MarketCode) must match; a change there is
 *   disallowed (hard) — it is a different booking, not a correction.
 * - Any other differing field is an allowed correction, pending approval.
 * - Zero changes => a pending NO_CHANGES note.
 */
export function diffBookings(original: BookingRecord, corrected: BookingRecord): CorrectionResult {
  const changes: CorrectionChange[] = [];
  const reviewReasons: CorrectionResult["reviewReasons"] = [];

  (Object.keys(FIELD_LABELS) as (keyof BookingRecord)[]).forEach((field) => {
    const oldValue = (original[field] ?? "").trim();
    const newValue = (corrected[field] ?? "").trim();
    if (oldValue === newValue) return;

    const allowed = !LOCKED_FIELDS.includes(field);
    changes.push({ field, label: FIELD_LABELS[field], oldValue, newValue, allowed });

    if (allowed) {
      reviewReasons.push({
        code: "CORRECTION_PENDING_APPROVAL",
        reason: `${FIELD_LABELS[field]}: '${oldValue || "∅"}' → '${newValue || "∅"}'`,
        severity: "pending",
      });
    } else {
      reviewReasons.push({
        code: "LOCKED_FIELD_CHANGED",
        reason: `${FIELD_LABELS[field]} is an identity field and cannot change ('${oldValue}' → '${newValue}'); this is a different booking.`,
        severity: "hard",
      });
    }
  });

  if (changes.length === 0) {
    reviewReasons.push({ code: "NO_CHANGES", reason: "Original and corrected bookings are identical.", severity: "pending" });
  }

  const disallowedCount = changes.filter((c) => !c.allowed).length;
  const allowedCount = changes.filter((c) => c.allowed).length;

  return {
    bookingKey: `${original.orderNo} ${original.market}`.trim(),
    orderNo: original.orderNo,
    market: original.market,
    marketCode: original.marketCode,
    soNumber: corrected.soNumber || original.soNumber,
    changes,
    allowedCount,
    disallowedCount,
    reviewReasons,
    outcome: disallowedCount > 0 ? "queued" : "draft",
  };
}
