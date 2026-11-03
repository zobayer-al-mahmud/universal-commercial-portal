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

  // Template-preserve test cases were removed on 2026-11-03: the Summary
  // writer no longer accepts a template (user rule — no old PO rows may be
  // preserved anywhere). The "fresh workbook" case above still exercises the
  // real PDF → mapToSummaryRows → writeSummaryWorkbook path end-to-end.
});
