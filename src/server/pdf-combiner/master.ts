/**
 * PDF Combiner — master Excel parsing (pure, side-effect-free).
 *
 * Master format (one output PDF per data row, files merged left → right):
 *
 *   | Output PDF Name | File 1        | File 2              | File 3 | …
 *   | 45237 OB        | 45237 OB.pdf  | FolderA/FCR 991.pdf | BE 12  |
 *
 * - The header row is optional. A first row is treated as a header when it has
 *   a cell like "Output…", "PDF Name", "File 1", "SL" (see HEADER_RE).
 * - The "Output PDF Name" column is optional; without it the output is named
 *   `Row_<excel row number>.pdf`.
 * - SL / serial columns are ignored.
 * - A file cell may be a bare file name ("x.pdf" or "x" — `.pdf` is assumed),
 *   or a folder-qualified path ("FolderA/sub/x.pdf") to disambiguate.
 */

export interface MasterRow {
  /** 1-based row number in the sheet (what the user sees in Excel). */
  rowNo: number;
  /** Requested output name (sanitised later); empty when not supplied. */
  outputName: string;
  /** File references in merge order. */
  files: string[];
}

export interface MasterParseResult {
  rows: MasterRow[];
  hasHeader: boolean;
  outputColumn: number | null;
  warnings: string[];
}

const HEADER_RE = /^(output.*|pdf\s*name.*|combined.*|merged?.*|file\s*(name)?\s*-?\s*\d*|sl\.?|s\/?l\.?|serial(\s*no\.?)?|#|no\.?)$/i;
const OUTPUT_HEADER_RE = /^(output|pdf\s*name|combined|merged|result)/i;
const SERIAL_HEADER_RE = /^(sl\.?|s\/?l\.?|serial(\s*no\.?)?|#|no\.?)$/i;

/** Parse a 2-D grid of cell texts (row-major, already stringified). */
export function parseMasterGrid(grid: (string | null | undefined)[][], startRowNo = 1): MasterParseResult {
  const warnings: string[] = [];
  const clean = grid.map((r) => r.map((c) => (c ?? "").toString().trim()));

  // First non-empty row decides the header.
  const firstIdx = clean.findIndex((r) => r.some((c) => c !== ""));
  if (firstIdx < 0) return { rows: [], hasHeader: false, outputColumn: null, warnings: ["Master sheet is empty."] };

  const first = clean[firstIdx];
  const hasHeader = first.some((c) => c !== "" && !/\.pdf$/i.test(c) && HEADER_RE.test(c));
  let outputColumn: number | null = null;
  const ignored = new Set<number>();

  if (hasHeader) {
    first.forEach((c, i) => {
      if (outputColumn === null && OUTPUT_HEADER_RE.test(c)) outputColumn = i;
      else if (SERIAL_HEADER_RE.test(c)) ignored.add(i);
    });
  }

  const rows: MasterRow[] = [];
  const dataStart = hasHeader ? firstIdx + 1 : firstIdx;
  for (let r = dataStart; r < clean.length; r++) {
    const cells = clean[r];
    if (!cells.some((c) => c !== "")) continue;
    const outputName = outputColumn !== null ? cells[outputColumn] ?? "" : "";
    const files = cells.filter((c, i) => i !== outputColumn && !ignored.has(i) && c !== "");
    rows.push({ rowNo: r + startRowNo, outputName, files });
  }

  if (!hasHeader) warnings.push("No header row detected — every non-empty cell is treated as a file name.");
  return { rows, hasHeader, outputColumn, warnings };
}

/** Normalise a file reference for matching: slashes, case, `.pdf` extension. */
export function normalizeRef(ref: string): string {
  let s = ref.trim().replace(/\\/g, "/").replace(/^\.?\/+/, "").replace(/\/+/g, "/").toLowerCase();
  if (!s.endsWith(".pdf")) s += ".pdf";
  return s;
}

/** Make a safe, Windows-legal output file name ending in `.pdf`. */
export function sanitizeOutputName(name: string, rowNo: number): string {
  let base = name.trim().replace(/\.pdf$/i, "");
  base = base.replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "_").replace(/\s+/g, " ").replace(/^[.\s]+|[.\s]+$/g, "");
  if (!base) base = `Row_${rowNo}`;
  return `${base.slice(0, 150)}.pdf`;
}

/** Ensure unique output names inside one run: "x.pdf", "x (2).pdf", … */
export function uniqueNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((n) => {
    const key = n.toLowerCase();
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    return count === 1 ? n : n.replace(/\.pdf$/i, ` (${count}).pdf`);
  });
}
