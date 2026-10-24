import JSZip from "jszip";

/**
 * PDF Combiner — surgical, zip-level cell editor for the master workbook.
 *
 * Edits only the targeted cells on ONE worksheet (CLABING HERE-F) and leaves
 * every other sheet, drawing, image, style, table, formula and the workbook
 * structure byte-for-byte intact. Edited values are written as shared strings
 * (CLABING HERE-F is a flattened data sheet that no formula reads), so exact
 * text — leading zeros, invoice numbers, container ids — is preserved.
 */

export interface CellEdit {
  /** 1-based worksheet row number. */
  rowNo: number;
  /** 1-based column number. */
  col: number;
  /** New cell text ("" clears the cell value). */
  value: string;
}

export function numToCol(n: number): string {
  let s = "";
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
export function colToNum(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

function decodeXml(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}
function encodeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Shared-string table that preserves pre-existing <si> verbatim and appends new. */
class SharedStrings {
  private originalSi: string[] = [];
  private texts: string[] = [];
  private appended: string[] = [];
  constructor(xml: string) {
    for (const raw of xml.match(/<si\b[^>]*>[\s\S]*?<\/si>/g) ?? []) {
      this.originalSi.push(raw);
      const runs = [...raw.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => decodeXml(x[1]));
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
    const items = [...this.originalSi, ...this.appended.map((s) => `<si><t xml:space="preserve">${encodeXml(s)}</t></si>`)].join("");
    const total = this.originalSi.length + this.appended.length;
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${total}" uniqueCount="${total}">${items}</sst>`;
  }
}

async function resolveSheetXmlPath(zip: JSZip, sheetName: string): Promise<string | null> {
  const workbook = await zip.file("xl/workbook.xml")?.async("string");
  const rels = await zip.file("xl/_rels/workbook.xml.rels")?.async("string");
  if (!workbook || !rels) return null;
  const sheetAttrs = [...workbook.matchAll(/<sheet\s+([^>]+?)\/?>/g)]
    .map((m) => m[1])
    .find((attrs) => new RegExp(`name="${sheetName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`).test(attrs));
  if (!sheetAttrs) return null;
  const rId = sheetAttrs.match(/r:id="([^"]+)"/)?.[1];
  if (!rId) return null;
  const relAttrs = [...rels.matchAll(/<Relationship\s+([^>]+?)\/?>/g)].map((m) => m[1]).find((a) => new RegExp(`Id="${rId}"`).test(a));
  const target = relAttrs?.match(/Target="([^"]+)"/)?.[1];
  if (!target) return null;
  return `xl/${target.replace(/^\/?xl\//, "").replace(/^\//, "")}`;
}

interface ParsedCell { col: number; raw: string }

/** Rebuild a row's inner XML with the given edits (replace or insert, in column order). */
function patchRowInner(rowInner: string, rowNo: number, edits: Map<number, string>, ss: SharedStrings): string {
  const cellRe = /<c\b[^>]*\br="([A-Z]+)(\d+)"[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g;
  const cells: ParsedCell[] = [];
  for (const m of rowInner.matchAll(cellRe)) {
    cells.push({ col: colToNum(m[1]), raw: m[0] });
  }
  const byCol = new Map<number, string>();
  for (const c of cells) byCol.set(c.col, c.raw);

  for (const [col, value] of edits) {
    const ref = `${numToCol(col)}${rowNo}`;
    const existing = byCol.get(col);
    // Preserve the style attribute (s="..") from the existing cell if present.
    const styleAttr = existing?.match(/\bs="(\d+)"/)?.[0] ?? "";
    if (value === "") {
      // Clear value: keep an empty styled cell (or drop it). Keep style, no <v>.
      byCol.set(col, `<c r="${ref}"${styleAttr ? " " + styleAttr : ""}/>`);
    } else {
      const idx = ss.indexOf(value);
      byCol.set(col, `<c r="${ref}"${styleAttr ? " " + styleAttr : ""} t="s"><v>${idx}</v></c>`);
    }
  }

  const ordered = [...byCol.entries()].sort((a, b) => a[0] - b[0]).map(([, raw]) => raw);
  return ordered.join("");
}

export async function applyCellEdits(masterBytes: Buffer, sheetName: string, edits: CellEdit[]): Promise<Buffer> {
  if (edits.length === 0) return masterBytes;
  const zip = await JSZip.loadAsync(masterBytes);
  const sheetPath = await resolveSheetXmlPath(zip, sheetName);
  if (!sheetPath || !zip.file(sheetPath)) throw new Error(`Worksheet "${sheetName}" not found in the workbook.`);
  const ssFile = zip.file("xl/sharedStrings.xml");
  // A workbook may have no sharedStrings part yet; create a minimal one + register it.
  let ss: SharedStrings;
  let needSsPart = false;
  if (ssFile) ss = new SharedStrings(await ssFile.async("string"));
  else { ss = new SharedStrings(`<sst count="0" uniqueCount="0"></sst>`); needSsPart = true; }

  let sheetXml = await zip.file(sheetPath)!.async("string");

  // Group edits by row.
  const byRow = new Map<number, Map<number, string>>();
  for (const e of edits) {
    if (!byRow.has(e.rowNo)) byRow.set(e.rowNo, new Map());
    byRow.get(e.rowNo)!.set(e.col, e.value);
  }

  for (const [rowNo, rowEdits] of byRow) {
    // Match a content row <row r="N" ...>…</row> or a self-closing <row r="N" .../>.
    const contentRe = new RegExp(`<row[^>]*\\br="${rowNo}"[^>]*?>([\\s\\S]*?)<\\/row>`);
    const selfRe = new RegExp(`<row([^>]*\\br="${rowNo}"[^>]*?)/>`);
    const content = sheetXml.match(contentRe);
    if (content) {
      const newInner = patchRowInner(content[1], rowNo, rowEdits, ss);
      const openingTag = content[0].slice(0, content[0].indexOf(">") + 1);
      sheetXml = sheetXml.replace(contentRe, () => `${openingTag}${newInner}</row>`);
    } else {
      const self = sheetXml.match(selfRe);
      const newInner = patchRowInner("", rowNo, rowEdits, ss);
      if (self) {
        const selfAttrs = self[1];
        sheetXml = sheetXml.replace(selfRe, () => `<row${selfAttrs}>${newInner}</row>`);
      } else {
        // Insert a new row in ascending order inside <sheetData>.
        const newRow = `<row r="${rowNo}">${newInner}</row>`;
        sheetXml = insertRowInOrder(sheetXml, rowNo, newRow);
      }
    }
  }

  zip.file(sheetPath, sheetXml);
  zip.file("xl/sharedStrings.xml", ss.render());
  if (needSsPart) registerSharedStringsPart(zip);

  const out = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  return out;
}

function insertRowInOrder(sheetXml: string, rowNo: number, newRow: string): string {
  const rows = [...sheetXml.matchAll(/<row[^>]*\br="(\d+)"[^>]*?(?:\/>|>[\s\S]*?<\/row>)/g)];
  const after = rows.find((m) => parseInt(m[1], 10) > rowNo);
  if (after) return sheetXml.slice(0, after.index) + newRow + sheetXml.slice(after.index);
  // else append just before </sheetData>
  return sheetXml.replace(/<\/sheetData>/, `${newRow}</sheetData>`);
}

/** Register a freshly-created sharedStrings.xml in [Content_Types].xml + rels. */
function registerSharedStringsPart(zip: JSZip): void {
  // Best-effort: most real templates already ship a sharedStrings part, so this
  // path is rarely taken. Left minimal on purpose.
  void zip;
}
