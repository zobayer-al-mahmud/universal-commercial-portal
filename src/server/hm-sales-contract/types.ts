/**
 * H&M three-PDF-set Sales Contract types.
 *
 * Covers the layout of ONE PO's three PDFs plus the per-row destination layout
 * of the `H&M` worksheet in the user's Sales Contract workbook. See
 * `docs/modules/hm-sales-contract.md` for the exact mapping and the unresolved
 * business rules this type set reflects.
 */

/** Discriminator for the three expected PDFs of a single PO. */
export type HmPdfKind = "PurchaseOrder" | "SizePerColourBreakdown" | "TotalCountryBreakdown";

/** Header block shared across all three PDFs (same label/value layout). */
export interface HmPdfHeader {
  orderNo: string;             // "643159-8756" (required, used as match key)
  ptProdNo: string | null;     // "95320"
  dateOfOrder: string | null;  // "20 Apr, 2026" — raw string, not the Excel Date
  supplierCode: string | null; // "0197" — leading zeros preserved
  supplierName: string | null; // "ANANTA GARMENTS LTD."
  optionNo: string | null;     // "SQ0174829"
  developmentNo: string | null;// "0001732C"
  productNo: string | null;    // "0803160"
  productName: string | null;  // "Slim denim"
  productDescription: string | null; // "Jeans - Garment Lower body"
  season: string | null;       // "4-2026"
  customsCustomerGroup: string | null; // "Boys"
  typeOfConstruction: string | null;   // "Woven"
}

/** One row of the PO's market table (date / markets / qty / pct). */
export interface HmPoMarketRow {
  tod: string;             // "29 Jun, 2026" (raw)
  marketCode: string;      // "OE"
  marketCodeB: string;     // "OLCEU"
  quantity: number;        // 3544 (space thousand-sep stripped)
  quantityRaw: string;     // "3 544"
  pct: number | "<1";      // 87 or "<1"
}

/** The quantity-per-article subtable in the PO (bottom of page). */
export interface HmPoArticle {
  articleNo: string;        // "051" — leading zeros preserved
  hmColourCode: string;     // "75-901"
  ptArticleNumber: string;  // "03" — leading zeros preserved
  colourName: string;       // "Denim Blue Light"
  optionNoWithVersion: string; // "SQ0174829 (V1)"
  cost: number;             // 6.15
  costCurrency: string;     // "USD"
  qtyPerArticle: number;    // 4078
}

export interface HmPoExtract {
  kind: "PurchaseOrder";
  header: HmPdfHeader;
  countryOfProduction: string | null;
  countryOfDelivery: string | null;
  countryOfOrigin: string | null;
  termsOfPayment: string | null;
  salesMode: string | null;
  noOfPieces: number | null;
  marketsHeaderList: string | null;    // "OE, OF, LH, OD"
  termsOfDeliveryText: string | null;  // free-form "Transport by Sea, Packing Mode Flat, ..."
  marketRows: HmPoMarketRow[];
  totalQty: number;        // "Total:4 078" → 4078
  totalPct: number | null; // 100
  articles: HmPoArticle[]; // typically one
  invoiceAveragePrice: number;  // 6.18
  invoiceCurrency: string;      // "USD"
  invoiceCountries: string | null; // "OE, OF, LH, OD"
}

/** Per-market page of the Size/Colour Breakdown. */
export interface HmSizeBreakdownPage {
  marketHeading: string;   // "Netherlands/Poland (Online H&M Europe) OE (OLCEU)"
  marketCode: string;      // "OE"
  marketCodeB: string;     // "OLCEU"
  articleNo: string;       // "051"
  hmColourCode: string;    // "75-901"
  colourName: string;      // "Denim Blue Light"
  description: string;     // "silver"
  ptArticleNumber: string; // "03"
  optionNo: string;        // "SQ0174829"
  variant: string | null;  // "Solid" | "Asst" | null
  /** Size label → quantity, e.g. { "134 (134)*": 284, "140 (140)*": 567, ... } */
  sizes: Record<string, number>;
  marketQuantity: number;  // 3544
}

export interface HmSizeBreakdownExtract {
  kind: "SizePerColourBreakdown";
  header: HmPdfHeader;
  pages: HmSizeBreakdownPage[];
}

/** One Country/Article cell of the Country Breakdown PDF. */
export interface HmCountryBreakdownRow {
  marketCode: string;      // "OE"
  marketCodeB: string;     // "OLCEU"
  articleQuantities: Record<string, number>; // { "051": 3544 }
  rowTotal: number;        // 3544
}

export interface HmCountryBreakdownExtract {
  kind: "TotalCountryBreakdown";
  header: HmPdfHeader;
  articles: string[];      // ["051"]
  rows: HmCountryBreakdownRow[];
  grandTotal: number;      // 4078
  articleTotals: Record<string, number>; // { "051": 4078 }
  /** Size totals across all markets, in column order. */
  sizeTotals: { article: string; hmColourCode: string; sizes: string[]; quantities: number[]; total: number }[];
}

/** The result of matching the three PDFs of one set. */
export interface HmSetMatch {
  orderNo: string | null;  // single value if all three agree, else null
  matched: boolean;        // all three agree on Order No
  mismatches: string[];    // field names that differ ("productNo", "optionNo", …)
  warnings: string[];      // free-text secondary-key mismatches
}

/** Cross-document reconciliation report (user spec §5). */
export interface HmReconciliation {
  ok: boolean;             // all deterministic checks passed
  checks: {
    name: string;          // "po_market_sum_equals_po_total"
    ok: boolean;
    expected: number;
    actual: number;
    detail?: string;
  }[];
  warnings: string[];      // non-blocking issues (e.g. missing Size page for a market)
}

/** One row of the destination `H&M` worksheet (A..U). Strings are blanks for
 * "source does not contain this field"; `null` means "formula cell / anchor only".
 * `isAnchor` says whether `G/M/R` are populated (first row per PO). */
export interface HmTemplateRow {
  isAnchor: boolean;
  orderNo: string;        // F
  /** Null on non-anchor rows — see `isAnchor`. */
  orderQty: number | null; // G
  styleNo: string;        // H
  fob: number | null;     // I (price alone; currency on extraction JSON)
  fobCurrency: string | null;
  itemDes: string;        // J
  tod: string;            // N — raw "29 Jun, 2026"
  country: string;        // O — "<TOD> <code> (<codeB>) <qty> <pct>%"
  marketCode: string;     // for traceability (not written to a cell)
  marketQuantity: number; // for traceability (encoded in O)
  pctLabel: string;       // "87%" or "<1%"
  /** Blanks (editable in UI); never auto-filled from an unrelated source. */
  blanks: {
    marchentContNo: ""; // A
    date: "";           // B
    buyerCode: "";      // C
    commercialContNo: "";// D
    dateCommercial: "";  // E
    cat: "";            // K
    hts: "";            // L
    remarks: "";        // P
    merchandiserName: "";// Q
    packSet: "";         // S
    withoutDiscount: ""; // T
    discountFobDate: ""; // U
  };
  /** Issue codes attached to this row (e.g. "QTY_MISMATCH"). */
  issues: string[];
}

/** The envelope describing one PO's three-PDF set after extraction + mapping. */
export interface HmSetResult {
  orderNo: string;
  match: HmSetMatch;
  reconciliation: HmReconciliation;
  po: HmPoExtract | null;
  size: HmSizeBreakdownExtract | null;
  country: HmCountryBreakdownExtract | null;
  rows: HmTemplateRow[];       // A..U rows to be appended
  blockWrite: boolean;         // true when match fails — no rows will be appended
  reasons: string[];           // human-readable "why" messages
}
