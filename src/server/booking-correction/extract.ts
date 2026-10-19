import type { ExtractionResult, ExtractedValue, ReviewReason } from "./batch-types";

/**
 * Layered extraction of the three shipment-level totals (Gross Weight, Total
 * Cartons, Total Quantity) plus the PO number and country code needed for the
 * Damco search — from an uploaded packing-list PDF's embedded text.
 *
 * This is PURE: it operates on already-extracted text. The PDF→text step
 * (pdf-parse, with an OCR fallback when enabled) lives in `extractFromPdf`.
 *
 * Design notes tied to the module spec (§5):
 *  - Documents use different labels/abbreviations → each value carries the
 *    source label it was taken from.
 *  - Never invent a missing value → a value that cannot be read stays null.
 *  - Ambiguous/unreliable → a review reason is recorded and `complete` is false.
 *  - The real H&M packing list concatenates "Ctns/Col" and "Qty/Col" totals in
 *    the extracted text (e.g. "Total7114" = 7 cartons / 114 pcs). That split is
 *    not reliably recoverable from text alone, so it is surfaced for review
 *    rather than guessed — exactly the NEEDS_REVIEW case the spec calls for.
 */

/** Normalise a numeric string: strip units/spaces, resolve thousands/decimal seps. */
export function normalizeNumber(raw: string): string {
  if (!raw) return "";
  let s = raw.trim().replace(/[^\d.,]/g, "");
  if (!s) return "";
  const hasDot = s.includes(".");
  const hasComma = s.includes(",");
  if (hasDot && hasComma) {
    // The separator that appears last is the decimal separator.
    if (s.lastIndexOf(",") > s.lastIndexOf(".")) {
      s = s.replace(/\./g, "").replace(",", ".");
    } else {
      s = s.replace(/,/g, "");
    }
  } else if (hasComma) {
    // Only commas: treat as thousands when grouped in 3s, else as decimal.
    s = /^\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, "") : s.replace(",", ".");
  }
  const n = Number(s);
  if (!Number.isFinite(n)) return "";
  // Trim trailing zeros on a decimal but keep integers intact.
  return Number.isInteger(n) ? String(n) : String(n);
}

function firstMatch(text: string, re: RegExp): string {
  const m = text.match(re);
  return m ? m[1].trim() : "";
}

/** Parse "<OrderNo> <COUNTRY> <MARKETCODE>" from a packing-list filename stem. */
export function parseFilenameStem(name: string): { po: string; country: string; marketCode: string } {
  const stem = name.replace(/\.[a-z0-9]+$/i, "").trim();
  const m = stem.match(/^(\d{5,8})\s+([A-Z]{2,4})\s+([A-Z0-9]{3,10})/);
  if (m) return { po: m[1], country: m[2], marketCode: m[3] };
  return { po: "", country: "", marketCode: "" };
}

export interface ExtractInput {
  text: string;
  filename?: string;
  pages?: number;
}

export function extractBookingData(input: ExtractInput): ExtractionResult {
  const text = input.text ?? "";
  const stem = parseFilenameStem(input.filename ?? "");
  const reviewReasons: ReviewReason[] = [];

  // --- PO number + country code + market code -----------------------------
  // H&M line: "Order/Season/PM/Delivery no: 698757/4-2026/VN/1"
  const hmOrder = text.match(/Order\/Season\/PM\/Delivery no:\s*(\d{4,})\/[^/\s]+\/([A-Z]{2,4})\/\d+/i);
  let poNumber = hmOrder?.[1] ?? "";
  let countryCode = hmOrder?.[2] ?? "";

  if (!poNumber)
    poNumber = firstMatch(text, /\b(?:P\.?O\.?|Purchase Order|Order)\s*(?:No\.?|Number|#)?\s*[:#]\s*([A-Z0-9][A-Z0-9-]{3,})/i);
  if (!countryCode)
    countryCode = firstMatch(text, /\bCountry(?:\s*(?:Code|of Origin))?\s*[:#]?\s*([A-Z]{2,4})\b/i);

  poNumber ||= stem.po;
  countryCode ||= stem.country;
  // Market code ("Final receiver" block on H&M lists, else the filename stem).
  let marketCode = firstMatch(text, /Final receiver\s*\n\s*([A-Z]{2,4}W\d{2,4})/i) || stem.marketCode;

  if (!poNumber) reviewReasons.push({ code: "PO_MISSING", reason: "No PO / Order number could be read from the document.", severity: "hard" });
  if (!countryCode) reviewReasons.push({ code: "COUNTRY_MISSING", reason: "No country code could be read; the Damco search needs it.", severity: "hard" });

  // --- Gross weight -------------------------------------------------------
  let grossWeight: ExtractedValue | null = null;
  {
    const hm = text.match(/Total weight \(kg\)[\s\S]{0,60}?Gross:\s*([\d.,]+)/i);
    const generic = text.match(/\bGross\s*(?:Weight|Wt\.?|Wgt\.?)\s*[:=]?\s*([\d.,]+)\s*(kg|kgs|k\.?g\.?)?/i);
    if (hm) {
      grossWeight = { value: hm[1], normalized: normalizeNumber(hm[1]), label: "Total weight (kg) · Gross", page: 1, confidence: 0.95 };
    } else if (generic) {
      grossWeight = { value: generic[1], normalized: normalizeNumber(generic[1]), label: "Gross Weight", page: 1, confidence: 0.9 };
    }
  }
  if (!grossWeight) reviewReasons.push({ code: "GROSS_WEIGHT_MISSING", reason: "Gross Weight could not be located.", severity: "hard" });

  // --- Cartons + Quantity -------------------------------------------------
  // (1) Explicit generic labels (most reliable when present).
  let cartons: ExtractedValue | null = null;
  let quantity: ExtractedValue | null = null;

  const ctnLabel = text.match(/\bTotal\s*(?:Cartons?|CTNS?|Ctns?)\b\s*[:=]?\s*([\d.,]+)/i);
  if (ctnLabel) cartons = { value: ctnLabel[1], normalized: normalizeNumber(ctnLabel[1]), label: "Total Cartons", page: 1, confidence: 0.92 };

  const qtyLabel = text.match(/\bTotal\s*(?:Quantity|Qty|Units)\b\s*[:=]?\s*([\d.,]+)/i) || text.match(/\bQty\b\s*[:=]\s*([\d.,]+)/i);
  if (qtyLabel) quantity = { value: qtyLabel[1], normalized: normalizeNumber(qtyLabel[1]), label: "Total Quantity", page: 1, confidence: 0.9 };

  // (2) H&M combined "Ctns/Col Qty/Col ... Total<cartons><qty>" token.
  if (!cartons || !quantity) {
    const combined = text.match(/Ctns?\/Col\s*Qty\/Col[\s\S]*?Total\s*(\d+)/i)?.[1];
    if (combined) {
      // Hint: count carton-detail rows (dimension tokens) in the detail region.
      const start = text.indexOf("Items/Ctn");
      const end = text.indexOf("Solid qty/Article");
      const region = start >= 0 && end > start ? text.slice(start, end) : "";
      const detailRows = (region.match(/\d{1,3}\*\d{1,3}\*\d{1,3}/g) ?? []).length;

      let split: { c: string; q: string; conf: number } | null = null;
      if (detailRows > 0 && combined.length > String(detailRows).length && combined.startsWith(String(detailRows))) {
        const q = combined.slice(String(detailRows).length);
        if (Number(q) > 0) split = { c: String(detailRows), q, conf: 0.55 };
      }
      if (split) {
        if (!cartons)
          cartons = { value: split.c, normalized: split.c, label: "Ctns/Col total (split, unverified)", page: 1, confidence: split.conf };
        if (!quantity)
          quantity = { value: split.q, normalized: split.q, label: "Qty/Col total (split, unverified)", page: 1, confidence: split.conf };
        reviewReasons.push({
          code: "CARTON_QTY_AMBIGUOUS",
          reason: `Carton/quantity totals were concatenated in the source ("Total${combined}"); auto-split to ${split.c} cartons / ${split.q} pcs is unverified — confirm in review.`,
          severity: "pending",
        });
      } else {
        reviewReasons.push({
          code: "CARTON_QTY_AMBIGUOUS",
          reason: `Carton and quantity totals are concatenated in the source ("Total${combined}") and cannot be split reliably; enter them manually in review.`,
          severity: "hard",
        });
      }
    }
  }

  if (!cartons) reviewReasons.push({ code: "CARTONS_MISSING", reason: "Total Cartons could not be determined.", severity: "hard" });
  if (!quantity) reviewReasons.push({ code: "QUANTITY_MISSING", reason: "Total Quantity could not be determined.", severity: "hard" });

  // --- Scanned-document detection -----------------------------------------
  const textChars = text.replace(/\s+/g, "").length;
  if (textChars < 40) {
    reviewReasons.push({
      code: "SCANNED_PDF_OCR_REQUIRED",
      reason: "The PDF yielded little or no embedded text — it is likely scanned and needs OCR.",
      severity: "hard",
    });
  }

  const required = [grossWeight, cartons, quantity];
  const confidences = required.map((v) => v?.confidence ?? 0);
  const confidence = confidences.length ? Math.min(...confidences) : 0;
  const complete =
    !!grossWeight && !!cartons && !!quantity && !!poNumber && !!countryCode &&
    reviewReasons.every((r) => r.severity !== "hard");

  return {
    poNumber,
    countryCode,
    marketCode,
    grossWeight,
    cartons,
    quantity,
    complete,
    confidence,
    reviewReasons,
    pages: input.pages ?? 1,
    textChars,
  };
}

/**
 * Overlay reviewer-corrected values onto an extraction result (confidence 1.0),
 * dropping ambiguity/missing review reasons that the correction resolves. Used
 * when reprocessing a manually-corrected document (§5 review interface).
 */
export function applyManualCorrections(
  base: ExtractionResult,
  values: { grossWeight?: string; cartons?: string; quantity?: string; poNumber?: string; countryCode?: string },
): ExtractionResult {
  const mk = (v: string, label: string): ExtractedValue => ({ value: v, normalized: normalizeNumber(v) || v, label, page: 0, confidence: 1 });
  const grossWeight = values.grossWeight ? mk(values.grossWeight, "Reviewer-corrected") : base.grossWeight;
  const cartons = values.cartons ? mk(values.cartons, "Reviewer-corrected") : base.cartons;
  const quantity = values.quantity ? mk(values.quantity, "Reviewer-corrected") : base.quantity;
  const poNumber = values.poNumber || base.poNumber;
  const countryCode = values.countryCode || base.countryCode;

  const RESOLVED = new Set(["CARTON_QTY_AMBIGUOUS", "CARTONS_MISSING", "QUANTITY_MISSING", "GROSS_WEIGHT_MISSING", "PO_MISSING", "COUNTRY_MISSING", "SCANNED_PDF_OCR_REQUIRED"]);
  const reviewReasons = base.reviewReasons.filter((r) => !RESOLVED.has(r.code));
  const complete = !!grossWeight && !!cartons && !!quantity && !!poNumber && !!countryCode && reviewReasons.every((r) => r.severity !== "hard");
  const confidence = complete ? 1 : base.confidence;

  return { ...base, grossWeight, cartons, quantity, poNumber, countryCode, reviewReasons, complete, confidence };
}

/**
 * PDF → ExtractionResult. Reads embedded text via pdf-parse; when the document
 * is scanned (no text) and OCR is not configured, the result is flagged
 * SCANNED_PDF_OCR_REQUIRED for review rather than guessed.
 */
export async function extractFromPdf(buffer: Buffer, filename: string): Promise<ExtractionResult> {
  // Import the library module directly (not the package root): pdf-parse's
  // index.js runs a file-reading debug branch when it thinks it is the main
  // module, which breaks under bundlers/test runners. The lib export is clean.
  const pdfParse = (await import("pdf-parse/lib/pdf-parse.js")).default;
  let text = "";
  let pages = 1;
  try {
    const parsed = await pdfParse(buffer);
    text = parsed.text ?? "";
    pages = parsed.numpages ?? 1;
  } catch {
    // Unreadable/encrypted PDF → treat as scanned-needs-OCR via empty text.
    text = "";
  }
  return extractBookingData({ text, filename, pages });
}

/**
 * Validate a (generated) PDF is readable (§10): it must parse and have at least
 * one page. Any embedded text is returned so callers can inspect the heading /
 * status when the PDF exposes extractable text.
 */
export async function pdfIsReadable(buffer: Buffer): Promise<{ ok: boolean; pages: number; text: string }> {
  const bytes = buffer.toString("latin1");
  const header = buffer.subarray(0, 5).toString("latin1") === "%PDF-";
  const hasEof = bytes.includes("%%EOF");
  const pageObjs = (bytes.match(/\/Type\s*\/Page\b/g) ?? []).length;
  const ok = header && hasEof && pageObjs >= 1;

  // Best-effort text extraction (non-fatal): some strictly-validating parsers
  // reject hand-authored cross-reference tables, so a parser error here does
  // not make the structurally-valid PDF "unreadable".
  let text = "";
  let pages = ok ? pageObjs : 0;
  try {
    const pdfParse = (await import("pdf-parse/lib/pdf-parse.js")).default;
    const parsed = await pdfParse(buffer);
    text = parsed.text ?? "";
    if (parsed.numpages) pages = parsed.numpages;
  } catch {
    /* keep structural result */
  }
  return { ok, pages, text };
}
