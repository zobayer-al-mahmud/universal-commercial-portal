/**
 * PDF File Rename — deep invoice extraction + cross-validation (module 4).
 *
 * PURE: operates on text already pulled from a PDF (native per-page text and/or
 * per-page OCR). Never does I/O, never invents a value, never classifies a number
 * as an invoice on numeric format alone — a credible invoice LABEL must support
 * it, and PO numbers / dates / S-C / EXP / HS codes are actively excluded.
 *
 * Returns a decision (RENAME or REVIEW) with a reason code, the chosen business
 * key, every candidate it saw (value + label + page + method + confidence +
 * evidence), and the confidence — so the caller can rename reliable files and
 * route uncertain ones to manual review with actionable evidence.
 */

import { detectDocType, type RenameDocKind } from "./invoice-rules";

export type ReviewReasonCode =
  | "INVOICE_NUMBER_NOT_FOUND"
  | "MULTIPLE_INVOICE_CANDIDATES"
  | "OCR_LOW_CONFIDENCE"
  | "TEXT_OCR_CONFLICT"
  | "POSSIBLE_PO_NUMBER"
  | "DUPLICATE_INVOICE_NUMBER"
  | "PDF_UNREADABLE_OR_CORRUPTED";

export interface PageText {
  page: number; // 1-based
  text: string;
  method: "text" | "ocr";
  /** OCR mean confidence 0..1 (text pages omit it). */
  ocrConfidence?: number;
  /** Per-word OCR confidence (0..100). Lets a candidate be scored by its own
   *  words rather than the whole page's (often low) mean. OCR pages only. */
  words?: { text: string; confidence: number }[];
}

export interface Candidate {
  value: string; // business key (e.g. "64408TW" or "65341")
  numericKey: string; // leading numeric run (e.g. "64408")
  countryToken: string | null;
  label: string; // the label the value came from
  page: number;
  method: "text" | "ocr";
  confidence: number; // 0..1
  evidence: string; // short snippet around the match
  docType: RenameDocKind;
}

export interface ValidationResult {
  docType: RenameDocKind;
  invoiceNumber: string | null; // chosen business key, or null when REVIEW
  numericKey: string | null;
  countryToken: string | null;
  candidates: Candidate[];
  source: "text" | "ocr" | "both" | "none";
  method: string;
  confidence: number;
  pageRefs: number[];
  decision: "RENAME" | "REVIEW";
  reasonCode: ReviewReasonCode | null;
  reasonText: string;
}

// --- Patterns ---------------------------------------------------------------
const FCR_INV_G = /\bINV\s*NO\s*[:#]?\s*([A-Z0-9]{3,})\b/gi;
// Box-44 on the Bill of Export: <4-6 digits> <market/country token> <dd.mm.yyyy>.
// The market token may OCR as letters ("KS"/"PL") or garble to digits ("00" for a
// code the scan mangled), so it is matched as a short alphanumeric run rather than
// letter-led — the mandatory dotted date keeps the pattern specific to the invoice
// reference (EXP-no and other refs on the form use slash dates).
const BILL_INV_G = /\b(\d{4,6})\s+([A-Z0-9][A-Z0-9/\-]{1,10})\s+\d{1,2}\.\d{1,2}\.\d{4}\b/g;
// Generic invoice label elsewhere (lower trust); value may carry a letter suffix.
const GENERIC_INV_G = /\b(?:INVOICE|INV)\s*(?:NO|NUMBER|#)\s*[:#]?\s*([0-9][A-Z0-9]{2,})\b/gi;
// Commercial-invoice sheet header: the exporter's invoice page labels the invoice
// as `Number : 61753 KS`, directly under the "Invoice no and date" heading. The
// trailing market code (KS/ZA/PL) is consumed into the match so its (usually
// clean) OCR corroborates the number, but only the numeric run becomes the value.
// Gated by INV_SHEET_MARK so a stray "Number" on the customs page never fires.
const INV_SHEET_NUM_G = /\bNumber\s*[:#]?\s*([0-9]{4,6})(?:\s+[A-Z][A-Z0-9/\-]*)?/gi;
const INV_SHEET_MARK = /invoice\s+no\s+and\s+date|exporter'?s?\s+ref|H\s*&\s*M\s+order\s+no/i;
// Date tokens (dd-mm-yyyy or dd.mm.yyyy) — never an invoice value.
const DATE_RE = /^\d{1,2}[.\-/]\d{1,2}[.\-/]\d{2,4}$/;

function leadingNumeric(token: string): string {
  const m = token.match(/\d{3,}/);
  return m ? m[0] : "";
}

function snippet(text: string, idx: number, len: number): string {
  const start = Math.max(0, idx - 24);
  const end = Math.min(text.length, idx + len + 24);
  return text.slice(start, end).replace(/\s+/g, " ").trim();
}

/** True when the match sits in an ORDER NO / PO / S-C / EXP / HS context. */
function inExcludedContext(text: string, idx: number): boolean {
  const before = text.slice(Math.max(0, idx - 40), idx);
  return /\b(ORDER\s*NO|PO\s*(?:NO|NUMBER)?|S\/?C\s*NO|EXP\s*NO|HS\s*CODE|B\/?L|BOOKING)\b[^A-Za-z0-9]*$/i.test(before);
}

/**
 * Confidence of the SPECIFIC matched token(s), not the whole page. A scanned
 * customs declaration can OCR at a low page mean (dense boxes, stamps, signatures)
 * while the invoice number, its country token and its date are each read clearly.
 * Scoring the structured match by its own words — rather than the page mean —
 * stops a correctly-read invoice from being pushed to review by unrelated page
 * noise, WITHOUT lowering the decision threshold. Returns the mean per-word
 * confidence (0..1) of the words that compose the match, or null when none can be
 * mapped (the caller then falls back to the page mean).
 */
function ocrTokenConfidence(words: { text: string; confidence: number }[] | undefined, matched: string): number | null {
  if (!words || words.length === 0) return null;
  const strip = (s: string) => s.toUpperCase().replace(/^[^A-Z0-9]+|[^A-Z0-9]+$/g, "");
  const want = matched.split(/\s+/).map(strip).filter((t) => t.length >= 2);
  if (want.length === 0) return null;
  // Best (max-confidence) read of each wanted token — a token may be read twice
  // (full page + a targeted re-OCR of its line); take the stronger reading.
  const best: Array<number | undefined> = new Array(want.length).fill(undefined);
  for (const w of words) {
    const wt = strip(w.text || "");
    if (!wt) continue;
    for (let k = 0; k < want.length; k++) {
      if (want[k] !== wt) continue;
      const c = Math.max(0, Math.min(1, (w.confidence || 0) / 100));
      if (best[k] === undefined || c > (best[k] as number)) best[k] = c;
    }
  }
  const confs = best.filter((c): c is number => c !== undefined);
  if (confs.length === 0) return null;
  return confs.reduce((a, b) => a + b, 0) / confs.length;
}

function pushCandidate(
  out: Candidate[],
  p: PageText,
  value: string,
  label: string,
  baseConfidence: number,
  idx: number,
  matchLen: number,
): void {
  if (!value) return;
  if (DATE_RE.test(value)) return; // never a date
  if (inExcludedContext(p.text, idx)) return; // PO / S-C / EXP / HS — not an invoice
  const numericKey = leadingNumeric(value);
  if (!numericKey) return;
  const methodFactor =
    p.method === "ocr"
      ? ocrTokenConfidence(p.words, p.text.slice(idx, idx + matchLen)) ?? p.ocrConfidence ?? 0.85
      : 1;
  const confidence = Math.max(0, Math.min(1, baseConfidence * methodFactor));
  out.push({
    value,
    numericKey,
    countryToken: value.slice(numericKey.length) || null,
    label,
    page: p.page,
    method: p.method,
    confidence,
    evidence: snippet(p.text, idx, matchLen),
    docType: detectDocType(p.text),
  });
}

/** Collect every invoice candidate on one page (never a bare/unlabelled number). */
export function collectPageCandidates(p: PageText): Candidate[] {
  const out: Candidate[] = [];
  const t = p.text || "";
  let m: RegExpExecArray | null;

  BILL_INV_G.lastIndex = 0;
  while ((m = BILL_INV_G.exec(t))) {
    pushCandidate(out, p, m[1], "Bill box-44 <invoice> <country> <date>", 0.95, m.index, m[0].length);
  }
  FCR_INV_G.lastIndex = 0;
  while ((m = FCR_INV_G.exec(t))) {
    // Skip the "INV DT :" date field (its value is a date, filtered above).
    pushCandidate(out, p, m[1], "FCR 'INV NO :' label", 0.95, m.index, m[0].length);
  }
  GENERIC_INV_G.lastIndex = 0;
  while ((m = GENERIC_INV_G.exec(t))) {
    pushCandidate(out, p, m[1], "'Invoice No' label", 0.78, m.index, m[0].length);
  }
  if (INV_SHEET_MARK.test(t)) {
    INV_SHEET_NUM_G.lastIndex = 0;
    while ((m = INV_SHEET_NUM_G.exec(t))) {
      pushCandidate(out, p, m[1], "Invoice sheet 'Number :' label", 0.9, m.index, m[0].length);
    }
  }
  return out;
}

const norm = (v: string) => v.toUpperCase();

/**
 * Validate across all pages (native text + OCR) and decide RENAME vs REVIEW.
 * `pages` may contain both a text and an OCR rendering of the same page.
 */
export function validateInvoice(pages: PageText[], opts: { minConfidence: number }): ValidationResult {
  const docType = detectDocType(pages.map((p) => p.text).join("\n")) || "unknown";
  const all: Candidate[] = pages.flatMap(collectPageCandidates);

  const base = (reasonCode: ReviewReasonCode, reasonText: string): ValidationResult => ({
    docType, invoiceNumber: null, numericKey: null, countryToken: null,
    candidates: all, source: all.length ? (all.every((c) => c.method === "ocr") ? "ocr" : "text") : "none",
    method: "none", confidence: all[0]?.confidence ?? 0, pageRefs: [...new Set(all.map((c) => c.page))].sort((a, b) => a - b),
    decision: "REVIEW", reasonCode, reasonText,
  });

  if (all.length === 0) {
    // Nothing invoice-labelled. If the text clearly carries a PO, say so.
    const hasPo = pages.some((p) => /\b(ORDER\s*NO|PO\s*NO)\b/i.test(p.text));
    return hasPo
      ? base("POSSIBLE_PO_NUMBER", "No invoice label found; the document carries a PO/Order number — not safe to use as an invoice.")
      : base("INVOICE_NUMBER_NOT_FOUND", "No credible invoice label (INV NO / Invoice No / box-44) was found.");
  }

  // Group by business value; aggregate confidence with small boosts for repeats
  // and for text+OCR agreement on the same value.
  interface Group { value: string; numericKey: string; countryToken: string | null; methods: Set<string>; pages: Set<number>; best: Candidate; agg: number; }
  const groups = new Map<string, Group>();
  for (const c of all) {
    const k = norm(c.value);
    let g = groups.get(k);
    if (!g) { g = { value: c.value, numericKey: c.numericKey, countryToken: c.countryToken, methods: new Set(), pages: new Set(), best: c, agg: 0 }; groups.set(k, g); }
    g.methods.add(c.method);
    g.pages.add(c.page);
    if (c.confidence > g.best.confidence) g.best = c;
  }
  for (const g of groups.values()) {
    let agg = g.best.confidence;
    agg += 0.03 * Math.max(0, g.pages.size - 1); // repeated across pages
    if (g.methods.has("text") && g.methods.has("ocr")) agg += 0.05; // text+OCR agree
    g.agg = Math.min(1, agg);
  }

  const ranked = [...groups.values()].sort((a, b) => b.agg - a.agg);
  const best = ranked[0];

  // Text vs OCR conflict: the strongest text value and the strongest OCR value
  // disagree (both meaningfully confident).
  const bestText = all.filter((c) => c.method === "text").sort((a, b) => b.confidence - a.confidence)[0];
  const bestOcr = all.filter((c) => c.method === "ocr").sort((a, b) => b.confidence - a.confidence)[0];
  if (bestText && bestOcr && norm(bestText.value) !== norm(bestOcr.value) && bestText.confidence >= 0.6 && bestOcr.confidence >= 0.6) {
    const r = base("TEXT_OCR_CONFLICT", `Native text reads '${bestText.value}' but OCR reads '${bestOcr.value}'. Resolve manually.`);
    return r;
  }

  // Multiple distinct strong candidates.
  const strong = ranked.filter((g) => g.agg >= opts.minConfidence);
  if (strong.length > 1) {
    return base("MULTIPLE_INVOICE_CANDIDATES", `Multiple invoice candidates ≥ threshold: ${strong.slice(0, 4).map((g) => g.value).join(", ")}. Choose the correct one.`);
  }

  // Below threshold → review (OCR-specific reason when the best is OCR-only).
  if (best.agg < opts.minConfidence) {
    if (best.methods.has("ocr") && !best.methods.has("text")) {
      return base("OCR_LOW_CONFIDENCE", `Best candidate '${best.value}' read via OCR at ${(best.agg * 100).toFixed(0)}% (< ${(opts.minConfidence * 100).toFixed(0)}%).`);
    }
    return base("INVOICE_NUMBER_NOT_FOUND", `No candidate reached the confidence threshold (best '${best.value}' at ${(best.agg * 100).toFixed(0)}%).`);
  }

  // RENAME with the single strong candidate.
  const source: ValidationResult["source"] = best.methods.has("text") && best.methods.has("ocr") ? "both" : best.methods.has("ocr") ? "ocr" : "text";
  return {
    docType: best.best.docType !== "unknown" ? best.best.docType : docType,
    invoiceNumber: best.value,
    numericKey: best.numericKey,
    countryToken: best.countryToken,
    candidates: all,
    source,
    method: best.best.label,
    confidence: best.agg,
    pageRefs: [...best.pages].sort((a, b) => a - b),
    decision: "RENAME",
    reasonCode: null,
    reasonText: `${best.best.label} on page ${[...best.pages].sort((a, b) => a - b).join(", ")}${source === "both" ? " (text + OCR agree)" : ""}.`,
  };
}
