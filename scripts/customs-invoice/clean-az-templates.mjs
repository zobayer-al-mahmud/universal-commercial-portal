// One-shot cleaner for the two AZ customs-invoice templates. Reads the raw
// user files from D:\UCP, clears the hidden data row (row 72) and the visible
// country-specific hardcoded sample cells, then writes the stripped templates
// into templates/customs-invoice/ bundled with the repo. Preserves logo,
// exporter/buyer blocks, every label, and all formulas.
import JSZip from "jszip";
import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const OUT_DIR = join(REPO_ROOT, "templates", "customs-invoice");

// Row 72 is the hidden data row driving the visible invoice via formulas.
// Clearing every A..Q cell on it blanks every auto-populated visible cell.
const DATA_ROW = 72;
const DATA_COLS = ["A","B","C","D","E","F","G","H","I","J","K","L","M","N","O","P","Q"];

// Visible WYSIWYG cells with hardcoded country-specific (Azerbaijan) sample
// text. Clearing them makes the two templates serve as a neutral base — the
// user fills them in manually (or future writer upgrades push the values in).
// Labels and headers are NOT in this list and stay as-is.
const VISIBLE_CLEAR = [
  // Country-code label at the top of the invoice header.
  "I10",
  // Consignee address lines.
  "A23", "A24", "A25",
  // Cargo delivery address lines.
  "G17", "G18", "G19",
  // Country of final destination value.
  "J24",
  // Port of discharge / Place of delivery values.
  "A30", "D30",
  // Market sub-code label in the goods block.
  "A37",
  // Country code column labels in the goods / weights tables.
  "G38", "A50",
  // Dimension value.
  "E53",
];

/** Clear one cell inside a row's XML. Formulas inside the cell are preserved
 *  (we only strip the <v> value); plain data cells are reduced to an empty
 *  "<c r=... s=...>" so Excel keeps the style but shows blank. */
function clearCellInRow(rowXml, ref) {
  const cellRe = new RegExp(`(<c\\b[^>]*\\br="${ref}"[^>]*?)(?:/>|>([\\s\\S]*?)</c>)`);
  const m = rowXml.match(cellRe);
  if (!m) return rowXml;
  const openAttrs = m[1];
  const inner = m[2] ?? "";
  const existingFormula = inner.match(/<f[^>]*>[\s\S]*?<\/f>/)?.[0] ?? "";
  // Drop t="s" (shared-string) type so a cleared string cell becomes an empty
  // numeric/blank cell; keep whatever style attribute Excel assigned.
  const cleanedAttrs = openAttrs.replace(/\s*t="[^"]*"/, "");
  if (existingFormula) {
    // Preserve the formula; drop any cached <v>.
    return rowXml.replace(m[0], `${cleanedAttrs}>${existingFormula}</c>`);
  }
  return rowXml.replace(m[0], `${cleanedAttrs}/>`);
}

/** Replace one cell (anywhere in sheetXml) by looking up its row first. */
function clearCellInSheet(sheetXml, ref) {
  const row = parseInt(ref.match(/\d+$/)?.[0] ?? "0", 10);
  if (!row) return sheetXml;
  const rowRe = new RegExp(`<row[^>]*\\br="${row}"[^>]*?>[\\s\\S]*?</row>`);
  const rowMatch = sheetXml.match(rowRe);
  if (!rowMatch) return sheetXml;
  const next = clearCellInRow(rowMatch[0], ref);
  if (next === rowMatch[0]) return sheetXml;
  return sheetXml.replace(rowRe, next);
}

async function clean(src, outName) {
  console.log(`\n--- ${src}`);
  const buf = await readFile(src);
  const zip = await JSZip.loadAsync(buf);
  // Sheet 1 is the TR-PAYMENT INVOICE sheet (confirmed by inspection; both
  // files share the same workbook layout).
  const sheetPath = "xl/worksheets/sheet1.xml";
  let sheetXml = await zip.file(sheetPath).async("string");

  // 1. Clear the hidden data row A72..Q72.
  for (const col of DATA_COLS) {
    sheetXml = clearCellInSheet(sheetXml, `${col}${DATA_ROW}`);
  }
  // 2. Clear the visible country-specific sample cells.
  for (const ref of VISIBLE_CLEAR) {
    sheetXml = clearCellInSheet(sheetXml, ref);
  }

  zip.file(sheetPath, sheetXml);
  // calcChain references cells by row; blanking cells leaves stale entries
  // which Excel repairs silently on open. Dropping it entirely is safest.
  if (zip.file("xl/calcChain.xml")) zip.remove("xl/calcChain.xml");

  const out = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  if (!existsSync(OUT_DIR)) await mkdir(OUT_DIR, { recursive: true });
  const outPath = join(OUT_DIR, outName);
  await writeFile(outPath, out);
  console.log(`wrote ${outPath} (${out.length} bytes)`);
}

await clean("D:/UCP/0000 AZ.xlsx", "0000 AZ.xlsx");
await clean("D:/UCP/0000 AZ Pack.xlsx", "0000 AZ Pack.xlsx");
console.log("\nDone.");
