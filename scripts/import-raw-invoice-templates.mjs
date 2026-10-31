/**
 * Import the country-wise raw invoice templates into the backend.
 *
 * Source: a folder with filenames in the pattern
 *   `<invoiceNo> <countryCode>[(variant)].xlsx`
 *   (e.g. `0000 AU.xlsx`, `0000 OF-(IT).xlsx`, `0000 OE ( PLW067).xlsx`,
 *    `0000 EN Pack.xlsx`, `0000 US-022.xlsx`)
 *
 * For every file:
 *   1. Validate the filename against the resolver pattern
 *      (so the country / sub-code lookup can place it).
 *   2. Strip variable per-order data from the "PAYMENT INVOICE" input row
 *      (A..Q cells on the row that carries a bare AGL/H&M contract reference)
 *      — same surgical zip-level patch as scripts/strip-template-variables.mjs,
 *      so every other sheet, style, image, drawing, country-specific text and
 *      bank detail stays byte-for-byte intact. **Fields stay, data is cleared.**
 *   3. Copy the stripped bytes to STORAGE_ROOT/customs-invoice-templates/
 *      under the original filename. Files that already exist are overwritten
 *      only when `--force` is passed.
 *
 * Files whose names don't parse, or that have no PAYMENT INVOICE sheet / no
 * AGL/H&M ref (e.g. the RAW INV SEDULE FORMAT file), are reported and skipped;
 * they are never copied, so the backend only ever sees usable invoice templates.
 *
 * Usage:
 *   node scripts/import-raw-invoice-templates.mjs \
 *        "D:/UCP/automation docs/New folder/RAW INVOICE FORMAT Desktop" \
 *        [--force] [--dry-run]
 */
import JSZip from "jszip";
import { readFile, writeFile, mkdir, readdir, stat } from "fs/promises";
import { existsSync } from "fs";
import { join, basename } from "path";
import { fileURLToPath } from "url";

// -------- CLI -----------------------------------------------------------------
const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const positional = args.filter((a) => !a.startsWith("--"));
const SRC = positional[0] ?? "D:/UCP/automation docs/New folder/RAW INVOICE FORMAT Desktop";
const DRY = flags.has("--dry-run");
const FORCE = flags.has("--force");

const DEST = join(process.cwd(), "var", "storage", "customs-invoice-templates");

// Columns on the PAYMENT INVOICE input row that hold per-order variable data.
// Matches COLUMN_PLAN in src/server/customs-invoice/zip-write.ts.
const VARIABLE_COLS = ["A","B","C","D","E","F","G","H","I","J","K","L","M","N","O","P","Q"];

// -------- helpers (same spirit as scripts/strip-template-variables.mjs) ------
function decodeXmlEntities(s) {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

/** `<invoiceNo> <countryCode>[(variant)].xlsx` → parsed, or null when the name
 *  does not match. Mirrors parseTemplateFilename in
 *  src/server/customs-invoice/templates.ts — kept here as JS so this script
 *  does not need to boot the TS compiler. */
function parseTemplateFilename(filename) {
  if (!filename.toLowerCase().endsWith(".xlsx")) return null;
  const base = filename.replace(/\.xlsx$/i, "");
  const m = base.match(/^(\d{3,})\s+(.+)$/);
  if (!m) return null;
  const invoiceNoPrefix = m[1];
  const rest = m[2].trim();

  let code = "";
  let variant = "";
  const paren = rest.match(/^([^(]+?)\s*\(\s*([^)]+)\s*\)\s*$/);
  if (paren) {
    code = paren[1].trim();
    variant = paren[2].trim();
    if (code.endsWith("-")) { code = code + variant; variant = ""; }
  } else if (rest.includes(" ")) {
    const [first, ...tail] = rest.split(/\s+/);
    code = first;
    variant = tail.join(" ").trim();
  } else {
    code = rest;
  }
  code = code.replace(/[()]/g, "").replace(/^-|-$/g, "").trim();
  variant = variant.replace(/[()]/g, "").trim();
  if (!code) return null;
  return { invoiceNoPrefix, countryCode: code.toUpperCase(), variant: variant.toUpperCase() };
}

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

function clearCellValue(rowXml, ref) {
  const re = new RegExp(`(<c\\b[^>]*\\br="${ref}"[^>]*?)(?:/>|>([\\s\\S]*?)<\\/c>)`);
  const m = re.exec(rowXml);
  if (!m) return rowXml;
  const openAttrs = m[1];
  const inner = m[2] ?? "";
  // Formula cells (e.g. column R's =F*M) keep their formula — don't touch them.
  if (/<f[^>]*>/.test(inner)) return rowXml;
  // Preserve style (s="..."), drop type attribute (t="..."), drop value.
  const cleanedAttrs = openAttrs.replace(/\s*t="[^"]*"/, "");
  return rowXml.replace(m[0], `${cleanedAttrs}/>`);
}

async function stripBuffer(buf) {
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

// -------- main ----------------------------------------------------------------
async function main() {
  if (!existsSync(SRC)) {
    console.error(`Source folder not found: ${SRC}`);
    process.exit(1);
  }

  if (!DRY) await mkdir(DEST, { recursive: true });

  const entries = await readdir(SRC);
  const xlsx = entries
    .filter((n) => n.toLowerCase().endsWith(".xlsx"))
    .filter((n) => !n.startsWith("~$"));

  console.log(`Source : ${SRC}`);
  console.log(`Target : ${DEST}`);
  console.log(`Files  : ${xlsx.length} .xlsx (ignoring ~$ lock files)`);
  console.log(DRY ? "(dry-run — nothing will be written)" : FORCE ? "(force — existing files will be overwritten)" : "(skip when a target file already exists)");
  console.log("");

  const summary = { imported: 0, strippedCells: 0, overwritten: 0, skippedExisting: 0, badName: 0, noPaymentSheet: 0, failed: 0 };

  for (const name of xlsx) {
    const parsed = parseTemplateFilename(name);
    if (!parsed) {
      console.log(`  SKIP  ${name}  — filename does not match <invoiceNo> <countryCode>[(variant)].xlsx`);
      summary.badName++;
      continue;
    }
    const targetPath = join(DEST, name);
    const exists = existsSync(targetPath);
    if (exists && !FORCE) {
      console.log(`  KEEP  ${name}  — already in backend (pass --force to overwrite)`);
      summary.skippedExisting++;
      continue;
    }
    try {
      const buf = await readFile(join(SRC, name));
      const r = await stripBuffer(buf);
      if (!r.ok) {
        console.log(`  SKIP  ${name}  — ${r.reason}`);
        summary.noPaymentSheet++;
        continue;
      }
      if (!DRY) await writeFile(targetPath, r.buffer);
      summary.imported++;
      summary.strippedCells += r.cleared.length;
      if (exists) summary.overwritten++;
      console.log(`  OK    ${name}  → ${parsed.countryCode}${parsed.variant ? " · " + parsed.variant : ""} (row ${r.inputRow}, cleared ${r.cleared.length} cells)`);
    } catch (e) {
      console.log(`  FAIL  ${name}  — ${e.message}`);
      summary.failed++;
    }
  }

  console.log("");
  console.log(`Imported            : ${summary.imported}`);
  console.log(`  overwritten       : ${summary.overwritten}`);
  console.log(`  cells cleared     : ${summary.strippedCells}`);
  console.log(`Skipped (existing)  : ${summary.skippedExisting}`);
  console.log(`Skipped (bad name)  : ${summary.badName}`);
  console.log(`Skipped (no sheet)  : ${summary.noPaymentSheet}`);
  console.log(`Failed              : ${summary.failed}`);
  if (DRY) console.log("(dry-run — no files were written)");
}

main().catch((e) => { console.error(e); process.exit(1); });
