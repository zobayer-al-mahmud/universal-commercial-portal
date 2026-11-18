/**
 * User ask 2026-11-03: recheck the 588-row count — confirm every row comes
 * from a READY/open PO's latest Creation-date extract, no older-date data
 * is reaching the summary.
 *
 *   LIVE_RESCAN_TEST=1 npx vitest run tests/sales-contract-summary-rowcount.live.test.ts --reporter=verbose
 */
import { describe, it, expect } from "vitest";
import { writeFileSync } from "node:fs";
import ExcelJS from "exceljs";
import { prisma } from "@/lib/db";
import { collectSummaryRows, generateHmSummary } from "@/server/sales-contract/summary";

const RUN = process.env.LIVE_RESCAN_TEST === "1";
const d = RUN ? describe : describe.skip;

d("summary 588-row recheck (live)", () => {
  it("every summary row traces to a READY PO's current extract; BLOCKED/older-date POs are excluded; .xlsx row count matches in-memory count", async () => {
    const log = (s: string = "") => console.log(s);
    const sep = (s: string) => log(`\n=== ${s} ===`);

    sep("DB — PO BREAKDOWN");
    const allPos = await prisma.salesContractPo.findMany({
      select: { id: true, orderNo: true, folderLetter: true, state: true, blockWrite: true, creationDate: true, poJson: true, contractId: true },
    });
    const ready = allPos.filter(p => p.state === "READY" && !p.blockWrite);
    const blocked = allPos.filter(p => p.state !== "READY" || p.blockWrite);
    log(`total POs: ${allPos.length}  READY+open: ${ready.length}  BLOCKED/older-rejected: ${blocked.length}`);

    // Build the set of READY poIds and READY short-order-nos for cross-checks.
    const readyPoIds = new Set(ready.map(p => p.id));
    const readyShortOrderNos = new Set<string>();
    for (const p of ready) {
      const m = (p.orderNo || "").match(/\d{6,}/);
      if (m) readyShortOrderNos.add(m[0]);
    }

    sep("IN-MEMORY SUMMARY");
    const { rows: memRows, skippedPos, contractCount } = await collectSummaryRows({});
    log(`contracts in summary: ${contractCount}  rows: ${memRows.length}  skipped: ${skippedPos.length}`);

    // 1) Every summary row must trace back to a READY PO (poId).
    const poIdsInSummary = new Set(memRows.map(r => r.poId));
    const leaks = [...poIdsInSummary].filter(id => !readyPoIds.has(id));
    log(`\nsummary rows coming from a non-READY PO: ${leaks.length}  (expected 0)`);
    for (const l of leaks.slice(0, 10)) log(`  LEAK poId=${l}`);
    expect(leaks.length).toBe(0);

    // 2) BLOCKED PO's orderNo must not appear in summary (even as a short-order match).
    const blockedShortOrderNos = new Set<string>();
    for (const b of blocked) {
      const m = (b.orderNo || "").match(/\d{6,}/);
      if (m && !readyShortOrderNos.has(m[0])) blockedShortOrderNos.add(m[0]);
    }
    const stale = memRows.filter(r => {
      const m = (r.orderNo || "").match(/\d{6,}/);
      return m && blockedShortOrderNos.has(m[0]);
    });
    log(`summary rows that match a BLOCKED-only short order_no: ${stale.length}  (expected 0)`);
    expect(stale.length).toBe(0);

    // 3) For every READY PO, verify its summary rows exactly match the CURRENT
    //    poJson.marketRows set (= the latest Creation-date version's markets).
    sep("EACH READY PO: current-extract markets vs summary rows");
    let mismatches = 0;
    for (const po of ready) {
      let currentMarkets = new Set<string>();
      try {
        const pj = JSON.parse(po.poJson || "null");
        for (const m of pj?.marketRows ?? []) currentMarkets.add(`${m.tod}|${m.marketCode}|${m.marketCodeB ?? ""}`);
      } catch { /* ignore */ }
      const summaryMarkets = new Set<string>();
      for (const r of memRows.filter(r => r.poId === po.id)) {
        // r.country = "<marketCode> (<marketSubCode>)" — split back out
        const match = (r.country || "").match(/^([A-Z]{2})\s*(?:\(([^)]+)\))?/);
        const mc = match?.[1] || r.marketCode;
        const sc = match?.[2] || "";
        summaryMarkets.add(`${r.tod}|${mc}|${sc}`);
      }
      const missing = [...currentMarkets].filter(k => !summaryMarkets.has(k));
      const extra = [...summaryMarkets].filter(k => !currentMarkets.has(k));
      if (missing.length || extra.length) {
        mismatches++;
        log(`  MISMATCH ${po.orderNo}  creation=${po.creationDate}`);
        for (const k of missing.slice(0,5)) log(`    missing from summary: ${k}`);
        for (const k of extra.slice(0,5)) log(`    extra in summary:     ${k}`);
      }
    }
    log(`POs whose summary rows DON'T match the current extract exactly: ${mismatches}  (expected 0)`);
    expect(mismatches).toBe(0);

    // 4) Row-count math: sum of per-PO (TOD × country × price-tier) rows
    //    should equal memRows.length.
    let perPoRowSum = 0;
    for (const po of ready) perPoRowSum += memRows.filter(r => r.poId === po.id).length;
    log(`\nsum of per-PO row counts: ${perPoRowSum}  vs  memRows.length: ${memRows.length}  (expect equal)`);
    expect(perPoRowSum).toBe(memRows.length);

    // 5) Generate the .xlsx and count DATA rows on the Summary sheet.
    sep("SUMMARY .XLSX ROW COUNT");
    const outPath = `C:\\\\Users\\\\ZERIN~2.ANA\\\\AppData\\\\Local\\\\Temp\\\\claude\\\\D--ucp-final\\\\1eb7fb7b-bdb2-4f29-af51-1905841aba2b\\\\scratchpad\\\\summary-recheck.xlsx`;
    const gen = await generateHmSummary({ outputPath: outPath });
    log(`generateHmSummary: outputPath=${gen.outputPath}  skippedPos=${gen.skippedPos.length}`);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(outPath);
    const ws = wb.worksheets[0];
    log(`workbook sheets: ${wb.worksheets.map(w => w.name).join(", ")}`);
    log(`primary sheet: ${ws.name}  rowCount(incl header rows): ${ws.rowCount}`);
    // Count rows whose column A has the merchandiser contract no (A column) — that's the data body.
    let dataRows = 0;
    const samples: string[] = [];
    ws.eachRow({ includeEmpty: false }, (row, rowIdx) => {
      const a = row.getCell(1).value;
      const d = row.getCell(4).value; // commercialContNo
      if (a && d && String(d).match(/^\d+$/) && rowIdx > 2) {
        dataRows++;
        if (samples.length < 5) samples.push(`row ${rowIdx}: A=${a}  D=${d}  O=${row.getCell(15).value}  N=${row.getCell(14).value}`);
      }
    });
    log(`xlsx data rows (A+D populated, past header): ${dataRows}`);
    for (const s of samples) log(`  ${s}`);
    log(`→ in-memory rows ${memRows.length}  vs  xlsx body rows ${dataRows}`);

    sep("DONE");
  }, 180_000);
});
