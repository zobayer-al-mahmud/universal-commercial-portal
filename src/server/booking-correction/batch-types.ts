/**
 * Booking Correction — DAMCO batch workflow types (module 5).
 *
 * Pipeline (§13 of the module spec):
 *   UPLOADED → EXTRACTING → READY_TO_SEARCH → PORTAL_SEARCH → BOOKING_MATCHING
 *   → PDF_GENERATING → STATUS_VALIDATION → COMPLETED
 * with the alternative terminal/branch states below. Everything here is pure
 * data; persistence lives in `batch.ts` and I/O in the Damco adapter.
 */

export type BookingState =
  | "UPLOADED"
  | "EXTRACTING"
  | "READY_TO_SEARCH"
  | "PORTAL_SEARCH"
  | "BOOKING_MATCHING"
  | "PDF_GENERATING"
  | "STATUS_VALIDATION"
  | "COMPLETED"
  | "NEEDS_REVIEW"
  | "MISMATCH"
  | "STATUS_MISMATCH"
  | "SEARCH_FAILED"
  | "PORTAL_AUTH_REQUIRED"
  | "DOWNLOAD_FAILED"
  | "FAILED";

/** The three shipment-level totals the workflow compares, plus search keys. */
export type RequiredField = "grossWeight" | "cartons" | "quantity";

export interface ExtractedValue {
  value: string; // raw value as found
  normalized: string; // normalised numeric form ("" if none)
  label: string; // source label the value was taken from
  page: number; // 1-based page the value was found on (0 if unknown)
  confidence: number; // 0..1
}

export interface ExtractionResult {
  poNumber: string;
  countryCode: string;
  marketCode: string;
  grossWeight: ExtractedValue | null;
  cartons: ExtractedValue | null;
  quantity: ExtractedValue | null;
  /** True when every required value + PO/country is present and confident. */
  complete: boolean;
  confidence: number; // overall min confidence across required fields
  reviewReasons: ReviewReason[];
  pages: number;
  textChars: number; // length of embedded text (0 => likely scanned)
}

export interface ReviewReason {
  code: string;
  reason: string;
  severity: "hard" | "pending";
}

export interface FieldComparison {
  field: RequiredField;
  label: string;
  input: string; // normalised input value
  booking: string; // normalised booking value
  match: boolean;
  difference: string; // "" when matched, else a human-readable delta
  rule: string; // which matching rule was applied
}

export type MatchOutcome = "MATCHED" | "MISMATCH" | "NEEDS_REVIEW" | "SEARCH_FAILED";

export interface MatchResult {
  outcome: MatchOutcome;
  comparisons: FieldComparison[];
  notes: string[];
}

export type BookingStatus = "CONFIRMED" | "REQUESTED" | "UNKNOWN";

export interface StatusValidation {
  headingStatus: BookingStatus;
  fieldStatus: BookingStatus;
  finalStatus: "CONFIRMED" | "REQUESTED" | "STATUS_MISMATCH" | "NEEDS_REVIEW";
  consistent: boolean;
  message: string;
}
