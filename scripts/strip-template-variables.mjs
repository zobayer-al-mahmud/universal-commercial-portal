/**
 * Strip order-specific variable data from each customs-invoice template.
 *
 * Every template has a "PAYMENT INVOICE" sheet whose "input row" (row number
 * varies, 72-84) holds the per-order values in columns A-Q. The rest of the
 * invoice pulls from that row via formulas, so clearing those 17 cells leaves
 * a blank-but-ready template. Column R (=F*M formula) and all other sheets,
 * styles, images, drawings, country-specific text and bank details stay
 * untouched byte-for-byte (surgical zip-level patch — same approach as
 * src/server/customs-invoice/zip-write.ts).
 *
 * Originals are copied to var/storage/customs-invoice-templates/.originals/
 * before modification so this is reversible.
 *
 * Usage: node scripts/strip-template-variables.mjs [--dry-run]
 */
import JSZip from "jszip";
import { readFile, writeFile, mkdir, copyFile, readdir } from "fs/promises";
import { existsSync } from "fs";
import { join, basename } from "path";

const TEMPLATE_DIR = "var/storage/customs-invoice-templates";
const BACKUP_DIR = join(TEMPLATE_DIR, ".originals");
const DRY_RUN = process.argv.includes("--dry-run");

// Columns on the input row that hold per-order variable data.
// Must match COLUMN_PLAN in src/server/customs-invoice/zip-write.ts.
const VARIABLE_COLS = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O", "P", "Q"];

function decodeXmlEntities(s) {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

/** Return the sheet XML path for the first sheet whose name contains the
 *  given pattern (case-insensitive). Picks "PAYMENT INVOICE" exactly first,
 *  then any sheet whose name ends with "PAYMENT INVOICE" (e.g. "TR-PAYMENT
 *  INVOICE"). */
async function resolveSheetXmlPath(zip, needle) {
  const workbook = await zip.file("xl/workbook.xml")?.async("string");
  const rels = await zip.file("xl/_rels/workbook.xml.rels")?.async("string");
  if (!workbook || !rels) return null;
  const sheets = [...workbook.matchAll(/<sheet\s+([^>]+?)\/?>/g)].map((m) => m[1]);
  const needleUp = needle.toUpperCase();
  const pick = (predicate) => sheets.find((attrs) => {
    const name = attrs.match(/name="([^"]+)"/)?.[1] ?? "";
    return predicate(name.toUpperCase());
  });
  const sheetAttrs =
    pick((n) => n === needleUp) ||
    pick((n) => n.endsWith(needleUp)) ||
    pick((n) => n.includes(needleUp));
  if (!sheetAttrs) return null;
  const rId = sheetAttrs.match(/r:id="([^"]+)"/)?.[1];
  if (!rId) return null;
  const relAttrs = [...rels.matchAll(/<Relationship\s+([^>]+?)\/?>/g)]
    .map((m) => m[1])
    .find((attrs) => new RegExp(`Id="${rId}"`).test(attrs));
  if (!relAttrs) return null;
  const target = relAttrs.match(/Target="([^"]+)"/)?.[1];
  if (!target) return null;
  return `xl/${target}`;
}

/** Collect shared-string indexes whose text is a bare AGL/H&M contract ref. */
function bareRefIndices(sstXml) {
  const idx = [];
  const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m;
  let i = 0;
  while ((m = siRe.exec(sstXml)) != null) {
    const raw = m[1];
    const runs = [...raw.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => decodeXmlEntities(x[1]));
    const text = runs.length ? runs.join("") : raw.replace(/<[^>]+>/g, "");
    if (/^AGL\/H&M\/\d+\/\d{4}$/i.test(text.trim())) idx.push(i);
    i++;
  }
  return idx;
}

/** Find the input row — the row whose cell holds a bare contract-ref shared-string. */
function findInputRow(sheetXml, refIndices) {
  if (refIndices.length === 0) return null;
  const rowRe = /<row[^>]*\br="(\d+)"[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g;
  const candidates = [];
  for (const m of sheetXml.matchAll(rowRe)) {
    const body = m[2] ?? "";
    if (!body) continue;
    const rowNum = parseInt(m[1], 10);
    for (const idx of refIndices) {
      if (new RegExp(`<c\\b[^>]*t="s"[^>]*><v>${idx}<\\/v>`).test(body)) {
        candidates.push(rowNum);
        break;
      }
    }
  }
  if (candidates.length === 0) return null;
  return Math.max(...candidates);
}

/**
 * Clear the value of a single cell in `rowXml` while preserving its style
 * attribute, formulas (if any) and the cell's position. Removes the `<v>`
 * element only — leaves `<f>` alone (so column R's =F*M stays). If the cell
 * doesn't exist, no-op.
 */
function clearCellValue(rowXml, ref) {
  const re = new RegExp(`(<c\\b[^>]*\\br="${ref}"[^>]*?)(?:/>|>([\\s\\S]*?)<\\/c>)`);
  const m = re.exec(rowXml);
  if (!m) return rowXml;
  const openAttrs = m[1];
  const inner = m[2] ?? "";
  // If the cell is a formula cell, don't touch it — the formula owns the value.
  if (/<f[^>]*>/.test(inner)) return rowXml;
  // Preserve style (s="..."), drop type attribute (t="..."), drop value.
  const cleanedAttrs = openAttrs.replace(/\s*t="[^"]*"/, "");
  return rowXml.replace(m[0], `${cleanedAttrs}/>`);
}

async function stripOne(path) {
  const buf = await readFile(path);
  const zip = await JSZip.loadAsync(buf);

  const sheetPath = await resolveSheetXmlPath(zip, "PAYMENT INVOICE");
  if (!sheetPath || !zip.file(sheetPath)) return { ok: false, reason: "no PAYMENT INVOICE sheet" };

  const sstFile = zip.file("xl/sharedStrings.xml");
  if (!sstFile) return { ok: false, reason: "no sharedStrings.xml" };
  const sstXml = await sstFile.async("string");
  const refIdx = bareRefIndices(sstXml);
  if (refIdx.length === 0) return { ok: false, reason: "no bare AGL/H&M ref" };

  let sheetXml = await zip.file(sheetPath).async("string");
  const inputRow = findInputRow(sheetXml, refIdx);
  if (!inputRow) return { ok: false, reason: "no input row" };

  const rowRe = new RegExp(`<row[^>]*\\br="${inputRow}"[^>]*?>[\\s\\S]*?<\\/row>`);
  const rowMatch = sheetXml.match(rowRe);
  if (!rowMatch) return { ok: false, reason: "could not isolate input row" };

  let rowXml = rowMatch[0];
  const cleared = [];
  for (const col of VARIABLE_COLS) {
    const ref = `${col}${inputRow}`;
    const next = clearCellValue(rowXml, ref);
    if (next !== rowXml) cleared.push(ref);
    rowXml = next;
  }

  sheetXml = sheetXml.replace(rowRe, rowXml);
  zip.file(sheetPath, sheetXml);

  const out = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  return { ok: true, inputRow, cleared, buffer: out };
}

async function main() {
  if (!existsSync(TEMPLATE_DIR)) {
    console.error(`Template dir not found: ${TEMPLATE_DIR}`);
    process.exit(1);
  }

  const files = (await readdir(TEMPLATE_DIR)).filter((n) => n.toLowerCase().endsWith(".xlsx"));
  console.log(`Found ${files.length} template(s) in ${TEMPLATE_DIR}`);
  if (DRY_RUN) console.log("(dry run — no files will be modified)");

  if (!DRY_RUN) await mkdir(BACKUP_DIR, { recursive: true });

  const summary = { stripped: 0, skipped: 0, failed: 0, totalCleared: 0 };
  for (const name of files) {
    const full = join(TEMPLATE_DIR, name);
    try {
      const r = await stripOne(full);
      if (!r.ok) {
        console.log(`  SKIP ${name} — ${r.reason}`);
        summary.skipped++;
        continue;
      }
      console.log(`  OK   ${name} — row ${r.inputRow}, cleared ${r.cleared.length} cells: ${r.cleared.join(",")}`);
      summary.stripped++;
      summary.totalCleared += r.cleared.length;
      if (!DRY_RUN) {
        const backup = join(BACKUP_DIR, name);
        if (!existsSync(backup)) await copyFile(full, backup);
        await writeFile(full, r.buffer);
      }
    } catch (e) {
      console.log(`  FAIL ${name} — ${e.message}`);
      summary.failed++;
    }
  }
  console.log(`\nDone. stripped=${summary.stripped} skipped=${summary.skipped} failed=${summary.failed} totalCellsCleared=${summary.totalCleared}`);
  console.log(DRY_RUN ? "(dry run — no files changed)" : `Originals backed up to ${BACKUP_DIR}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
