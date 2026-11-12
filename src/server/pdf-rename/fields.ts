/**
 * PDF File Rename — multi-field extraction (module 4, "Rename by" options).
 *
 * PURE: operates on text already pulled from a PDF (native per-page text from
 * pdf-parse and/or per-page OCR). Never does I/O; never invents a value — a field
 * that cannot be read with a credible, LABEL- or FORMAT-anchored match returns
 * null so the caller routes the file to manual review instead of guessing.
 *
 * The patterns below were derived from the REAL documents in the three dedicated
 * folders under `4. PDF File Rename/` (verified against the actual pdf-parse text),
 * NOT from the reference extraction spreadsheets:
 *
 *   FCR (Forwarder's Cargo Receipt) — `FCR EXTRACT & RENAME/64408.pdf`:
 *     "CTG3320724"              → FCR / Receipt number (Maersk APM, "CTG" + digits)
 *     "CONTAINER NO. CSNU2397962" → container (ISO 6346: 4 letters + 7 digits)
 *     "EXP NO : 1558-21129-2026"  → EXP number (branch-serial-year, hyphenated)
 *     "INV NO : 64408TW"          → invoice (handled by validate.ts; numeric key)
 *
 *   Bill of Export / customs declaration — `SHIPPING BILL SOFT COPY/65341.pdf`:
 *     box-44 "65341 BR 05.10.2026" → invoice (handled by validate.ts). The FCR No
 *     and a clean container number are not present as readable text on the customs
 *     form, and its CRF/EXP No sits in jumbled, un-anchored text — so those fields
 *     stay null on bills rather than being guessed (fail closed).
 *
 * Each field returns value + confidence (0..1) + source (text/ocr) + a short
 * evidence snippet + the matched label, or null when nothing credible was read.
 */

import type { PageText } from "./validate";

export type FieldKind = "invoice" | "fcr" | "container" | "exp" | "custom";

export interface FieldValue {
  /** The extracted business value (e.g. "CTG3320724", "CSNU2397962"), or null. */
  value: string | null;
  /** Confidence 0..1 (label- or ISO-anchored matches are high). */
  confidence: number;
  /** Where the winning match was read from. */
  source: "text" | "ocr" | "none";
  /** Short snippet around the match, for the reviewer. */
  evidence: string;
  /** Human-readable description of the label/rule that matched. */
  label: string;
  /** Page the winning match was found on (1-based), or 0. */
  page: number;
}

export interface ExtractedFields {
  fcr: FieldValue;
  container: FieldValue;
  exp: FieldValue;
  /** Present only when a custom label was requested. */
  custom?: FieldValue;
}

const NONE = (): FieldValue => ({ value: null, confidence: 0, source: "none", evidence: "", label: "", page: 0 });

/** Scale a text-rule base confidence by the page's OCR reliability when the page
 *  was read via OCR (text pages are trusted at the base). */
function scaleForMethod(base: number, p: PageText): number {
  if (p.method === "text") return base;
  const factor = typeof p.ocrConfidence === "number" ? Math.max(0.4, Math.min(1, p.ocrConfidence)) : 0.85;
  return Math.max(0, Math.min(1, base * factor));
}

function snippet(text: string, idx: number, len: number): string {
  const start = Math.max(0, idx - 24);
  const end = Math.min(text.length, idx + len + 24);
  return text.slice(start, end).replace(/\s+/g, " ").trim();
}

/** Keep the best (highest-confidence) non-null candidate. */
function keepBest(cur: FieldValue, cand: FieldValue): FieldValue {
  if (!cand.value) return cur;
  if (!cur.value || cand.confidence > cur.confidence) return cand;
  return cur;
}

// --- FCR number -------------------------------------------------------------
// Primary: an explicit "FCR NO/RECEIPT NO :" label. Fallback: the distinctive
// "CTG" + 6-9 digit receipt token that the Maersk/APM FCR carries at the top.
const FCR_LABEL = /\b(?:FCR|RECEIPT)\s*(?:NO|NUMBER|#)?\s*[:.#]?\s*([A-Z]{2,4}\d{5,})\b/i;
const FCR_CTG = /\b(CTG\d{6,9})\b/;

function extractFcr(pages: PageText[]): FieldValue {
  let best = NONE();
  for (const p of pages) {
    const t = p.text || "";
    const lab = t.match(FCR_LABEL);
    if (lab) best = keepBest(best, { value: lab[1].toUpperCase(), confidence: scaleForMethod(0.96, p), source: p.method, evidence: snippet(t, lab.index ?? 0, lab[0].length), label: "FCR / Receipt No label", page: p.page });
    const ctg = t.match(FCR_CTG);
    if (ctg) best = keepBest(best, { value: ctg[1].toUpperCase(), confidence: scaleForMethod(0.9, p), source: p.method, evidence: snippet(t, ctg.index ?? 0, ctg[0].length), label: "FCR 'CTG…' receipt token", page: p.page });
  }
  return best;
}

// --- Container number (ISO 6346) --------------------------------------------
// 4 letters (owner code + equipment category U/J/Z) + 7 digits, e.g. CSNU2397962.
const CONTAINER_RE = /\b([A-Z]{3}[A-Z])\s?(\d{7})\b/g;
const CONTAINER_LABEL_NEAR = /CONTAINER\s*(?:NO|NUMBER|#)?\.?/i;

function extractContainer(pages: PageText[]): FieldValue {
  let best = NONE();
  for (const p of pages) {
    const t = (p.text || "").toUpperCase();
    CONTAINER_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CONTAINER_RE.exec(t))) {
      const owner = m[1];
      const value = `${owner}${m[2]}`;
      const categoryOk = /[UJZ]$/.test(owner); // 4th letter is a valid ISO category
      // A "CONTAINER" label within the preceding ~40 chars strongly corroborates.
      const labeled = CONTAINER_LABEL_NEAR.test(t.slice(Math.max(0, (m.index ?? 0) - 40), m.index ?? 0));
      const base = labeled ? 0.95 : categoryOk ? 0.85 : 0.68;
      best = keepBest(best, { value, confidence: scaleForMethod(base, p), source: p.method, evidence: snippet(t, m.index ?? 0, m[0].length), label: labeled ? "Container No label (ISO 6346)" : "ISO 6346 container token", page: p.page });
    }
  }
  return best;
}

// --- EXP number -------------------------------------------------------------
// FCR carries "EXP NO : 1558-21129-2026" (branch-serial-year). The dotted/slashed
// dates on the forms never match (hyphen-joined, 4-digit year tail). "EXP DT" is a
// date field and is excluded by requiring the "NO" (not "DT") in the label.
const EXP_LABEL = /\bEXP\s*NO\.?\s*[:.#]?\s*(\d{3,8}-\d{3,6}-\d{4})\b/i;
// Standalone branch-serial-year token (lower trust, used only if no labelled hit).
const EXP_TRIPLE = /\b(\d{3,8}-\d{3,6}-((?:19|20)\d{2}))\b/g;

function extractExp(pages: PageText[]): FieldValue {
  let best = NONE();
  for (const p of pages) {
    const t = p.text || "";
    const lab = t.match(EXP_LABEL);
    if (lab) {
      best = keepBest(best, { value: lab[1], confidence: scaleForMethod(0.95, p), source: p.method, evidence: snippet(t, lab.index ?? 0, lab[0].length), label: "EXP No label", page: p.page });
      continue; // a labelled hit on this page is authoritative
    }
    EXP_TRIPLE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = EXP_TRIPLE.exec(t))) {
      best = keepBest(best, { value: m[1], confidence: scaleForMethod(0.7, p), source: p.method, evidence: snippet(t, m.index ?? 0, m[0].length), label: "EXP-style branch-serial-year token", page: p.page });
    }
  }
  return best;
}

// --- Custom field -----------------------------------------------------------
// Find "<label> [: . # -] <value>" near the user-typed label. Pure/generic: it
// only reports the token that FOLLOWS the label — it never invents a value.
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function extractCustom(pages: PageText[], label: string): FieldValue {
  const clean = (label || "").trim();
  if (!clean) return NONE();
  // Allow any run of whitespace between the words of a multi-word label.
  const pattern = clean.split(/\s+/).map(escapeRegex).join("\\s+");
  const re = new RegExp(`${pattern}\\s*[:.#\\-]?\\s*([A-Za-z0-9][A-Za-z0-9/._\\-]{0,60})`, "i");
  let best = NONE();
  for (const p of pages) {
    const t = p.text || "";
    const m = t.match(re);
    if (m && m[1]) {
      best = keepBest(best, { value: m[1].trim(), confidence: scaleForMethod(0.8, p), source: p.method, evidence: snippet(t, m.index ?? 0, m[0].length), label: `Custom label “${clean}”`, page: p.page });
    }
  }
  return best;
}

/**
 * Extract every non-invoice rename field from the already-parsed page texts
 * (native + OCR). The invoice field is handled by `validate.ts` and mapped by the
 * caller, so it is not recomputed here. Pure; returns nulls for anything absent.
 */
export function extractFields(pages: PageText[], opts: { customLabel?: string } = {}): ExtractedFields {
  const out: ExtractedFields = {
    fcr: extractFcr(pages),
    container: extractContainer(pages),
    exp: extractExp(pages),
  };
  if (opts.customLabel && opts.customLabel.trim()) out.custom = extractCustom(pages, opts.customLabel);
  return out;
}

/** Sanitise an extracted value into a safe filename stem (no path/illegal chars,
 *  no extension). Returns "" when nothing usable remains. */
export function toFileStem(raw: string | null | undefined): string {
  if (!raw) return "";
  return String(raw).trim().replace(/\.pdf$/i, "").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "").trim();
}
