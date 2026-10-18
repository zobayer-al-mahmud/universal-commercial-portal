/**
 * Sales Contract domain types. Field set mirrors the SRS PO EXTRACTION layout
 * (§C.2.1) and the per-contract / R-C destinations (§C.2.2–C.2.4).
 */

/** One raw per-market line as read from a Purchase Order PDF (pre-normalisation). */
export interface RawPoMarketRow {
  orderNo: string;
  productNo?: string;
  productName?: string;
  productDescription?: string;
  season?: string;
  customsCustomerGroup?: string;
  typeOfConstruction?: string;
  noOfPieces?: string;
  invoiceAveragePrice?: string;
  currency?: string;
  timeOfDelivery?: string;
  planningMarketA?: string;
  planningMarketB?: string;
  quantity?: string;
  termsOfDelivery?: string;
  transportBy?: string;
  dateOfOrder?: string;
}

/** Normalised per-market row written to PO EXTRACTION (§C.2.1). */
export interface NormalizedPoRow {
  orderNo: string;
  productNo: string | null;
  productName: string | null;
  productDescription: string | null;
  season: string | null;
  customsCustomerGroup: string | null;
  typeOfConstruction: string | null;
  noOfPieces: number | null;
  invoiceAveragePrice: number | null;
  currency: string | null;
  timeOfDelivery: string | null; // ISO yyyy-mm-dd
  planningMarketA: string | null;
  planningMarketB: string | null;
  quantity: number | null;
  termsOfDelivery: string | null;
  transportBy: string | null;
  dateOfOrder: string | null; // ISO yyyy-mm-dd
}

export interface FieldIssue {
  field: string;
  code: string;
  message: string;
  severity: "hard" | "pending"; // hard = block + queue; pending = draft + business decision
}

export interface ValidatedPoRow {
  row: NormalizedPoRow;
  issues: FieldIssue[];
  success: boolean; // false if any hard issue
}

/** Aggregated per-contract row (§C.2.2). */
export interface ContractRow {
  orderNo: string;
  styleNo: string;
  description: string;
  orderQty: number;
  totalQtyWithPackSet: number;
  unitPrice: number;
  value: number;
  timeOfDelivery: string;
  packSet: number;
  issues: FieldIssue[];
}

export interface OrderPackageInput {
  subject: string; // email subject (carries OrderNos)
  sender?: string;
  /** Names of attached files, used for the "three expected PDFs" rule (§B.1). */
  attachments?: string[];
  /** Optional pdftotext-style layout text of the Purchase Order PDF(s). */
  poText?: string;
  /** Active block contract, e.g. "AGL/H&M/99/2026". */
  blockContractRef?: string;
  blockDate?: string;
  revision?: number;
}

export interface PipelineResult {
  orderNumbers: string[];
  attachmentCheck: { expected: string[]; present: string[]; missing: string[]; ok: boolean };
  poRows: ValidatedPoRow[];
  contractRows: ContractRow[];
  reviewReasons: { code: string; reason: string; severity: "hard" | "pending" }[];
  outcome: "draft" | "queued"; // queued = blocked by hard failure; draft = ready for approval
}

export interface UnitPriceStrategy {
  mode: "equal-only" | "max" | "min" | "weighted-average";
}

export interface TodStrategy {
  mode: "earliest" | "latest" | "review";
}
