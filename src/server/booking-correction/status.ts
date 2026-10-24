import type { BookingStatus, StatusValidation } from "./batch-types";

/**
 * Booking status validation (§11). The accepted booking document must carry a
 * consistent, valid CONFIRMED status in BOTH the document heading and the
 * booking status field. This is pure; it never mutates a document.
 *
 * Integrity rule: a REQUESTED (unconfirmed) booking is NEVER reported as
 * CONFIRMED. If the two locations disagree, the result is STATUS_MISMATCH and
 * the job must not be marked successful until resolved.
 */

export function normalizeStatus(raw: string): BookingStatus {
  const s = (raw ?? "").trim().toUpperCase();
  if (/\bCONFIRMED\b/.test(s) || s === "CONFIRM") return "CONFIRMED";
  if (/\bDELIVERED\b/.test(s)) return "DELIVERED";
  if (/\bREQUESTED\b/.test(s) || s === "REQUEST") return "REQUESTED";
  return "UNKNOWN";
}

export function validateStatus(headingRaw: string, fieldRaw: string): StatusValidation {
  const headingStatus = normalizeStatus(headingRaw);
  const fieldStatus = normalizeStatus(fieldRaw);
  const consistent = headingStatus === fieldStatus && headingStatus !== "UNKNOWN";

  if (consistent && headingStatus === "CONFIRMED") {
    return { headingStatus, fieldStatus, finalStatus: "CONFIRMED", consistent: true, message: "Heading and status field both read CONFIRMED." };
  }
  if (consistent && headingStatus === "DELIVERED") {
    return { headingStatus, fieldStatus, finalStatus: "DELIVERED", consistent: true, message: "Booking is DELIVERED — shipment has already been handed over. Accepted as a confirmed-and-completed booking." };
  }
  if (consistent && headingStatus === "REQUESTED") {
    return {
      headingStatus,
      fieldStatus,
      finalStatus: "REQUESTED",
      consistent: true,
      message: "Booking is REQUESTED (not yet confirmed). Authorised confirmation is required; the PDF is not accepted as confirmed.",
    };
  }
  if (headingStatus === "UNKNOWN" || fieldStatus === "UNKNOWN") {
    return {
      headingStatus,
      fieldStatus,
      finalStatus: "NEEDS_REVIEW",
      consistent: false,
      message: `Unrecognised status (heading='${headingStatus}', field='${fieldStatus}'). Verify the authoritative booking record.`,
    };
  }
  // Heading and field disagree (e.g. CONFIRMED vs REQUESTED).
  return {
    headingStatus,
    fieldStatus,
    finalStatus: "STATUS_MISMATCH",
    consistent: false,
    message: `Heading (${headingStatus}) and status field (${fieldStatus}) disagree. Not marked successful until resolved.`,
  };
}
