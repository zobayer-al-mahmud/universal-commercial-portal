/**
 * PDF File Rename — folder workflow engine (module 4).
 *
 * Processes the real PDFs in a dedicated folder: read each file's invoice number
 * from its embedded text (digital FCR / Bill of Export) or via OCR (scanned
 * copies), compute the canonical filename, and build a safe rename plan.
 *
 * Non-negotiables (CLAUDE.md / task spec #8, #10):
 *  - Never invent a number: a file whose invoice cannot be read is routed to
 *    manual review, never given a guessed name.
 *  - Never overwrite: a target that already exists on disk, or a duplicate
 *    invoice shared by two sources, is flagged — not silently clobbered.
 *  - Preserve the original: apply COPIES into an output sub-folder; the source
 *    PDF's bytes and page layout are untouched (only the filename changes).
 *  - Keep types apart: each dedicated folder writes into its own output
 *    sub-folder, so FCR, soft copies and scanned copies never mix.
 */

import { promises as fs } from "fs";
import path from "path";
import { extractInvoice, type RenameDocKind } from "./invoice-rules";
import { ocrPdfText, ocrPdfPages } from "./ocr";
import { validateInvoice, type PageText, type ValidationResult } from "./validate";

export type RenameItemStatus = "planned" | "collision" | "needs_review" | "skipped";

/** Minimum embedded-text length before we trust pdf-parse over OCR. */
const MIN_TEXT_CHARS = 30;

export interface ProcessedFile {
  originalName: string;
  docType: RenameDocKind;
  invoiceNumber: string | null;
  raw: string | null;
  countryToken: string | null;
  source: "text" | "ocr" | "none";
  method: string;
  textChars: number;
  pages: number;
  /** Pre-plan status: "planned" when a number was read, else "needs_review". */
  status: Exclude<RenameItemStatus, "collision">;
  reason: string;
}

export interface PlanItem extends Omit<ProcessedFile, "status"> {
  /** Final target filename (`<invoice>.pdf`) or null. */
  newName: string | null;
  status: RenameItemStatus;
}

export interface PlanSummary {
  total: number;
  planned: number;
  collision: number;
  needsReview: number;
}

// --- pdf-parse (serialized + retry) ----------------------------------------
// pdf-parse embeds an old pdf.js with module-level state that corrupts under
// concurrency; serialize calls and retry once, matching the booking module.
let pdfChain: Promise<unknown> = Promise.resolve();
async function parsePdfText(buffer: Buffer): Promise<{ text: string; pages: number }> {
  const run = async () => {
    const pdfParse = (await import("pdf-parse/lib/pdf-parse.js")).default;
    try {
      const d = await pdfParse(buffer);
      return { text: d.text ?? "", pages: d.numpages ?? 1 };
    } catch {
      const d = await pdfParse(buffer);
      return { text: d.text ?? "", pages: d.numpages ?? 1 };
    }
  };
  const result = pdfChain.then(run, run);
  pdfChain = result.then(() => undefined, () => undefined);
  return result;
}

/** Per-page native text (serialized). Mirrors pdf-parse's default line-break
 *  heuristic but keeps each page separate so candidates carry a page number. */
async function parsePdfPages(buffer: Buffer): Promise<{ pages: { page: number; text: string }[]; numpages: number }> {
  const run = async () => {
    const pdfParse = (await import("pdf-parse/lib/pdf-parse.js")).default;
    const pages: { page: number; text: string }[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pagerender = (pageData: any) =>
      pageData.getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false }).then((tc: { items: { str: string; transform: number[] }[] }) => {
        let lastY: number | undefined;
        let text = "";
        for (const item of tc.items) {
          if (lastY === item.transform[5] || lastY === undefined) text += item.str;
          else text += "\n" + item.str;
          lastY = item.transform[5];
        }
        pages.push({ page: pages.length + 1, text });
        return text;
      });
    const run2 = async () => {
      pages.length = 0;
      const d = await pdfParse(buffer, { pagerender });
      return { pages: [...pages], numpages: d.numpages ?? pages.length };
    };
    try {
      return await run2();
    } catch {
      return await run2();
    }
  };
  const result = pdfChain.then(run, run);
  pdfChain = result.then(() => undefined, () => undefined);
  return result as Promise<{ pages: { page: number; text: string }[]; numpages: number }>;
}

export interface AnalyzeResult {
  validation: ValidationResult;
  pages: number;
  textChars: number;
  usedOcr: boolean;
  ocrError?: string;
  parseError?: string;
  /** The per-page text (native + OCR) the validator saw, so callers can run
   *  additional pure field extractors (fields.ts) without re-parsing/re-OCRing. */
  pageTexts: PageText[];
}

/**
 * Deep-analyze one PDF buffer: per-page native text, OCR fallback for scanned
 * pages, then the cross-validating decision (`validate.ts`). Pure of folder I/O.
 */
export async function analyzePdf(buffer: Buffer, opts: { minConfidence: number }): Promise<AnalyzeResult> {
  let nativePages: { page: number; text: string }[] = [];
  let numpages = 0;
  try {
    const r = await parsePdfPages(buffer);
    nativePages = r.pages;
    numpages = r.numpages;
  } catch (e) {
    return {
      validation: {
        docType: "unknown", invoiceNumber: null, numericKey: null, countryToken: null, candidates: [],
        source: "none", method: "none", confidence: 0, pageRefs: [],
        decision: "REVIEW", reasonCode: "PDF_UNREADABLE_OR_CORRUPTED",
        reasonText: `PDF could not be parsed: ${e instanceof Error ? e.message : String(e)}`,
      },
      pages: 0, textChars: 0, usedOcr: false, parseError: e instanceof Error ? e.message : String(e), pageTexts: [],
    };
  }

  const textChars = nativePages.reduce((s, p) => s + p.text.replace(/\s+/g, "").length, 0);
  const pageTexts: PageText[] = nativePages
    .filter((p) => p.text.replace(/\s+/g, "").length > 0)
    .map((p) => ({ page: p.page, text: p.text, method: "text" as const }));

  let usedOcr = false;
  let ocrError: string | undefined;
  if (textChars < MIN_TEXT_CHARS) {
    const ocr = await ocrPdfPages(buffer);
    ocrError = ocr.error;
    usedOcr = ocr.pages.length > 0;
    for (const op of ocr.pages) pageTexts.push({ page: op.page, text: op.text, method: "ocr", ocrConfidence: op.confidence, words: op.words });
  }

  if (pageTexts.length === 0) {
    return {
      validation: {
        docType: "unknown", invoiceNumber: null, numericKey: null, countryToken: null, candidates: [],
        source: "none", method: "none", confidence: 0, pageRefs: [],
        decision: "REVIEW", reasonCode: "INVOICE_NUMBER_NOT_FOUND",
        reasonText: ocrError ? `Scanned PDF — ${ocrError}. Manual review needed.` : "No readable text; scanned PDF needs OCR (enable OCR_ENABLED) or manual review.",
      },
      pages: numpages, textChars, usedOcr, ocrError, pageTexts,
    };
  }

  const validation = validateInvoice(pageTexts, { minConfidence: opts.minConfidence });
  return { validation, pages: numpages || nativePages.length, textChars, usedOcr, ocrError, pageTexts };
}

/**
 * Read one PDF's invoice number. Tries embedded text first; for a scanned PDF
 * (little/no text) it falls back to OCR when enabled. Returns a ProcessedFile
 * with status "planned" (number read) or "needs_review" (safe fallback).
 */
export async function processPdf(buffer: Buffer, originalName: string): Promise<ProcessedFile> {
  const base = (dt: RenameDocKind): ProcessedFile => ({
    originalName,
    docType: dt,
    invoiceNumber: null,
    raw: null,
    countryToken: null,
    source: "none",
    method: "none",
    textChars: 0,
    pages: 0,
    status: "needs_review",
    reason: "",
  });

  let text = "";
  let pages = 0;
  try {
    const parsed = await parsePdfText(buffer);
    text = parsed.text;
    pages = parsed.pages;
  } catch {
    const b = base("unknown");
    b.reason = "Invalid or unreadable PDF — could not parse the document.";
    return b;
  }

  const textChars = text.replace(/\s+/g, "").length;

  // Digital document: read the invoice straight from the embedded text.
  if (textChars >= MIN_TEXT_CHARS) {
    const ex = extractInvoice(text);
    if (ex.invoiceNumber) {
      return {
        originalName,
        docType: ex.docType,
        invoiceNumber: ex.invoiceNumber,
        raw: ex.raw,
        countryToken: ex.countryToken,
        source: "text",
        method: ex.method,
        textChars,
        pages,
        status: "planned",
        reason: ex.label,
      };
    }
    const b = base(ex.docType);
    b.textChars = textChars;
    b.pages = pages;
    b.reason =
      ex.docType === "unknown"
        ? "Document type not recognised and no invoice number could be read from the text."
        : "The invoice number could not be read from this document's text.";
    return b;
  }

  // Scanned document: OCR fallback (gated).
  const ocr = await ocrPdfText(buffer);
  if (ocr.text) {
    const ex = extractInvoice(ocr.text);
    if (ex.invoiceNumber) {
      return {
        originalName,
        docType: ex.docType,
        invoiceNumber: ex.invoiceNumber,
        raw: ex.raw,
        countryToken: ex.countryToken,
        source: "ocr",
        method: `ocr:${ex.method}`,
        textChars,
        pages,
        status: "planned",
        reason: `${ex.label} (read via OCR of ${ocr.pagesOcred} page(s))`,
      };
    }
    const b = base(ex.docType);
    b.pages = pages;
    b.source = "ocr";
    b.reason = "Scanned PDF OCR'd but no invoice number token was found — needs manual review.";
    return b;
  }

  const b = base("unknown");
  b.pages = pages;
  b.reason = ocr.engineAvailable
    ? `Scanned PDF — OCR produced no text (${ocr.error ?? "unknown reason"}). Needs manual review.`
    : `Scanned PDF — OCR is not available (${ocr.error ?? "OCR disabled"}). Enable OCR or review manually.`;
  return b;
}

/**
 * Build the rename plan from processed files (PURE). Assigns `<invoice>.pdf`
 * targets, then flags any two sources that resolve to the same invoice number as
 * a collision (duplicate invoice) so neither is silently overwritten.
 */
export function buildPlan(files: ProcessedFile[]): { items: PlanItem[]; summary: PlanSummary } {
  const items: PlanItem[] = files.map((f) => ({
    ...f,
    newName: f.status === "planned" && f.invoiceNumber ? `${f.invoiceNumber}.pdf` : null,
    status: f.status as RenameItemStatus,
  }));

  const byTarget = new Map<string, PlanItem[]>();
  for (const it of items) {
    if (it.status === "planned" && it.newName) {
      if (!byTarget.has(it.newName)) byTarget.set(it.newName, []);
      byTarget.get(it.newName)!.push(it);
    }
  }
  for (const [target, group] of byTarget) {
    if (group.length > 1) {
      for (const it of group) {
        it.status = "collision";
        it.reason = `Duplicate invoice number — ${group.length} files map to '${target}'. Resolve manually; none was renamed.`;
      }
    }
  }

  return {
    items,
    summary: {
      total: items.length,
      planned: items.filter((i) => i.status === "planned").length,
      collision: items.filter((i) => i.status === "collision").length,
      needsReview: items.filter((i) => i.status === "needs_review").length,
    },
  };
}

// --- Folder I/O -------------------------------------------------------------

export interface DedicatedFolder {
  name: string;
  fileCount: number;
}

/** List the dedicated folders (immediate sub-folders of the root). */
export async function listRenameFolders(root: string, outputSubdir: string): Promise<DedicatedFolder[]> {
  if (!root) return [];
  const entries = await fs.readdir(root, { withFileTypes: true });
  const out: DedicatedFolder[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".") || e.name === outputSubdir) continue;
    const count = (await listFolderPdfFiles(root, e.name, outputSubdir)).length;
    out.push({ name: e.name, fileCount: count });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

/**
 * Resolve + validate a folder selection against the rename root (path-safe).
 *
 * Accepts the root itself ("" / ".") or any nested sub-folder BENEATH the root
 * (e.g. "FCR EXTRACT & RENAME" or "WEEK 41/scans"). Back-slashes are normalised,
 * leading slashes stripped (so an absolute-looking input stays relative to the
 * root), and `.`/`..` segments are rejected — the resolved path can never escape
 * the configured server root. This is the only filesystem the module touches;
 * it never reads the user's local computer.
 */
export function resolveFolder(root: string, folder: string): string {
  const rel = String(folder ?? "").trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
  if (rel.split("/").some((seg) => seg === ".." || seg === ".")) throw new Error(`Invalid folder: ${folder}`);
  const base = path.resolve(root);
  const abs = path.resolve(base, rel);
  if (abs !== base && !abs.startsWith(base + path.sep)) throw new Error(`Folder outside the rename root: ${folder}`);
  return abs;
}

/** The immediate .pdf files of a folder (excluding the output sub-folder). */
export async function listFolderPdfFiles(root: string, folder: string, outputSubdir: string): Promise<string[]> {
  const abs = resolveFolder(root, folder);
  let entries: import("fs").Dirent[];
  try {
    entries = await fs.readdir(abs, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".pdf"))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

export interface ScanResult {
  folder: string;
  items: PlanItem[];
  summary: PlanSummary;
}

/**
 * Scan every PDF in a dedicated folder and build the rename plan. Read-only:
 * no file on disk is created or modified. `files` restricts the scan to a subset
 * (used by "Rename One PDF").
 */
export async function scanFolder(
  root: string,
  folder: string,
  opts: { outputSubdir: string; maxFiles: number; files?: string[] },
): Promise<ScanResult> {
  const abs = resolveFolder(root, folder);
  let names = await listFolderPdfFiles(root, folder, opts.outputSubdir);
  if (opts.files) {
    const want = new Set(opts.files);
    names = names.filter((n) => want.has(n));
  }
  if (opts.maxFiles > 0 && names.length > opts.maxFiles) throw new Error(`Folder has ${names.length} PDFs (> ${opts.maxFiles}). Raise PDF_RENAME_MAX_FILES (set 0 for unlimited) or narrow the scan.`);

  const processed: ProcessedFile[] = [];
  for (const name of names) {
    try {
      const buffer = await fs.readFile(path.join(abs, name));
      processed.push(await processPdf(buffer, name));
    } catch (e) {
      processed.push({
        originalName: name,
        docType: "unknown",
        invoiceNumber: null,
        raw: null,
        countryToken: null,
        source: "none",
        method: "none",
        textChars: 0,
        pages: 0,
        status: "needs_review",
        reason: `Could not read file: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }
  const { items, summary } = buildPlan(processed);
  return { folder, items, summary };
}

export type ApplyActionKind = "renamed" | "target-exists" | "missing-source" | "skipped";

export interface ApplyActionResult {
  originalName: string;
  newName: string | null;
  action: ApplyActionKind;
  reason: string;
  outputPath?: string;
}

export interface ApplyResult {
  folder: string;
  outputDir: string;
  renamed: ApplyActionResult[];
  summary: Record<ApplyActionKind, number>;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Apply a plan by COPYING each planned source to `<folder>/<outputSubdir>/
 * <invoice>.pdf`. Originals are untouched; an existing target is never
 * overwritten (reported as target-exists). Only "planned" items are copied —
 * collisions and review items are skipped.
 */
export async function applyPlan(
  root: string,
  folder: string,
  outputSubdir: string,
  items: PlanItem[],
): Promise<ApplyResult> {
  const abs = resolveFolder(root, folder);
  const outputDir = path.join(abs, outputSubdir);
  await fs.mkdir(outputDir, { recursive: true });

  const renamed: ApplyActionResult[] = [];
  const summary: Record<ApplyActionKind, number> = { renamed: 0, "target-exists": 0, "missing-source": 0, skipped: 0 };
  const claimed = new Set<string>();

  for (const it of items) {
    if (it.status !== "planned" || !it.newName) {
      summary.skipped++;
      renamed.push({ originalName: it.originalName, newName: it.newName, action: "skipped", reason: `Status '${it.status}'` });
      continue;
    }
    const src = path.join(abs, it.originalName);
    if (!(await fileExists(src))) {
      summary["missing-source"]++;
      renamed.push({ originalName: it.originalName, newName: it.newName, action: "missing-source", reason: "Source file no longer present." });
      continue;
    }
    const dest = path.join(outputDir, it.newName);
    if (claimed.has(it.newName) || (await fileExists(dest))) {
      summary["target-exists"]++;
      renamed.push({ originalName: it.originalName, newName: it.newName, action: "target-exists", reason: `'${it.newName}' already exists in the output folder — not overwritten.` });
      continue;
    }
    await fs.copyFile(src, dest);
    claimed.add(it.newName);
    summary.renamed++;
    renamed.push({ originalName: it.originalName, newName: it.newName, action: "renamed", reason: "", outputPath: dest });
  }

  return { folder, outputDir, renamed, summary };
}
