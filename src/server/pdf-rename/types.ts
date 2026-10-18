/**
 * PDF File Rename domain types (module 4).
 *
 * Two source document types were analyzed, each defined by an extraction CSV:
 *  - FCR (Forwarder's Cargo Receipt): "FCR Extraction" CSV, 34 fields.
 *  - Bill of Export (Shipping Bill): "Bill Of Export Data" CSV, 39 fields.
 *
 * Scanned PDFs arrive with opaque names (e.g. "1 (1).pdf") and are renamed to a
 * business key. Observed renamed outputs are the numeric invoice number
 * (e.g. "64931DE" -> "64931.pdf"). The exact canonical pattern is open (Q-PR-01),
 * so the rule is deterministic + configurable and the apply step is a preview.
 */

export type RenameDocType = "fcr" | "bill-of-export";

export interface RenameOptions {
  docType: RenameDocType;
  /** Strip trailing market/country letters from the invoice key (default true). */
  stripSuffix?: boolean;
  /** Target file extension (default "pdf"). */
  extension?: string;
}

export type RenameStatus = "planned" | "collision" | "skipped" | "needs_review";

export interface RenamePlanItem {
  docType: RenameDocType;
  originalName: string;
  targetName: string | null;
  businessKey: string | null; // raw invoice value the target derives from
  status: RenameStatus;
  reason: string;
  row: Record<string, string>;
}

export interface RenamePlan {
  docType: RenameDocType;
  items: RenamePlanItem[];
  summary: {
    total: number;
    planned: number;
    collision: number;
    skipped: number;
    needsReview: number;
  };
}

/** The source field that carries the invoice business key, per document type. */
export const INVOICE_FIELD: Record<RenameDocType, string> = {
  fcr: "Invoice Number",
  "bill-of-export": "INV",
};

/** The source field that carries the original scanned file name, per document type. */
export const FILENAME_FIELD: Record<RenameDocType, string> = {
  fcr: "File Name",
  "bill-of-export": "File",
};

/** The source field that carries the extraction success flag, per document type. */
export const SUCCESS_FIELD = "Success";
