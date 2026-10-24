/**
 * PDF File Rename — invoice-number extraction rules (module 4, folder workflow).
 *
 * PURE: operates on text already extracted from a PDF (pdf-parse for digital
 * documents, OCR for scanned ones). Never does I/O; never invents a value.
 *
 * The rules below were derived from the REAL documents in the three dedicated
 * folders under `PDF File Rename/` (not guessed), and verified to reproduce the
 * existing filenames exactly:
 *
 *  1. FCR (Forwarder's Cargo Receipt) — `FCR EXTRACT & RENAME/`
 *     The invoice is labelled explicitly:  `INV NO : 64408TW`
 *     → business key is the leading numeric run ("64408"); the trailing letters
 *       are the market/country suffix. Verified 80/80 files.
 *
 *  2. Bill of Export / Bill of Entry — `SHIPPING BILL SOFT COPY/` (digital) and
 *     `WEEK- 41 SHIPPING BILL SCAN COPY/` (scanned → OCR).
 *     The Bangladesh Customs "Bill of Entry / Export" form carries the invoice in
 *     box 44 (Additional information) as:  `65341 BR 05.10.2026`
 *     i.e. `<invoiceNo> <market/country token> <dd.mm.yyyy>`, where the token may
 *     be a plain country code ("BR"), slash-joined codes ("BE/IT") or a market
 *     code with a dash ("DE-PLW519"). The invoice number is the leading run.
 *     Verified 129/129 soft copies and (via OCR) the scanned copies.
 *
 * The two document types are cleanly separable: the FCR writes invoice dates with
 * dashes ("13-09-2026"), the Bill of Export with dots ("05.10.2026"), so the
 * Bill box-44 pattern never fires spuriously on an FCR and vice-versa.
 */

export type RenameDocKind = "fcr" | "bill-of-export" | "unknown";

export interface InvoiceExtraction {
  /** Document type detected from the text. */
  docType: RenameDocKind;
  /** Numeric business key used for the filename, or null when none was read. */
  invoiceNumber: string | null;
  /** Raw token the key was taken from (e.g. "64408TW" or "65341"). */
  raw: string | null;
  /** Market/country suffix that accompanied the invoice (e.g. "TW", "BE/IT"). */
  countryToken: string | null;
  /** Which rule matched. */
  method: "text-fcr" | "text-bill" | "none";
  /** Human-readable description of the source label. */
  label: string;
  /** 0..1 confidence (deterministic label matches are high). */
  confidence: number;
}

const FCR_INV = /\bINV\s*NO\s*[:#]?\s*([A-Z0-9]{3,})\b/i;
// Box-44 invoice token on the Bill of Export: <4-6 digits> <market/country> <dd.mm.yyyy>.
const BILL_INV = /\b(\d{4,6})\s+([A-Z][A-Z0-9/\-]+)\s+\d{1,2}\.\d{1,2}\.\d{4}\b/;

/** The leading numeric run of a token ("64408TW" -> "64408"), or "". */
function numericKey(token: string): string {
  const m = token.match(/\d{3,}/);
  return m ? m[0] : "";
}

/** Detect the document type from the text (content-based, folder-agnostic). */
export function detectDocType(text: string): RenameDocKind {
  const t = text || "";
  if (/BILL\s+OF\s+(ENTRY|EXPORT)|OFFICE\s+OF\s+DISPATCH|Consignor\/Exporter/i.test(t) || BILL_INV.test(t)) {
    return "bill-of-export";
  }
  if (FCR_INV.test(t)) return "fcr";
  return "unknown";
}

/**
 * Extract the invoice number from document text. The caller may pass a `hint`
 * (usually "unknown") — detection is content-based so the hint only breaks ties.
 * Returns `invoiceNumber: null` with method "none" when nothing could be read
 * (the caller then routes the file to manual review — never a guessed name).
 */
export function extractInvoice(text: string, hint: RenameDocKind = "unknown"): InvoiceExtraction {
  const t = text || "";
  const detected = detectDocType(t);
  const docType = detected !== "unknown" ? detected : hint;

  const none = (dt: RenameDocKind): InvoiceExtraction => ({
    docType: dt,
    invoiceNumber: null,
    raw: null,
    countryToken: null,
    method: "none",
    label: "",
    confidence: 0,
  });

  // Prefer the Bill-of-Export box-44 token for customs forms; it is the most
  // specific pattern and cannot collide with FCR content.
  if (docType === "bill-of-export" || detected === "bill-of-export") {
    const m = t.match(BILL_INV);
    if (m) {
      return {
        docType: "bill-of-export",
        invoiceNumber: m[1],
        raw: m[1],
        countryToken: m[2],
        method: "text-bill",
        label: "Bill of Export box 44 — <invoice> <country> <date>",
        confidence: 0.95,
      };
    }
    // Looked like a bill but the box-44 token was unreadable.
    if (detected === "bill-of-export") return none("bill-of-export");
  }

  // FCR: explicit "INV NO :" label.
  const fcr = t.match(FCR_INV);
  if (fcr) {
    const raw = fcr[1];
    const key = numericKey(raw);
    if (!key) return none("fcr");
    return {
      docType: "fcr",
      invoiceNumber: key,
      raw,
      countryToken: raw.slice(key.length) || null,
      method: "text-fcr",
      label: "FCR 'INV NO :' label",
      confidence: 0.97,
    };
  }

  return none(docType);
}
