/**
 * Shipment Schedule v2 — pure types. No I/O, no Prisma.
 *
 * Workflow:
 *   1. User creates a Shipment Schedule for a week (title + weekNo).
 *   2. User defines cut-offs (default "1st cut off" + "2nd cut off" with dates).
 *   3. User uploads booking-confirmation PDFs under a chosen cut-off.
 *   4. For each PDF we parse (BCN, BRef, status, ports, qty, weight, cartons,
 *      cbm, market codes, order-no) and cross-match the OrderNo against
 *      `HmSalesContractPo` to hydrate the Sales-Contract-sourced columns
 *      (BuyerCode, Cont.No., Date, Style, FOB, Composition, PCS).
 *   5. The assembled row is persisted under the chosen cut-off.
 */

/** Decoded parts of a booking-confirmation PDF filename
 *  (pattern: "<6-digit OrderNo> <2-letter market><rest buyer sub>.pdf"). */
export interface FilenameParts {
  orderNoPrefix: string;      // "569959"
  marketCode: string;         // "AU" (first two letters of the sub-code)
  marketSubCode: string;      // "AUW118"
  ok: boolean;
  reason?: string;            // when !ok, why
}

/** Fields we try to pull from a booking-confirmation PDF's text. All optional
 *  (any field we fail to find is left blank — never invented). */
export interface BookingPdfFields {
  bcn: string;               // "61880638"
  bookingRef: string;        // "CTG4407121"
  bookingStatus: string;     // "CONFIRMED" / "REQUESTED" / ""
  portOfLoading: string;     // "Chittagong"
  portOfDischarge: string;   // "Hamburg"
  placeOfDelivery: string;   // "Hamburg"
  transportMode: string;     // "CFS/CY" | "AIR" | ""
  pdfOrderNo: string;        // "569959/3-2026"
  skuItem: string;           // "AU/5686"
  categories: string;        // "AUW118"
  pdfPcs: number | null;     // 71
  cartons: number | null;    // 3
  grossWeightKg: number | null;
  measurementCbm: number | null;
  rawTextLen: number;        // for debugging
  warnings: string[];        // non-blocking notes
}

/** Minimal shape of a HmSalesContractPo row we look up by OrderNo for matching.
 *  Taking just what we need so the matcher stays testable without Prisma. */
export interface SalesContractLookup {
  contract: {
    marchentContNo: string;
    contractDate: string;
    buyerCode: string;
    commercialContNo: string;
    commercialDate: string;
  };
  orderNo: string;         // "734928-8404"
  state: string;           // "READY" | "UPLOADED" | ...
  rowsJson: string;        // HmTemplateRow[] JSON
}

/** Shape of what we pull from a matched sales-contract row. */
export interface SalesContractHydrated {
  buyerCode: string;
  contractNo: string;      // marchentContNo
  contractDate: string;
  orderNo: string;         // full orderNo (e.g. "734928-8404")
  pcs: number | null;      // orderQty from HmTemplateRow
  style: string;           // styleNo from HmTemplateRow
  fob: number | null;
  composition: string;     // itemDes
  cat: string;             // "" (unset at HmSalesContract level today)
  hts: string;             // "" (unset at HmSalesContract level today)
}

/** Result of matching one PDF's orderNoPrefix against the sales-contract POs. */
export interface MatchResult {
  matched: boolean;
  reason: string;          // "matched" | "no_sales_contract_po" | "ambiguous" | "not_ready"
  hydrated?: SalesContractHydrated;
  candidates: string[];    // full orderNo strings considered
}
