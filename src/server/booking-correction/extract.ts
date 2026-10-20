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

/** Longest common trailing-digit run of two numeric strings. */
function commonNumericSuffix(a: string, b: string): string {
  let i = a.length - 1, j = b.length - 1, n = 0;
  while (i >= 0 && j >= 0 && a[i] === b[j]) { i--; j--; n++; }
  return n ? b.slice(b.length - n) : "";
}

export interface CtnsQtyTable {
  cartons: string;
  quantity: string;
  totalNum: string;
  confidence: number;
}

/**
 * Parse the H&M "Ctns/Col | Qty/Col" summary table from the flattened PDF text.
 * Layout (one article shown):
 *
 *   Ctns/Col  Qty/Col
 *   Solid Asst
 *   <artno><solidCtns><qty>     e.g. "001015151" (art 00101, solid 5, qty 151)
 *   Mixed<asstCtns> Pcs incl. in totals
 *   Total<cartons><qty>         e.g. "Total6151"  (6 cartons, 151 pcs)
 *
 * The total row's carton figure is Total Cartons (Solid + Asst); the Qty/Col
 * total is Total Quantity. Because the total row concatenates both numbers, the
 * quantity is recovered as the numeric suffix the total row shares with the
 * article row (which ends in the same quantity). Returns null if not found or
 * the split is implausible.
 */
export function parseCtnsQtyTable(text: string): CtnsQtyTable | null {
  const block = text.match(/Ctns?\/Col\s*Qty\/Col\s*\n\s*Solid\s*Asst([\s\S]*?)\bTotal\s*(\d+)/i);
  if (!block) return null;
  const totalNum = block[2];
  if (totalNum.length < 2) {
    // A lone total number with no carton/qty concatenation is ambiguous.
    return null;
  }
  // The article row is the first all-digit line between "SolidAsst" and "Total".
  const rows = block[1].split(/\r?\n/).map((l) => l.trim());
  const articleNum = rows.find((l) => /^\d{4,}$/.test(l)) ?? "";

  let qty = commonNumericSuffix(articleNum, totalNum);
  // Guard against an article number whose own digits over-extend the suffix:
  // cartons must keep at least one digit and be no larger than the quantity.
  while (qty && (qty.length >= totalNum.length || Number(totalNum.slice(0, totalNum.length - qty.length)) > Number(qty))) {
    qty = qty.slice(1);
  }
  if (!qty) return null;
  const cartons = totalNum.slice(0, totalNum.length - qty.length);
  if (!cartons || Number(cartons) < 1 || Number(qty) < 1) return null;

  // High confidence when the article row corroborates the quantity suffix.
  const corroborated = articleNum.endsWith(qty);
  return { cartons: String(Number(cartons)), quantity: String(Number(qty)), totalNum, confidence: corroborated ? 0.9 : 0.6 };
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

  // (2) H&M "Ctns/Col | Qty/Col" summary table. The total row concatenates the
  // two totals in the extracted text (e.g. "Total6151" = 6 cartons / 151 pcs).
  // The Total Cartons value is the total row's carton figure (= Solid + Asst),
  // and the Total Quantity is the Qty/Col total — which equals the quantity that
  // also appears on the article row, so the split is the common numeric suffix
  // of the article-row number and the total-row number.
  if (!cartons || !quantity) {
    const table = parseCtnsQtyTable(text);
    if (table) {
      if (!cartons) cartons = { value: table.cartons, normalized: table.cartons, label: "Ctns/Col total (Solid + Asst)", page: 1, confidence: table.confidence };
      if (!quantity) quantity = { value: table.quantity, normalized: table.quantity, label: "Qty/Col total", page: 1, confidence: table.confidence };
      if (table.confidence < 0.8) {
        reviewReasons.push({
          code: "CARTON_QTY_AMBIGUOUS",
          reason: `Carton/quantity totals were concatenated in the source ("Total${table.totalNum}") and split to ${table.cartons} cartons / ${table.quantity} pcs with low confidence — confirm in review.`,
          severity: "pending",
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

// pdf-parse embeds an old pdf.js that keeps module-level state; parsing several
// documents at once in one process can corrupt it (intermittent "bad XRef
// entry"). Serialize all parse calls through a single promise chain, and retry
// once on failure, so batch concurrency never trips the parser.
let pdfParseChain: Promise<unknown> = Promise.resolve();

async function parsePdf(buffer: Buffer): Promise<{ text: string; numpages: number }> {
  // Import the library module directly (not the package root): pdf-parse's
  // index.js runs a file-reading debug branch when it thinks it is the main
  // module, which breaks under bundlers/test runners. The lib export is clean.
  const run = async () => {
    const pdfParse = (await import("pdf-parse/lib/pdf-parse.js")).default;
    try {
      const d = await pdfParse(buffer);
      return { text: d.text ?? "", numpages: d.numpages ?? 1 };
    } catch {
      // Retry once: the failure is often transient shared-state corruption.
      const d = await pdfParse(buffer);
      return { text: d.text ?? "", numpages: d.numpages ?? 1 };
    }
  };
  const result = pdfParseChain.then(run, run);
  // Keep the chain alive regardless of this call's success.
  pdfParseChain = result.then(() => undefined, () => undefined);
  return result;
}

/**
 * PDF → ExtractionResult. Reads embedded text via pdf-parse; when the document
 * is scanned (no text) and OCR is not configured, the result is flagged
 * SCANNED_PDF_OCR_REQUIRED for review rather than guessed.
 */
export async function extractFromPdf(buffer: Buffer, filename: string): Promise<ExtractionResult> {
  let text = "";
  let pages = 1;
  try {
    const parsed = await parsePdf(buffer);
    text = parsed.text;
    pages = parsed.numpages;
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
    const parsed = await parsePdf(buffer);
    text = parsed.text;
    if (parsed.numpages) pages = parsed.numpages;
  } catch {
    /* keep structural result */
  }
  return { ok, pages, text };
}
