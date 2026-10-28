import JSZip from "jszip";
import { readFile } from "fs/promises";
import { existsSync } from "fs";
import type { InvoiceFields } from "./types";

/**
 * Surgical zip-level xlsx patcher.
 *
 * ExcelJS loses the `editAs="oneCell"` attribute on image drawings during a
 * full load → save round-trip, which repositions the ANANTA GARMENTS LTD /
 * certification-logo header images in Excel. To preserve the template layout
 * byte-for-byte, we treat the .xlsx as a zip and only rewrite:
 *
 *   - `xl/worksheets/sheetN.xml` for the PAYMENT INVOICE sheet (cell values on
 *     the learned input row, columns A–Q; column R stays as `=F*M`).
 *   - `xl/sharedStrings.xml` with any newly introduced string values
 *     (contract no, dates, country code, etc. that aren't already shared).
 *
 * Everything else — drawings, images, styles, calc chain, merged cells,
 * conditional formatting — is left exactly as it was in the template.
 */

/**
 * Resolve a sheet-name to its XML path by reading workbook.xml + rels.
 *
 * Matches by exact name first (case-insensitive), then by endsWith / contains
 * — some per-country templates prefix the sheet (e.g. "TR-PAYMENT INVOICE").
 */
async function resolveSheetXmlPath(zip: JSZip, sheetName: string): Promise<string | null> {
  const workbook = await zip.file("xl/workbook.xml")?.async("string");
  const rels = await zip.file("xl/_rels/workbook.xml.rels")?.async("string");
  if (!workbook || !rels) return null;
  const sheets = [...workbook.matchAll(/<sheet\s+([^>]+?)\/?>/g)].map((m) => m[1]);
  const needle = sheetName.toUpperCase();
  const pickName = (pred: (upper: string) => boolean): string | undefined =>
    sheets.find((attrs) => {
      const name = attrs.match(/name="([^"]+)"/)?.[1] ?? "";
      return pred(name.toUpperCase());
    });
  const sheet =
    pickName((n) => n === needle) ||
    pickName((n) => n.endsWith(needle)) ||
    pickName((n) => n.includes(needle));
  if (!sheet) return null;
  const rId = sheet.match(/r:id="([^"]+)"/)?.[1];
  if (!rId) return null;
  const rel = [...rels.matchAll(/<Relationship\s+([^>]+?)\/?>/g)]
    .map((m) => m[1])
    .find((attrs) => new RegExp(`Id="${rId}"`).test(attrs));
  if (!rel) return null;
  const target = rel.match(/Target="([^"]+)"/)?.[1];
  if (!target) return null;
  return `xl/${target}`;
}

/**
 * Shared-string table manager — looks up or appends strings and returns their
 * index. The last-known count is updated so Excel can read the file back.
 */
class SharedStrings {
  /** Raw `<si>…</si>` XML for every pre-existing entry — preserved verbatim so
   *  multi-run rich text (bold label + plain value in one cell, e.g.
   *  "Port of loading: " + "Chittagong") is never flattened or truncated. */
  private originalSi: string[] = [];
  /** Plain-text value of each entry (concatenation of ALL `<t>` runs),
   *  index-aligned with the table, used for lookups + scanning. */
  private texts: string[] = [];
  /** Strings introduced by this patch (appended as plain `<si><t>`). */
  private appended: string[] = [];
  constructor(xml: string) {
    const siRe = /<si\b[^>]*>[\s\S]*?<\/si>/g;
    for (const raw of xml.match(siRe) ?? []) {
      this.originalSi.push(raw);
      // Full cell text = concatenation of every <t> run inside the <si>.
      const runs = [...raw.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => decodeXmlEntities(x[1]));
      this.texts.push(runs.length ? runs.join("") : raw.replace(/<[^>]+>/g, ""));
    }
  }
  indexOf(value: string): number {
    const i = this.texts.indexOf(value);
    if (i >= 0) return i;
    this.texts.push(value);
    this.appended.push(value);
    return this.texts.length - 1;
  }
  render(): string {
    const items = [
      ...this.originalSi,
      ...this.appended.map((s) => `<si><t xml:space="preserve">${encodeXmlEntities(s)}</t></si>`),
    ].join("");
    const total = this.originalSi.length + this.appended.length;
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${total}" uniqueCount="${total}">${items}</sst>`;
  }
  /** For callers that need to scan the current table (eg. finding AGL refs). */
  entries(): string[] { return this.texts; }
}

function decodeXmlEntities(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}
function encodeXmlEntities(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Find the input row — the row that holds the per-order variable values.
 *
 * Three detection paths, in order:
 *   1. Legacy: the LAST row whose cell references a BARE "AGL/H&M/<n>/<yyyy>"
 *      shared string. Works on the historical templates that still carried
 *      their original contract ref on the input row.
 *   2. Stripped-template fallback: the row immediately below the header row.
 *      The header row is uniquely identifiable by the "INV. NO." label (plus
 *      companions like "GROSS W" / "EXP DT"), which is always present on the
 *      row above the input row and never anywhere else in the sheet.
 *   3. Formula-reference anchor: every invoice template pulls values off the
 *      input row via single-cell formulas like `=G74`, `=M74`, `=F74*M74`,
 *      `=K74 & " "` etc. The input row is simply the row most other cells
 *      point at. Covers templates (SW, NH, OE-NL variants, …) whose input
 *      row never carried a bare contract ref AND lacks the "INV. NO." label
 *      — Paths 1 and 2 return null for those, so without this path the whole
 *      patch bails and the writer falls back to the plain fresh workbook
 *      (no logo, no header, no cross-sheet formulas).
 */
function findInputRow(sheetXml: string, ss: SharedStrings): number | null {
  const bareRefIndices: number[] = [];
  const headerIndices: number[] = [];
  ss.entries().forEach((s, i) => {
    const t = s.trim();
    if (/^AGL\/H&M\/\d+\/\d{4}$/i.test(t)) bareRefIndices.push(i);
    // Uppercase label unique to the template's hidden data-row header.
    if (/^INV\.?\s*NO\.?$/i.test(t)) headerIndices.push(i);
  });

  // Match EITHER self-closing (<row …/>) OR content rows (<row …>…</row>).
  const rowRe = /<row[^>]*\br="(\d+)"[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g;

  // Path 1: contract-ref anchor.
  if (bareRefIndices.length > 0) {
    const refRows: number[] = [];
    for (const m of sheetXml.matchAll(rowRe)) {
      const body = m[2] ?? "";
      if (!body) continue;
      const rowNum = parseInt(m[1], 10);
      for (const idx of bareRefIndices) {
        if (new RegExp(`<c\\b[^>]*t="s"[^>]*><v>${idx}<\\/v>`).test(body)) {
          refRows.push(rowNum);
          break;
        }
      }
    }
    if (refRows.length > 0) return Math.max(...refRows);
  }

  // Path 2: header-row + 1.
  if (headerIndices.length > 0) {
    const headerRows: number[] = [];
    for (const m of sheetXml.matchAll(rowRe)) {
      const body = m[2] ?? "";
      if (!body) continue;
      const rowNum = parseInt(m[1], 10);
      for (const idx of headerIndices) {
        if (new RegExp(`<c\\b[^>]*t="s"[^>]*><v>${idx}<\\/v>`).test(body)) {
          headerRows.push(rowNum);
          break;
        }
      }
    }
    if (headerRows.length > 0) return Math.max(...headerRows) + 1;
  }

  // Path 3: formula-reference count. Count how many *other* rows reference
  // each candidate row via a single-cell formula on columns A..Q (the
  // input-row columns). The input row is the one most other cells target.
  // Only accept the pick when it clearly stands out (≥ 3 references, and at
  // least 2× the runner-up) — otherwise return null so the writer falls back
  // cleanly rather than guessing.
  const refCounts = new Map<number, number>();
  const COL_RE = /\b[A-Q](\d+)\b/g;
  for (const fm of sheetXml.matchAll(/<f[^>]*>([\s\S]*?)<\/f>/g)) {
    const expr = fm[1];
    // Only count row numbers that appear bound to a column letter (so we
    // don't catch bare row numbers that happen to appear in other XML text).
    const seenHere = new Set<number>();
    for (const cm of expr.matchAll(COL_RE)) {
      const row = parseInt(cm[1], 10);
      if (!Number.isFinite(row)) continue;
      // One formula counts at most once per target row — avoids `F74*M74`
      // double-counting row 74 (it is still clearly the input row either way,
      // but keeping the count honest makes the "stands out" check robust).
      if (seenHere.has(row)) continue;
      seenHere.add(row);
      refCounts.set(row, (refCounts.get(row) ?? 0) + 1);
    }
  }
  if (refCounts.size > 0) {
    const sorted = [...refCounts.entries()].sort((a, b) => b[1] - a[1]);
    const [topRow, topCount] = sorted[0];
    const runnerUp = sorted[1]?.[1] ?? 0;
    if (topCount >= 3 && topCount >= runnerUp * 2) return topRow;
  }

  return null;
}

/**
 * Rewrite one cell inside a row's XML. If the cell exists, its `<v>` /
 * optional `<f>` is replaced (preserving `s="..."` style). If it doesn't
 * exist, a new cell is inserted at the end of the row.
 */
function setCell(rowXml: string, ref: string, kind: "s" | "n", valueOrIndex: string | number, isFormula = false): string {
  const existing = new RegExp(`(<c\\b[^>]*\\br="${ref}"[^>]*?)(?:/>|>([\\s\\S]*?)<\\/c>)`, "g");
  const match = existing.exec(rowXml);
  if (match) {
    const openAttrs = match[1];
    const prevInner = match[2] ?? "";
    // Preserve any <f> formula inside — never overwrite it.
    const existingFormula = prevInner.match(/<f[^>]*>[\s\S]*?<\/f>/)?.[0];
    if (existingFormula || isFormula) return rowXml;

    const newAttrs = kind === "s"
      ? openAttrs.replace(/\s*t="[^"]*"/, "") + ' t="s"'
      : openAttrs.replace(/\s*t="[^"]*"/, "");
    const inner = kind === "s"
      ? `<v>${valueOrIndex}</v>`
      : `<v>${valueOrIndex}</v>`;
    return rowXml.replace(match[0], `${newAttrs}>${inner}</c>`);
  }
  // Insert before </row>; the lack of a style attribute means Excel uses the default.
  const inner = kind === "s" ? `<v>${valueOrIndex}</v>` : `<v>${valueOrIndex}</v>`;
  const t = kind === "s" ? ` t="s"` : "";
  const newCell = `<c r="${ref}"${t}>${inner}</c>`;
  return rowXml.replace(/<\/row>$/, `${newCell}</row>`);
}

const COLUMN_PLAN: { col: string; field: keyof InvoiceFields; kind: "string" | "number" | "integer" }[] = [
  { col: "A", field: "buyerCode", kind: "string" },
  { col: "B", field: "contractNo", kind: "string" },
  { col: "C", field: "contractDate", kind: "string" },
  { col: "D", field: "hmOrderNo", kind: "string" },
  { col: "E", field: "styleNo", kind: "string" },
  { col: "F", field: "unitPrice", kind: "number" },
  { col: "G", field: "descriptionOfGoods", kind: "string" },
  { col: "H", field: "category", kind: "string" },
  { col: "I", field: "hsCode", kind: "string" },
  { col: "J", field: "invoiceNumber", kind: "string" },
  { col: "K", field: "marketCode", kind: "string" },
  { col: "L", field: "totalCartons", kind: "integer" },
  { col: "M", field: "quantityPcs", kind: "integer" },
  { col: "N", field: "netWeightKg", kind: "number" },
  { col: "O", field: "grossWeightKg", kind: "number" },
  { col: "P", field: "expNo", kind: "string" },
  { col: "Q", field: "expDate", kind: "string" },
];

export interface ZipWriteResult {
  buffer: Buffer;
  inputRow: number;
  fieldsWritten: string[];
}

/**
 * Patch a template xlsx with the invoice's values. Images, drawings, styles,
 * merged cells, formulas (column R) and all other sheets are preserved
 * byte-for-byte.
 */
export async function patchTemplate(templatePath: string, inv: InvoiceFields): Promise<ZipWriteResult | null> {
  if (!templatePath || !existsSync(templatePath)) return null;
  const buf = await readFile(templatePath);
  const zip = await JSZip.loadAsync(buf);

  const sheetPath = await resolveSheetXmlPath(zip, "PAYMENT INVOICE");
  if (!sheetPath || !zip.file(sheetPath)) return null;

  const ssFile = zip.file("xl/sharedStrings.xml");
  if (!ssFile) return null;
  const ss = new SharedStrings(await ssFile.async("string"));
  let sheetXml = await zip.file(sheetPath)!.async("string");

  const inputRow = findInputRow(sheetXml, ss);
  if (!inputRow) return null;

  // Isolate the row's XML so cell patches don't accidentally touch other rows.
  // Must match ONLY the real content row — anchor on both the opening `<row …>`
  // (not self-closing) and the matching `</row>`.
  const rowRe = new RegExp(`<row[^>]*\\br="${inputRow}"[^>]*?>[\\s\\S]*?<\\/row>`);
  const rowMatch = sheetXml.match(rowRe);
  if (!rowMatch) return null;
  let rowXml = rowMatch[0];

  const fieldsWritten: string[] = [];
  for (const spec of COLUMN_PLAN) {
    const raw = (inv as unknown as Record<string, unknown>)[spec.field];
    if (raw == null || raw === "") continue;
    const ref = `${spec.col}${inputRow}`;
    if (spec.kind === "integer" || spec.kind === "number") {
      const n = spec.kind === "integer" ? Number.parseInt(String(raw), 10) : Number.parseFloat(String(raw));
      if (!Number.isFinite(n)) continue;
      rowXml = setCell(rowXml, ref, "n", n);
    } else {
      const idx = ss.indexOf(String(raw));
      rowXml = setCell(rowXml, ref, "s", idx);
    }
    fieldsWritten.push(spec.field);
  }

  sheetXml = sheetXml.replace(rowRe, rowXml);
  zip.file(sheetPath, sheetXml);
  zip.file("xl/sharedStrings.xml", ss.render());

  const out = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  return { buffer: out, inputRow, fieldsWritten };
}
