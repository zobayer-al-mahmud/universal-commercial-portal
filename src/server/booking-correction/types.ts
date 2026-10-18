/**
 * Booking Correction domain types (module 5).
 *
 * Source: packing-list PDFs keyed "<OrderNo> <market> <marketcode>" + the Damco
 * Shipper Portal SO view. A correction compares an ORIGINAL booking against a
 * CORRECTED one (same OrderNo + market) and classifies each field change as
 * allowed-correctable or locked (locked = identity fields; changing them means it
 * is a different booking, not a correction).
 */

export interface BookingRecord {
  orderNo: string;
  market: string;
  marketCode: string;
  soNumber: string;
  style: string;
  cartons: string;
  pcs: string;
  grossWeight: string;
  netWeight: string;
  measurement: string;
  containerNo: string;
  sealNo: string;
  vessel: string;
  sailingDate: string;
  portOfLoading: string;
  portOfDischarge: string;
}

export interface CorrectionChange {
  field: keyof BookingRecord;
  label: string;
  oldValue: string;
  newValue: string;
  allowed: boolean; // false => locked/identity field changed (disallowed)
}

export interface CorrectionResult {
  bookingKey: string; // "<orderNo> <market>"
  orderNo: string;
  market: string;
  marketCode: string;
  soNumber: string;
  changes: CorrectionChange[];
  allowedCount: number;
  disallowedCount: number;
  reviewReasons: { code: string; reason: string; severity: "hard" | "pending" }[];
  outcome: "draft" | "queued";
}

// Identity/locked fields: changing any of these is NOT a correction.
export const LOCKED_FIELDS: (keyof BookingRecord)[] = ["orderNo", "market", "marketCode"];

// Human labels + the correctable field set.
export const FIELD_LABELS: Record<keyof BookingRecord, string> = {
  orderNo: "Order No",
  market: "Market",
  marketCode: "Market Code",
  soNumber: "SO Number",
  style: "Style",
  cartons: "Cartons",
  pcs: "PCS",
  grossWeight: "Gross Weight",
  netWeight: "Net Weight",
  measurement: "Measurement",
  containerNo: "Container No",
  sealNo: "Seal No",
  vessel: "Vessel",
  sailingDate: "Sailing Date",
  portOfLoading: "Port of Loading",
  portOfDischarge: "Port of Discharge",
};
