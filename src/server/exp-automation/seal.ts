import { readFile } from "fs/promises";
import { PDFDocument, PDFName, PDFArray, PDFRawStream, decodePDFRawStream } from "pdf-lib";
import { env } from "@/lib/env";

/**
 * Auto-attach the official exporter seal + signature to a downloaded EXP PDF.
 *
 * The original EXP PDF (the portal-captured Bangladesh Bank "EXP FORM") is NEVER
 * modified on disk — this takes the original bytes and returns a NEW sealed copy
 * that becomes the download output. The seal is drawn as an image overlay with
 * pdf-lib, so every original page, dimension, table, border, logo, font and all
 * text is preserved byte-for-byte; only one image (plus a dedupe marker) is added.
 *
 * Placement is derived from the approved reference `20895.pdf`: on that 612-pt-wide
 * page the seal sits at bottom-left (225.75, 301.5) sized 117 × 57 pt, i.e. just
 * below the "Declaration of undertaking by Exporter" heading, in the open area left
 * of the exporter's "Authorized Signature & Stamp" line and vertically centred on
 * it. We find that line's real position per-document (via the PDF's text layer) so
 * the seal tracks different content lengths, and scale the geometry by page width
 * so other page sizes still align. The supplied image is used AS-IS and never
 * altered or recreated.
 *
 * Fail-safe: if the seal image is not configured/readable, or the anchor cannot be
 * located, or anything throws, the ORIGINAL (unsealed) bytes are returned with a
 * reason — the EXP download must never be blocked by sealing.
 */

/** Marker written to the sealed PDF's Keywords so a re-download is never double-stamped. */
export const SEAL_MARKER = "UCP-EXP-SEAL-v1";

// --- Geometry constants, measured from the approved reference 20895.pdf -------
// Reference page is 612 pt wide; the seal rectangle was (x=225.75, y=301.5, w=117, h=57).
const REF_PAGE_WIDTH = 612;
const SEAL_WIDTH_FRAC = 117 / REF_PAGE_WIDTH; // 0.19118 of page width
const SEAL_LEFT_FRAC = 225.75 / REF_PAGE_WIDTH; // 0.36887 of page width
// Reference seal vertical centre = 330.0. Exporter "Authorized Signature" baseline = 323.6
// (centre sits 6.4 pt above it); declaration heading baseline = 413.2 (centre 83.2 pt below).
const CENTRE_ABOVE_AUTHSIG = 6.4; // pt at ref width
const CENTRE_BELOW_DECLARATION = 83.2; // pt at ref width (fallback anchor)

export interface SealResult {
  /** Sealed bytes, or the original bytes when `sealed` is false. */
  buffer: Buffer;
  /** True when a seal image was drawn onto the output. */
  sealed: boolean;
  /** True when the input already carried our seal marker (deduped — not re-stamped). */
  alreadySealed: boolean;
  /** Human-readable status for the audit trail. */
  reason: string;
  /** 1-based page the seal was drawn on. */
  page?: number;
  /** Which anchor positioned it: "authorized-signature" | "declaration" . */
  anchor?: string;
  /** Final drawn rectangle (pt, bottom-left origin). */
  rect?: { x: number; y: number; w: number; h: number };
}

interface TextItem {
  str: string;
  x: number;
  y: number;
}
interface PageText {
  pageNo: number; // 1-based
  width: number;
  height: number;
  items: TextItem[];
}

// --- Seal image bytes are read once and cached (the file rarely changes) -------
let sealCache: { path: string; bytes: Buffer | null; mtimeMs: number } | null = null;

async function loadSealImage(pathOverride?: string): Promise<{ bytes: Buffer; path: string } | null> {
  const path = pathOverride || env.EXP_SEAL_IMAGE_PATH;
  if (!path) return null;
  try {
    const { stat } = await import("fs/promises");
    const s = await stat(path);
    if (sealCache && sealCache.path === path && sealCache.mtimeMs === s.mtimeMs && sealCache.bytes) {
      return { bytes: sealCache.bytes, path };
    }
    const bytes = await readFile(path);
    sealCache = { path, bytes, mtimeMs: s.mtimeMs };
    return { bytes, path };
  } catch {
    sealCache = null;
    return null;
  }
}

// --- Text-layer extraction via a stateless content-stream interpreter ----------
// We parse the page content stream directly (no external PDF-text library): the
// portal-captured EXP PDFs (Chrome print-to-PDF) and pdf-lib both show text as
// `… Tm (literal)Tj` / `… Tm <hex>Tj` with an absolute text matrix per chunk, so
// positions are exact. This is deterministic and re-entrant (safe in the zip loop),
// unlike the vendored pdf.js singleton. Text inside nested Form XObjects is not
// recursed into; if an anchor can't be found the download is simply served unsealed.

// 6-element affine matrices [a b c d e f]; `mul(A,B)` applies A then B.
type M = [number, number, number, number, number, number];
const IDENTITY: M = [1, 0, 0, 1, 0, 0];
function mul(A: M, B: M): M {
  const [a, b, c, d, e, f] = A;
  const [a2, b2, c2, d2, e2, f2] = B;
  return [
    a * a2 + b * c2,
    a * b2 + b * d2,
    c * a2 + d * c2,
    c * b2 + d * d2,
    e * a2 + f * c2 + e2,
    e * b2 + f * d2 + f2,
  ];
}

/** Decode a PDF literal string `( … )` body (escapes + octal) to a latin1 string. */
function decodeLiteral(body: string): string {
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const n = body[++i];
    if (n === undefined) break;
    if (n === "n") out += "\n";
    else if (n === "r") out += "\r";
    else if (n === "t") out += "\t";
    else if (n === "b") out += "\b";
    else if (n === "f") out += "\f";
    else if (n === "\n") {/* line continuation */}
    else if (n === "\r") { if (body[i + 1] === "\n") i++; }
    else if (n >= "0" && n <= "7") {
      let oct = n;
      for (let k = 0; k < 2 && body[i + 1] >= "0" && body[i + 1] <= "7"; k++) oct += body[++i];
      out += String.fromCharCode(parseInt(oct, 8) & 0xff);
    } else out += n; // \( \) \\ and any other escaped char → literal
  }
  return out;
}

function decodeHex(body: string): string {
  const clean = body.replace(/[^0-9A-Fa-f]/g, "");
  const padded = clean.length % 2 ? clean + "0" : clean;
  let out = "";
  for (let i = 0; i < padded.length; i += 2) out += String.fromCharCode(parseInt(padded.slice(i, i + 2), 16));
  return out;
}

type Tok =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "op"; v: string }
  | { t: "arr"; open: boolean }
  | { t: "other" };

/** Tokenize a content stream, yielding numbers, strings, array brackets and operators. */
function tokenize(s: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const n = s.length;
  const isWs = (c: string) => c === " " || c === "\n" || c === "\r" || c === "\t" || c === "\f" || c === "\0";
  while (i < n) {
    const c = s[i];
    if (isWs(c)) { i++; continue; }
    if (c === "%") { while (i < n && s[i] !== "\n" && s[i] !== "\r") i++; continue; } // comment
    if (c === "(") {
      let depth = 1; i++; let body = "";
      while (i < n && depth > 0) {
        const ch = s[i];
        if (ch === "\\") { body += ch + (s[i + 1] ?? ""); i += 2; continue; }
        if (ch === "(") depth++;
        else if (ch === ")") { depth--; if (depth === 0) { i++; break; } }
        body += ch; i++;
      }
      toks.push({ t: "str", v: decodeLiteral(body) });
      continue;
    }
    if (c === "<") {
      if (s[i + 1] === "<") { toks.push({ t: "other" }); i += 2; continue; } // dict open
      let j = i + 1; let body = "";
      while (j < n && s[j] !== ">") body += s[j++];
      toks.push({ t: "str", v: decodeHex(body) });
      i = j + 1;
      continue;
    }
    if (c === ">") { i += s[i + 1] === ">" ? 2 : 1; toks.push({ t: "other" }); continue; }
    if (c === "[") { toks.push({ t: "arr", open: true }); i++; continue; }
    if (c === "]") { toks.push({ t: "arr", open: false }); i++; continue; }
    if (c === "/") { // name
      i++;
      while (i < n && !isWs(s[i]) && !"()<>[]{}/%".includes(s[i])) i++;
      toks.push({ t: "other" });
      continue;
    }
    if (c === "{" || c === "}") { i++; toks.push({ t: "other" }); continue; }
    // number or operator token
    let j = i;
    while (j < n && !isWs(s[j]) && !"()<>[]{}/%".includes(s[j])) j++;
    const word = s.slice(i, j);
    i = j;
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) toks.push({ t: "num", v: parseFloat(word) });
    else toks.push({ t: "op", v: word });
  }
  return toks;
}

/** Parse one page's decoded content into positioned text items (user-space, y-up). */
function parsePageItems(content: string): TextItem[] {
  const toks = tokenize(content);
  const items: TextItem[] = [];
  let ctm: M = IDENTITY;
  const stack: M[] = [];
  let tm: M = IDENTITY;
  let tlm: M = IDENTITY;
  let leading = 0;
  const operands: Tok[] = [];
  const nums = (k: number): number[] => operands.slice(-k).map((o) => (o.t === "num" ? o.v : 0));
  const show = (str: string) => {
    if (!str) return;
    const comb = mul(tm, ctm);
    items.push({ str, x: comb[4], y: comb[5] });
  };

  for (const tk of toks) {
    if (tk.t === "num" || tk.t === "str" || tk.t === "arr" || tk.t === "other") {
      operands.push(tk);
      continue;
    }
    // operator
    switch (tk.v) {
      case "q": stack.push(ctm); break;
      case "Q": ctm = stack.pop() ?? IDENTITY; break;
      case "cm": { const [a, b, c, d, e, f] = nums(6); ctm = mul([a, b, c, d, e, f], ctm); break; }
      case "BT": tm = IDENTITY; tlm = IDENTITY; break;
      case "ET": break;
      case "Tm": { const [a, b, c, d, e, f] = nums(6); tm = [a, b, c, d, e, f]; tlm = [a, b, c, d, e, f]; break; }
      case "Td": { const [tx, ty] = nums(2); tlm = mul([1, 0, 0, 1, tx, ty], tlm); tm = tlm; break; }
      case "TD": { const [tx, ty] = nums(2); leading = -ty; tlm = mul([1, 0, 0, 1, tx, ty], tlm); tm = tlm; break; }
      case "T*": { tlm = mul([1, 0, 0, 1, 0, -leading], tlm); tm = tlm; break; }
      case "TL": { leading = nums(1)[0]; break; }
      case "Tj": { const o = operands[operands.length - 1]; if (o && o.t === "str") show(o.v); break; }
      case "'": { tlm = mul([1, 0, 0, 1, 0, -leading], tlm); tm = tlm; const o = operands[operands.length - 1]; if (o && o.t === "str") show(o.v); break; }
      case '"': { tlm = mul([1, 0, 0, 1, 0, -leading], tlm); tm = tlm; const o = operands[operands.length - 1]; if (o && o.t === "str") show(o.v); break; }
      case "TJ": {
        // array of strings/numbers on the operand stack between [ ]
        let depth = 0; const parts: string[] = [];
        for (let k = operands.length - 1; k >= 0; k--) {
          const op = operands[k];
          if (op.t === "arr" && !op.open) depth++;
          else if (op.t === "arr" && op.open) { depth--; if (depth === 0) break; }
          else if (depth > 0 && op.t === "str") parts.unshift(op.v);
        }
        show(parts.join(""));
        break;
      }
      default: break;
    }
    operands.length = 0;
  }
  return items;
}

export async function extractPageText(buffer: Buffer): Promise<PageText[]> {
  const doc = await PDFDocument.load(buffer, { ignoreEncryption: true });
  const pages: PageText[] = [];
  const pdfPages = doc.getPages();
  for (let idx = 0; idx < pdfPages.length; idx++) {
    const page = pdfPages[idx];
    const { width, height } = page.getSize();
    let items: TextItem[] = [];
    try {
      const contentsRef = page.node.get(PDFName.of("Contents"));
      const obj = contentsRef && doc.context.lookup(contentsRef);
      const parts: string[] = [];
      if (obj instanceof PDFArray) {
        for (const el of obj.asArray()) {
          const s = doc.context.lookup(el);
          if (s instanceof PDFRawStream) parts.push(decodeStreamText(s));
        }
      } else if (obj instanceof PDFRawStream) {
        parts.push(decodeStreamText(obj));
      }
      items = parsePageItems(parts.join("\n"));
    } catch {
      items = [];
    }
    pages.push({ pageNo: idx + 1, width, height, items });
  }
  return pages;
}

function decodeStreamText(s: PDFRawStream): string {
  try {
    return Buffer.from(decodePDFRawStream(s).decode()).toString("latin1");
  } catch {
    return Buffer.from(s.contents).toString("latin1");
  }
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

export interface Anchor {
  pageNo: number;
  pageWidth: number;
  pageHeight: number;
  /** Baseline Y of the exporter "Authorized Signature & Stamp" line, if found. */
  authSigY: number | null;
  /** Baseline Y of the "Declaration of undertaking by Exporter" heading, if found. */
  declarationY: number | null;
}

/**
 * Find the exporter signature anchor. Scans each page for the declaration heading
 * and the exporter "Authorized Signature & Stamp" line, scoped to the EXPORTER
 * block (never the "Stamp and Signature of Authorized Dealer" block lower down).
 * Returns the best page (one carrying the signature anchor, else the declaration).
 */
export function findSealAnchor(pages: PageText[]): Anchor | null {
  let declOnly: Anchor | null = null;
  for (const pg of pages) {
    if (!pg.width || !pg.height) continue;
    let declarationY: number | null = null;
    for (const it of pg.items) {
      if (norm(it.str).includes("declaration of undertaking")) {
        declarationY = it.y;
        break;
      }
    }
    // Exporter signature line. The dealer block reads "Stamp and Signature of" /
    // "Authorized Dealer", so we require the exporter wording and exclude "dealer".
    let authSigY: number | null = null;
    for (const it of pg.items) {
      const n = norm(it.str);
      if (n.includes("dealer")) continue;
      const isSig = n.includes("authorized signature") || n.includes("stamp of the exporter");
      if (!isSig) continue;
      // If we know the declaration heading, keep only signature lines below it.
      if (declarationY !== null && it.y >= declarationY) continue;
      // Prefer the signature line closest below the heading (largest y so far).
      if (authSigY === null || it.y > authSigY) authSigY = it.y;
    }
    if (authSigY !== null) {
      return { pageNo: pg.pageNo, pageWidth: pg.width, pageHeight: pg.height, authSigY, declarationY };
    }
    if (declarationY !== null && !declOnly) {
      declOnly = { pageNo: pg.pageNo, pageWidth: pg.width, pageHeight: pg.height, authSigY: null, declarationY };
    }
  }
  return declOnly;
}

function hasMarker(doc: PDFDocument): boolean {
  try {
    const kw = doc.getKeywords();
    return typeof kw === "string" && kw.includes(SEAL_MARKER);
  } catch {
    return false;
  }
}

export interface SealOptions {
  /** Override the seal-image path (defaults to env.EXP_SEAL_IMAGE_PATH). For tests. */
  sealImagePath?: string;
}

/**
 * Seal an EXP PDF. Returns a new sealed copy (download output) or the original
 * bytes when sealing is skipped. Never throws.
 */
export async function sealExpPdf(original: Buffer, opts: SealOptions = {}): Promise<SealResult> {
  const fail = (reason: string, extra: Partial<SealResult> = {}): SealResult => ({
    buffer: original,
    sealed: false,
    alreadySealed: false,
    reason,
    ...extra,
  });

  // 1) Dedupe: if this PDF already carries our marker, never re-stamp.
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(original, { ignoreEncryption: true });
  } catch {
    return fail("unreadable PDF (left unsealed)");
  }
  if (hasMarker(doc)) {
    return { buffer: original, sealed: false, alreadySealed: true, reason: "already sealed (marker present)" };
  }

  // 2) Load the approved seal image.
  const seal = await loadSealImage(opts.sealImagePath);
  if (!seal) return fail(`seal image not available at ${opts.sealImagePath || env.EXP_SEAL_IMAGE_PATH}`);

  // 3) Locate the anchor from the text layer.
  let pages: PageText[];
  try {
    pages = await extractPageText(original);
  } catch {
    return fail("could not read text layer for placement");
  }
  const anchor = findSealAnchor(pages);
  if (!anchor) return fail("declaration/signature anchor not found (left unsealed)");

  // 4) Compute the seal rectangle (bottom-left origin).
  let img;
  try {
    img = seal.bytes[0] === 0x89 ? await doc.embedPng(seal.bytes) : await doc.embedJpg(seal.bytes);
  } catch {
    return fail("seal image could not be embedded");
  }
  const k = anchor.pageWidth / REF_PAGE_WIDTH;
  const w = SEAL_WIDTH_FRAC * anchor.pageWidth;
  const h = w * (img.height / img.width); // preserve the supplied image's true aspect
  const x = SEAL_LEFT_FRAC * anchor.pageWidth;
  let centreY: number;
  let used: string;
  if (anchor.authSigY !== null) {
    centreY = anchor.authSigY + CENTRE_ABOVE_AUTHSIG * k;
    used = "authorized-signature";
  } else {
    centreY = (anchor.declarationY as number) - CENTRE_BELOW_DECLARATION * k;
    used = "declaration";
  }
  let y = centreY - h / 2;
  // Keep it on the page (defensive clamp).
  y = Math.max(2, Math.min(y, anchor.pageHeight - h - 2));
  const clampedX = Math.max(2, Math.min(x, anchor.pageWidth - w - 2));

  // 5) Draw and mark.
  const pdfPages = doc.getPages();
  const target = pdfPages[anchor.pageNo - 1];
  if (!target) return fail("anchor page out of range (left unsealed)");
  try {
    target.drawImage(img, { x: clampedX, y, width: w, height: h });
    const existing = (() => {
      try {
        return doc.getKeywords();
      } catch {
        return undefined;
      }
    })();
    const keywords = existing ? `${existing} ${SEAL_MARKER}` : SEAL_MARKER;
    doc.setKeywords([keywords]);
    const out = Buffer.from(await doc.save());
    return {
      buffer: out,
      sealed: true,
      alreadySealed: false,
      reason: "sealed",
      page: anchor.pageNo,
      anchor: used,
      rect: { x: clampedX, y, w, h },
    };
  } catch {
    return fail("failed to draw/save seal (left unsealed)");
  }
}
