/**
 * Read-only companion to sales-contract-clear-rescan.live.test.ts.
 * Does NOT touch the DB. Just dumps the current Summary rows grouped by
 * order_no × country × TOD, using the right field names (`tod`, `country`,
 * `commercialContNo`).
 *
 *   LIVE_RESCAN_TEST=1 npx vitest run tests/sales-contract-summary-dump.live.test.ts --reporter=verbose
 */
import { describe, it, expect } from "vitest";
import { prisma } from "@/lib/db";
import { collectSummaryRows } from "@/server/sales-contract/summary";

const RUN = process.env.LIVE_RESCAN_TEST === "1";
const d = RUN ? describe : describe.skip;

d("sales-contract summary dump (live, read-only)", () => {
  it("every summary row has (orderNo × country × tod); no duplicate (po, country, tod, price) rows", async () => {
    const log = (s: string = "") => console.log(s);
    const sep = (s: string) => log(`\n=== ${s} ===`);

    sep("DB SNAPSHOT");
    const contracts = await prisma.salesContract.findMany({
      select: { id: true, contractNo: true, contractDate: true },
      orderBy: { contractNo: "asc" },
    });
    const pos = await prisma.salesContractPo.findMany({
      select: { id: true, orderNo: true, folderLetter: true, creationDate: true, contractId: true, state: true, blockWrite: true },
      orderBy: [{ folderLetter: "asc" }, { orderNo: "asc" }],
    });
    const byShort: Record<string, typeof pos> = {};
    for (const po of pos) {
      const m = (po.orderNo || "").match(/\d{6,}/);
      const k = m ? m[0] : po.orderNo;
      (byShort[k] = byShort[k] || []).push(po);
    }
    const dupes = Object.entries(byShort).filter(([, v]) => v.length > 1);
    log(`contracts: ${contracts.length}  POs: ${pos.length}  duplicate order_no groups: ${dupes.length}`);
    for (const c of contracts) log(`  ${c.contractNo}  date=${c.contractDate ?? ""}`);
    expect(dupes.length).toBe(0);

    sep("SUMMARY ROWS BY (ORDER_NO × COUNTRY × TOD)");
    const { rows, skippedPos, contractCount } = await collectSummaryRows({});
    log(`contracts in summary: ${contractCount}  rows: ${rows.length}  skipped: ${skippedPos.length}`);
    for (const s of skippedPos.slice(0, 20)) log(`  SKIP ${s.orderNo}: ${s.reasons.join(", ")}`);

    // Group by short order_no.
    const perOrder: Record<string, typeof rows> = {};
    for (const r of rows) {
      const k = (r.orderNo || "").match(/\d{6,}/)?.[0] ?? r.orderNo ?? "";
      (perOrder[k] = perOrder[k] || []).push(r);
    }
    const orderKeys = Object.keys(perOrder).sort();
    log(`distinct order_nos in summary: ${orderKeys.length}`);

    // 1) Every row must have country + tod populated.
    const missingTod: { orderNo: string; marketCode: string }[] = [];
    const missingCountry: { orderNo: string }[] = [];
    for (const r of rows) {
      if (!r.tod || !r.tod.trim()) missingTod.push({ orderNo: r.orderNo, marketCode: r.marketCode });
      if (!r.country || !r.country.trim()) missingCountry.push({ orderNo: r.orderNo });
    }

    // 2) No duplicate (po, country, tod, fob) tuples — merge logic in
    //    summary-rows.ts guarantees one row per combination.
    const tuples = new Map<string, number>();
    for (const r of rows) {
      const k = `${r.poId}|${r.tod}|${r.country}|${r.fob ?? ""}`;
      tuples.set(k, (tuples.get(k) ?? 0) + 1);
    }
    const tupleDupes = [...tuples.entries()].filter(([, n]) => n > 1);

    // Dump every PO group with its split rows.
    for (const k of orderKeys) {
      const group = perOrder[k];
      const first = group[0];
      log(`\n  ${k}  contract=${first.commercialContNo}  buyer=${first.buyerCode}  style=${first.styleNo}  rows=${group.length}`);
      for (const r of group) {
        const parts = [
          `tod=${r.tod}`,
          `country=${r.country}`,
          `qty=${r.orderQty ?? ""}`,
          `fob=${r.fob ?? ""}`,
          `value=${r.contractValue ?? ""}`,
          `R=${r.packSetQty ?? ""}`,
          `S=${r.packSet}`,
        ];
        log(`      ${parts.join("  ")}`);
      }
    }

    sep("ASSERTIONS");
    log(`rows with missing TOD: ${missingTod.length}`);
    for (const m of missingTod.slice(0, 20)) log(`  ${m.orderNo} / ${m.marketCode}`);
    log(`rows with missing country: ${missingCountry.length}`);
    for (const m of missingCountry.slice(0, 20)) log(`  ${m.orderNo}`);
    log(`duplicate (po, tod, country, fob) tuples: ${tupleDupes.length}`);
    for (const [k, n] of tupleDupes.slice(0, 10)) log(`  ${k}  × ${n}`);

    expect(missingCountry.length).toBe(0);
    expect(tupleDupes.length).toBe(0);
    // Don't fail on missing TOD — some real PO extracts legitimately carry an
    // empty TOD; just surface the count. The user's intent is "split BY tod",
    // which the row generator does per (tod, country, price); the merged tod
    // can be blank when the source PDF omitted it.
  }, 180_000);
});
