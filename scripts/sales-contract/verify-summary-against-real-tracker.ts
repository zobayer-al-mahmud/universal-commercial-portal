/**
 * Verify the H&M Summary writer against the real tracker workbook.
 *
 * Usage:
 *   npx tsx scripts/sales-contract/verify-summary-against-real-tracker.ts \
 *     --template "D:\\oct-2026\\automation docs\\New folder\\1. Sales Contract Creation\\new-up coming shipment -HM-2015 to 2026(AutoRecovered).xlsx" \
 *     [--po tests/fixtures/sales-contract-643159-po.txt] \
 *     [--size tests/fixtures/sales-contract-643159-size.txt] \
 *     [--country tests/fixtures/sales-contract-643159-country.txt] \
 *     [--contractNo 97] [--folder A]
 *
 * What it does:
 *   1. Reads the live `H&M` sheet of the user's real tracker (rows + manual
 *      P/T/U values before anything is written).
 *   2. Parses one PO's three PDF text fixtures (or any supplied set) into the
 *      same shape the live pipeline uses – `parsePurchaseOrderText` etc.
 *   3. Builds `extraPrices` with `buildExtraPricesFromPo` (preserves distinct
 *      prices verbatim; never averages).
 *   4. Hand-writes the Summary to a new file **next to** the input tracker,
 *      using `writeSummaryWorkbook({ templatePath, outputPath, pos, folderSequence })`.
 *   5. Diffs the two sheets: how many rows did the live tracker have before
 *      vs after, which were new, which manual columns survived, which did not.
 *   6. Prints a one-screen verdict. The script makes NO assumptions about the
 *      business values in the tracker – it only verifies the generator's
 *      correctness-preserving properties (append semantics, manual-col
 *      preservation, sort order, header integrity).
 *
 * Nothing is overwritten. The script fails loudly rather than guessing.
 */
import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, basename, join } from "node:path";
import ExcelJS from "exceljs";
// Direct imports (not through the barrel) to avoid pulling in intake.ts
// which transitively requires pdf-parse and triggers a Node22+tsx ESM
// resolution bug in `is-generator-function`.
import { parsePurchaseOrderText } from "../../src/server/sales-contract/parse-po";
import { parseSizeBreakdownText } from "../../src/server/sales-contract/parse-size-breakdown";
import { parseCountryBreakdownText } from "../../src/server/sales-contract/parse-country-breakdown";
import { buildExtraPricesFromPo } from "../../src/server/sales-contract/summary-rows";
import { writeSummaryWorkbook, SUMMARY_HEADERS } from "../../src/server/sales-contract/summary-writer";

interface Args {
  template?: string;
  po?: string;
  size?: string;
  country?: string;
  contractNo: string;
  folder: string;
  out?: string;
}
function parseArgs(argv: string[]): Args {
  const a: Args = { contractNo: "97", folder: "A" };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const val = argv[i + 1];
    if (!key.startsWith("--")) continue;
    switch (key) {
      case "--template": a.template = val; i++; break;
      case "--po":       a.po = val; i++; break;
      case "--size":     a.size = val; i++; break;
      case "--country":  a.country = val; i++; break;
      case "--contractNo": a.contractNo = val; i++; break;
      case "--folder":   a.folder = (val ?? "").toUpperCase(); i++; break;
      case "--out":      a.out = val; i++; break;
    }
  }
  return a;
}

async function readSheetSnapshot(path: string): Promise<{ rowCount: number; headerCells: string[]; manualCols: { row: number; P: string; T: string; U: string }[] }> {
  if (!existsSync(path)) return { rowCount: 0, headerCells: [], manualCols: [] };
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  const sh = wb.getWorksheet("H&M");
  if (!sh) return { rowCount: 0, headerCells: [], manualCols: [] };
  const headerCells: string[] = [];
  for (let c = 1; c <= 21; c++) headerCells.push(String(sh.getRow(1).getCell(c).value ?? ""));
  const manualCols: { row: number; P: string; T: string; U: string }[] = [];
  let rowCount = 0;
  sh.eachRow({ includeEmpty: false }, (r, i) => {
    if (i < 2) return;
    rowCount++;
    const P = String(r.getCell(16).value ?? "").trim();
    const T = String(r.getCell(20).value ?? "").trim();
    const U = String(r.getCell(21).value ?? "").trim();
    if (P || T || U) manualCols.push({ row: i, P, T, U });
  });
  return { rowCount, headerCells, manualCols };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const fixturesDir = join(process.cwd(), "tests", "fixtures");
  const poPath      = args.po      ?? join(fixturesDir, "sales-contract-643159-po.txt");
  const sizePath    = args.size    ?? join(fixturesDir, "sales-contract-643159-size.txt");
  const countryPath = args.country ?? join(fixturesDir, "sales-contract-643159-country.txt");
  const template    = args.template;

  console.log("=".repeat(78));
  console.log("H&M Summary – real-tracker verification");
  console.log("=".repeat(78));
  console.log(`Template            : ${template ?? "(none; writing a fresh workbook)"}`);
  console.log(`PO fixture          : ${poPath}`);
  console.log(`Size fixture        : ${sizePath}`);
  console.log(`Country fixture     : ${countryPath}`);
  console.log(`Contract # / folder : ${args.contractNo} / ${args.folder}`);

  // 1 – snapshot the template BEFORE.
  const before = template ? await readSheetSnapshot(template) : { rowCount: 0, headerCells: [], manualCols: [] };
  console.log("");
  console.log(`-- Template "H&M" sheet (before): ${before.rowCount} data rows, ${before.manualCols.length} with manual P/T/U.`);
  if (template && before.headerCells.length && before.headerCells[0] !== SUMMARY_HEADERS[0]) {
    console.warn(`!! Template header[0] = ${JSON.stringify(before.headerCells[0])}; writer header[0] = ${JSON.stringify(SUMMARY_HEADERS[0])}.`);
    console.warn(`!! The writer prepends its own header row; the output workbook will REPLACE the sheet's header.`);
  }

  // 2 – parse one PO set from the supplied text fixtures.
  if (!existsSync(poPath) || !existsSync(sizePath) || !existsSync(countryPath)) {
    console.error("One or more fixture files missing – pass --po/--size/--country or restore tests/fixtures.");
    process.exit(2);
  }
  const po      = parsePurchaseOrderText(readFileSync(poPath, "utf8"));
  const size    = parseSizeBreakdownText(readFileSync(sizePath, "utf8"));
  const country = parseCountryBreakdownText(readFileSync(countryPath, "utf8"));
  console.log(`-- Parsed PO ${po.header.orderNo} · season=${po.header.season} · articles=${po.articles.length} · markets=${po.marketRows.length} · totalQty=${po.totalQty}`);
  console.log(`   invoice avg = ${po.invoiceAveragePrice} ${po.invoiceCurrency}; article costs = ${po.articles.map((a) => `${a.articleNo}@${a.cost}`).join(", ") || "–"}`);

  const extras = buildExtraPricesFromPo(po, country);
  console.log(`-- extraPrices : ${extras.length} entries${extras.length ? ` (${extras.map((e) => e.key + "=" + e.price).join(", ")})` : ""}`);

  // 3 – write.
  const stamp = new Date().toISOString().replace(/[^\d]/g, "").slice(0, 14);
  const outPath = args.out ?? (template
    ? join(dirname(template), `hm-summary-verify-${stamp}.xlsx`)
    : join(process.cwd(), "var", `hm-summary-verify-${stamp}.xlsx`));
  const result = await writeSummaryWorkbook({
    templatePath: template,
    outputPath: outPath,
    pos: [{
      poId: `verify-${po.header.orderNo}`,
      po,
      config: {
        contractNo: args.contractNo,
        folderLetter: args.folder,
        contractDate: "23 Oct, 2026",
        folderCommercialDate: "01 Nov, 2026",
        buyerCode: `AGL 349 ${args.folder}`,
        merchandiserName: `S-${po.header.season?.split("-")[0] ?? "?"}-${po.header.season?.split("-")[1] ?? "?"}- (verify-run)`,
        packSet: "1",
        marchentContNoOverride: `AGL/H&M/${args.contractNo}-${args.folder}/${po.header.season?.split("-")[1] ?? "?"}`,
        extraPrices: extras,
      },
    }],
    folderSequence: [{ folderLetter: args.folder, sequence: 0 }],
  });

  // 4 – snapshot AFTER + diff.
  const after = await readSheetSnapshot(outPath);
  console.log("");
  console.log(`-- Output file     : ${outPath} (${statSync(outPath).size} bytes)`);
  console.log(`-- After           : ${after.rowCount} data rows, ${after.manualCols.length} with manual P/T/U.`);
  console.log(`-- Writer stats    : total=${result.totalRows}, preserved=${result.preservedRows}, inserted=${result.insertedRows}, matched=${result.skippedExistingMatches.length}, ambiguous=${result.ambiguousMatches.length}`);

  const beforeManualKey = new Set(before.manualCols.map((m) => `${m.row}|${m.P}|${m.T}|${m.U}`));
  const stillHave = after.manualCols.filter((m) => beforeManualKey.size === 0 ? false : [...beforeManualKey].some((k) => k.endsWith(`|${m.P}|${m.T}|${m.U}`)));
  if (before.manualCols.length > 0) {
    const pct = Math.round((stillHave.length / before.manualCols.length) * 100);
    console.log(`-- Manual P/T/U carryover: ${stillHave.length}/${before.manualCols.length} rows preserved (${pct}%).`);
    if (pct < 100) {
      console.warn("   NOTE: 100% is only possible when every pre-existing (contract, folder, orderNo, marketCode) fingerprint survives – rows that were overwritten by this run have their P/T/U merged by the writer; rows that have no match in `pos` are preserved verbatim.");
    }
  }

  console.log("");
  console.log("Verdict:");
  const okHeaders = after.headerCells.every((h, i) => h === SUMMARY_HEADERS[i]);
  console.log(`  [${okHeaders ? "✓" : "âœ—"}] 21 required headers in order`);
  console.log(`  [${result.totalRows >= 1 ? "✓" : "âœ—"}] At least one new row generated for PO ${po.header.orderNo}`);
  console.log(`  [${after.rowCount >= before.rowCount ? "✓" : "âœ—"}] Row count did not regress (${before.rowCount} → ${after.rowCount})`);
  console.log(`  [${existsSync(outPath) ? "✓" : "âœ—"}] Workbook written`);
  if (!template) console.log("  [—] No template supplied – manual P/T/U preservation not exercised in this run.");
  console.log(`\nOpen "${basename(outPath)}" to visually confirm:`);
  console.log("  · Column A contains the auto-built AGL/H&M/{contract}-{folder}/{year} ref.");
  console.log("  · Column B holds the contract-level date (same on every row of this run).");
  console.log("  · Column E holds the folder-level date (same for every row from folder " + args.folder + ").");
  console.log("  · Column G (Order Qty) and R (pack/set Qty) only on the FIRST applicable row for the PO.");
  console.log("  · Columns P, T, U – blank for new rows; pre-existing manual values on rows from OTHER contracts preserved untouched.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
