/**
 * End-to-end test using the ACTUAL supplier PDFs the user pulled out of
 * D:\\order\\{A,B}. Opt-in via LIVE_E2E_TEST=1 so a fresh clone's test suite
 * stays green when the folders are not present.
 *
 * What this does:
 *   1. Scans scratchpad/order-A and scratchpad/order-B for 3-PDF sets written
 *      by scripts/sales-contract/extract-msg-pdfs.ts.
 *   2. For every complete set, parses PO + Size + Country, runs matchSet +
 *      reconcileSet, builds a SalesContractSummaryConfig that mimics the UI (contract 97
 *      for folder A, contract 98 for folder B – stand-ins; the user chooses
 *      per upload), computes `extraPrices` with buildExtraPricesFromPo, and
 *      hands everything to writeSummaryWorkbook.
 *   3. Uses a COPY of the user's real tracker as the template.
 *   4. Regenerates twice to prove idempotency.
 *   5. Spot-checks row-level fields against each PO's extracted values.
 *
 * The real tracker is READ-ONLY; the test copies it to a temp dir first and
 * only ever writes to the copy.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, existsSync, mkdirSync, readdirSync, statSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";

import { parsePurchaseOrderText } from "@/server/sales-contract/parse-po";
import { parseSizeBreakdownText } from "@/server/sales-contract/parse-size-breakdown";
import { parseCountryBreakdownText } from "@/server/sales-contract/parse-country-breakdown";
import { matchSet } from "@/server/sales-contract/match";
import { reconcileSet } from "@/server/sales-contract/validate";
import { buildExtraPricesFromPo, mapToSummaryRows } from "@/server/sales-contract/summary-rows";
import { writeSummaryWorkbook, SUMMARY_HEADERS, extractMarketCode } from "@/server/sales-contract/summary-writer";
import { resolvePoDerivedFields } from "@/server/sales-contract/config";
import type { SalesContractSummaryConfig } from "@/server/sales-contract/summary-rows";
// Must use the internal path – pdf-parse/index.js runs a debug test open at import time.
// @ts-ignore
import pdfParse from "pdf-parse/lib/pdf-parse.js";

const SCRATCH = join(
  "C:/Users/ZERIN~2.ANA/AppData/Local/Temp/claude/D--ucp-final/1eb7fb7b-bdb2-4f29-af51-1905841aba2b/scratchpad",
);
const DIR_A = join(SCRATCH, "order-A");
const DIR_B = join(SCRATCH, "order-B");
const TRACKER_SRC = String.raw`D:\oct-2026\automation docs\New folder\1. Sales Contract Creation\new-up coming shipment -HM-2015 to 2026(AutoRecovered).xlsx`;

const enabled = process.env.LIVE_E2E_TEST === "1";
const haveA   = existsSync(DIR_A);
const haveB   = existsSync(DIR_B);
const haveTrk = existsSync(TRACKER_SRC);
const skip = !enabled || !haveA || !haveB || !haveTrk;

interface SetBundle { folder: "A" | "B"; order: string; po: ReturnType<typeof parsePurchaseOrderText>; size: ReturnType<typeof parseSizeBreakdownText>; country: ReturnType<typeof parseCountryBreakdownText>; }

async function readPdfText(path: string): Promise<string> {
  const out = await pdfParse(readFileSync(path));
  return out.text ?? "";
}

async function loadBundlesFrom(dir: string, folder: "A" | "B"): Promise<SetBundle[]> {
  const entries = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith("__unknown"));
  const out: SetBundle[] = [];
  for (const e of entries) {
    const d = join(dir, e.name);
    const po = join(d, "PurchaseOrder.pdf");
    const size = join(d, "SizePerColourBreakdown.pdf");
    const country = join(d, "TotalCountryBreakdown.pdf");
    if (!existsSync(po) || !existsSync(size) || !existsSync(country)) continue;
    try {
      const poExtract = parsePurchaseOrderText(await readPdfText(po));
      const sizeExtract = parseSizeBreakdownText(await readPdfText(size));
      const countryExtract = parseCountryBreakdownText(await readPdfText(country));
      out.push({ folder, order: e.name, po: poExtract, size: sizeExtract, country: countryExtract });
    } catch (err) {
      console.warn(`[e2e] skip ${e.name}: ${err instanceof Error ? err.message : err}`);
    }
  }
  return out;
}

function buildConfig(bundle: SetBundle, overrides: Partial<SalesContractSummaryConfig> = {}): SalesContractSummaryConfig {
  // Mimic the UI: Folder A → contract 97, Folder B → contract 98 (stand-ins
  // the user picks per upload). Buyer codes AGL 349 A / AGL 355 A reflect
  // the real seed values; merchandiser names are deliberately generic
  // placeholders – the point of the test is the row-generation logic, not the
  // business values the user still has to configure in /sales-contract/config.
  const contractNo = bundle.folder === "A" ? "97" : "98";
  const resolved = resolvePoDerivedFields({
    header: bundle.po.header,
    contractNo,
    folderLetter: bundle.folder,
    merchandisers: bundle.folder === "A" ? ["(folder A test)"] : ["(folder B test)"],
  });
  return {
    contractNo,
    folderLetter: bundle.folder,
    contractDate: bundle.folder === "A" ? "23 Oct, 2026" : "15 Nov, 2026",
    folderCommercialDate: bundle.folder === "A" ? "01 Nov, 2026" : "20 Nov, 2026",
    buyerCode: bundle.folder === "A" ? "AGL 349 A" : "AGL 355 B",
    merchandiserName: resolved.merchandiserName,
    packSet: "1",
    marchentContNoOverride: resolved.contractRef,
    extraPrices: buildExtraPricesFromPo(bundle.po, bundle.country),
    ...overrides,
  };
}

describe.skipIf(skip)("E2E – real H&M PDFs from D:/order × real tracker", () => {
  let bundles: SetBundle[] = [];
  const workdir = join(tmpdir(), `hm-e2e-${Date.now()}`);
  const trackerCopy = join(workdir, "tracker-copy.xlsx");
  const outPass1 = join(workdir, "regen-pass1.xlsx");
  const outPass2 = join(workdir, "regen-pass2.xlsx");

  beforeAll(async () => {
    mkdirSync(workdir, { recursive: true });
    copyFileSync(TRACKER_SRC, trackerCopy);
    bundles = [
      ...(await loadBundlesFrom(DIR_A, "A")),
      ...(await loadBundlesFrom(DIR_B, "B")),
    ];
    console.log(`[e2e] loaded ${bundles.length} 3-PDF sets (A=${bundles.filter((b) => b.folder === "A").length}, B=${bundles.filter((b) => b.folder === "B").length})`);
  }, 180_000);

  it("extracts PO/Size/Country without crashing; reports per-PO reconciliation outcomes", () => {
    expect(bundles.length).toBeGreaterThanOrEqual(10);
    let okMatch = 0;
    let okRecon = 0;
    const reconMisses: string[] = [];
    for (const b of bundles) {
      const m = matchSet(b.po, b.size, b.country);
      const r = reconcileSet(b.po, b.size, b.country);
      if (m.matched) okMatch++;
      if (r.ok) okRecon++;
      // Order No is a shared identity across the three PDFs (hard requirement).
      expect(b.po.header.orderNo).toBe(b.size.header.orderNo);
      expect(b.po.header.orderNo).toBe(b.country.header.orderNo);
      if (b.country.grandTotal !== b.po.totalQty) {
        reconMisses.push(`${b.folder}/${b.po.header.orderNo}: PO total=${b.po.totalQty} vs Country grand=${b.country.grandTotal}`);
      }
    }
    console.log(`[e2e] 3-way match ok: ${okMatch}/${bundles.length}; reconciliation ok: ${okRecon}/${bundles.length}`);
    if (reconMisses.length) console.log(`[e2e] PO total != Country grand (parser investigation needed):\n  ${reconMisses.join("\n  ")}`);
    expect(okMatch).toBe(bundles.length); // match is a hard requirement
  }, 60_000);

  it("Fresh workbook (no tracker): every bundle inserts cleanly – strict spec checks", async () => {
    const freshOut = join(workdir, "fresh-no-tracker.xlsx");
    const pos = bundles.map((b, i) => ({ poId: `fresh-${i}`, po: b.po, config: buildConfig(b) }));
    const r = await writeSummaryWorkbook({
      outputPath: freshOut,
      pos,
      folderSequence: [{ folderLetter: "A", sequence: 0 }, { folderLetter: "B", sequence: 1 }],
    });
    expect(r.insertedRows).toBeGreaterThan(0);
    expect(r.ambiguousMatches.length).toBe(0);
    console.log(`[e2e-fresh] inserted=${r.insertedRows}, total=${r.totalRows}`);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(freshOut);
    const sh = wb.getWorksheet("H&M")!;
    // Count Order Qty cells per PO (should be exactly 1 per PO on a fresh sheet).
    const qtyPerPo: Record<string, number> = {};
    const packPerPo: Record<string, number> = {};
    sh.eachRow({ includeEmpty: false }, (r, i) => {
      if (i < 2) return;
      const order = String(r.getCell(6).value ?? "").trim();
      if (!order) return;
      if (r.getCell(7).value !== null && r.getCell(7).value !== "") qtyPerPo[order] = (qtyPerPo[order] ?? 0) + 1;
      if (r.getCell(18).value !== null && r.getCell(18).value !== "") packPerPo[order] = (packPerPo[order] ?? 0) + 1;
    });

    // Group bundles by PO# (same PO may appear in both folders A and B).
    const bundlesByOrder = new Map<string, SetBundle[]>();
    for (const b of bundles) {
      const bucket = bundlesByOrder.get(b.po.header.orderNo) ?? [];
      bucket.push(b);
      bundlesByOrder.set(b.po.header.orderNo, bucket);
    }

    const failures: string[] = [];
    for (const [order, bs] of bundlesByOrder) {
      // One Order Qty row per (PO × folder-config) – a PO appearing in both
      // folders A and B legitimately produces two "first" rows (one per config).
      const expectedFirsts = bs.length;
      if ((qtyPerPo[order] ?? 0) !== expectedFirsts) {
        failures.push(`${order}: Order Qty rows ${qtyPerPo[order] ?? 0} vs expected ${expectedFirsts}`);
      }
      if ((packPerPo[order] ?? 0) !== expectedFirsts) {
        failures.push(`${order}: Pack/Set Qty rows ${packPerPo[order] ?? 0} vs expected ${expectedFirsts}`);
      }
    }
    if (failures.length) console.log("[e2e-fresh] failures:\n  " + failures.join("\n  "));
    expect(failures).toEqual([]);
  }, 180_000);

  it("Pass 1 – append every real bundle to a COPY of the tracker, idempotency on Pass 2", async () => {
    const pos = bundles.map((b, i) => ({ poId: `e2e-${i}`, po: b.po, config: buildConfig(b) }));

    const r1 = await writeSummaryWorkbook({
      templatePath: trackerCopy,
      outputPath: outPass1,
      pos,
      folderSequence: [{ folderLetter: "A", sequence: 0 }, { folderLetter: "B", sequence: 1 }],
    });

    const r2 = await writeSummaryWorkbook({
      templatePath: outPass1,
      outputPath: outPass2,
      pos,
      folderSequence: [{ folderLetter: "A", sequence: 0 }, { folderLetter: "B", sequence: 1 }],
    });

    console.log(`[e2e] pass1: inserted=${r1.insertedRows}, matched=${r1.skippedExistingMatches.length}, ambiguous=${r1.ambiguousMatches.length}, preserved=${r1.preservedRows}, total=${r1.totalRows}`);
    console.log(`[e2e] pass2: inserted=${r2.insertedRows}, matched=${r2.skippedExistingMatches.length}, ambiguous=${r2.ambiguousMatches.length}, preserved=${r2.preservedRows}, total=${r2.totalRows}`);

    // Idempotency: pass 2 should NOT insert anything new.
    expect(r2.insertedRows).toBe(0);
    expect(r2.totalRows).toBe(r1.totalRows);

    // Pass 2's skippedExistingMatches must include every bundle's new rows,
    // because pass 1 wrote them and pass 2 sees them as existing.
    const expectedRowCount = bundles.reduce((n, b) => n + Math.max(b.po.marketRows.length, 1), 0);
    expect(r2.skippedExistingMatches.length).toBeGreaterThanOrEqual(Math.min(r1.insertedRows, expectedRowCount));
  }, 240_000);

  it("Pass-1 output: reports per-PO insert/match outcomes against the real tracker", async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(outPass1);
    const sh = wb.getWorksheet("H&M");
    expect(sh).toBeDefined();

    const perOrder: Record<string, { tods: string[]; fobs: Set<number>; countries: Set<string>; newGenRows: number; legacyRows: number }> = {};
    sh!.eachRow({ includeEmpty: false }, (r, i) => {
      if (i < 2) return;
      const orderNo = String(r.getCell(6).value ?? "").trim();
      if (!orderNo) return;
      const bucket = perOrder[orderNo] = perOrder[orderNo] ?? { tods: [], fobs: new Set(), countries: new Set(), newGenRows: 0, legacyRows: 0 };
      const market = extractMarketCode(String(r.getCell(15).value ?? ""));
      const refA = String(r.getCell(1).value ?? "");
      bucket.tods.push(String(r.getCell(14).value ?? ""));
      const fob = Number(r.getCell(9).value);
      if (Number.isFinite(fob)) bucket.fobs.add(fob);
      if (market) bucket.countries.add(market);
      if (/^AGL\/H&M\/\d+-[AB]\/\d{4}$/.test(refA)) bucket.newGenRows++;
      else bucket.legacyRows++;
    });

    const summary: string[] = [];
    for (const b of bundles) {
      const seen = perOrder[b.po.header.orderNo];
      if (!seen) { summary.push(`${b.folder}/${b.po.header.orderNo}: PO absent from output (BUG)`); continue; }
      const expectedMarkets = new Set(b.po.marketRows.map((m) => m.marketCode));
      summary.push(
        `${b.folder}/${b.po.header.orderNo}: newGen=${seen.newGenRows}, legacy=${seen.legacyRows}, ` +
        `markets=${[...seen.countries].sort().join(",")} (exp=${[...expectedMarkets].sort().join(",")})`,
      );
      // Every PO market the extractor produced must appear somewhere in the output.
      for (const m of expectedMarkets) {
        expect(seen.countries.has(m), `${b.folder}/${b.po.header.orderNo} missing market ${m}`).toBe(true);
      }
    }
    console.log("[e2e-tracker] per-PO summary:\n  " + summary.join("\n  "));
  }, 120_000);

  it("manual edits on P/T/U survive a regen; a manual contract reassignment is NOT reverted (fresh scenario)", async () => {
    // Scenario built on a FRESH workbook so we can edit a known new-generator
    // row (the real tracker's legacy row for 643159 preserves on first regen,
    // so there's no auto-inserted new row to edit there).
    const subject = bundles.find((b) => b.folder === "A");
    expect(subject).toBeDefined();

    const freshBase = join(workdir, "reassign-base.xlsx");
    await writeSummaryWorkbook({
      outputPath: freshBase,
      pos: [{ poId: "p1", po: subject!.po, config: buildConfig(subject!) }],
      folderSequence: [{ folderLetter: "A", sequence: 0 }, { folderLetter: "B", sequence: 1 }],
    });

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(freshBase);
    const sh = wb.getWorksheet("H&M")!;
    let subjectRow = 0;
    sh.eachRow({ includeEmpty: false }, (r, i) => {
      if (i < 2) return;
      if (subjectRow) return;
      if (String(r.getCell(6).value) === subject!.po.header.orderNo) {
        subjectRow = i;
        r.getCell(16).value = "E2E remark";
        r.getCell(20).value = "legacy fob";
        r.getCell(21).value = "manual date";
        r.getCell(4).value = "99";
      }
    });
    expect(subjectRow).toBeGreaterThan(0);
    const editedPath = join(workdir, "reassign-edited.xlsx");
    await wb.xlsx.writeFile(editedPath);

    const outRegen = join(workdir, "reassign-regen.xlsx");
    const r = await writeSummaryWorkbook({
      templatePath: editedPath,
      outputPath: outRegen,
      pos: [{ poId: "p1", po: subject!.po, config: buildConfig(subject!) }],
      folderSequence: [{ folderLetter: "A", sequence: 0 }, { folderLetter: "B", sequence: 1 }],
    });
    expect(r.insertedRows).toBe(0);

    const wb3 = new ExcelJS.Workbook();
    await wb3.xlsx.readFile(outRegen);
    const sh3 = wb3.getWorksheet("H&M")!;
    let found = false;
    sh3.eachRow({ includeEmpty: false }, (r2, i) => {
      if (i < 2) return;
      if (String(r2.getCell(6).value) === subject!.po.header.orderNo && String(r2.getCell(4).value) === "99") {
        expect(r2.getCell(16).value).toBe("E2E remark");
        expect(r2.getCell(20).value).toBe("legacy fob");
        expect(r2.getCell(21).value).toBe("manual date");
        found = true;
      }
    });
    expect(found, "manually-reassigned row with manual P/T/U must survive regen").toBe(true);

    const skipped = r.skippedExistingMatches.find((s) => s.orderNo === subject!.po.header.orderNo && s.existingContract === "99");
    expect(skipped?.note === "manual_assignment_kept" || skipped?.note === "contract_preserved_from_existing").toBe(true);
    console.log(`[e2e] manual reassignment of ${subject!.po.header.orderNo} to contract 99 + P/T/U edits: preserved ✓`);
  }, 180_000);

  it("writes a sample Excel report of what happened, for human spot-check", async () => {
    console.log(`[e2e] workdir: ${workdir}`);
    console.log(`[e2e]   tracker copy  : ${trackerCopy}`);
    console.log(`[e2e]   pass1 output  : ${outPass1}`);
    console.log(`[e2e]   pass2 output  : ${outPass2}`);
    expect(statSync(outPass1).size).toBeGreaterThan(10_000);
    expect(statSync(outPass2).size).toBeGreaterThan(10_000);
  });
});
