/**
 * Pull every Sales Contract PO's (TOD × market) breakdown through
 * `autoScheduleSummaryRow` and print a report:
 *   - how many pairs got routed into which week + cutoff
 *   - which market codes are missing from the CFS mapping
 *   - which TOD strings failed to parse
 *   - sampled resulting ShipmentScheduleRow fields so we can eyeball data pull
 *
 * Does NOT delete anything first; re-runs are idempotent (the router merges on
 * [scheduleId, orderNo, marketCode, marketSubCode]).
 */
import { PrismaClient } from "@prisma/client";
import { autoScheduleSummaryRow } from "../../src/server/shipment-schedule/auto-schedule";
import { parseTodDate, computeWeekFromDate } from "../../src/server/shipment-schedule/cutoff-router";

const prisma = new PrismaClient();

interface Pair {
  poId: string;
  orderNo: string;
  pcs: number | null;
  fob: number | null;
  composition: string;
  todRaw: string;
  marketCode: string;
  marketSubCode: string;
  marketQty: number;
}

function parseCountryLines(country: string): { tod: string; mkt: string; mktB: string; qty: number }[] {
  const out: { tod: string; mkt: string; mktB: string; qty: number }[] = [];
  for (const raw of country.split(/\n+/)) {
    const line = raw.trim();
    if (!line) continue;
    // Pattern: "<DD MMM, YYYY> <MKT> (<MKT-B>) <qty with spaces> <pct>%"
    // Example: "29 Jun, 2026 OE (OLCEU) 3 544 87%"
    const m = line.match(/^(\d{1,2}\s+[A-Za-z]{3,}\.?,?\s+\d{4})\s+([A-Z]{2})\s*\(([^)]+)\)\s+([\d\s]+?)\s+(?:<?\d+%|\d+%)/);
    if (!m) continue;
    const tod = m[1].trim();
    const mkt = m[2];
    const mktB = m[3].trim();
    const qty = Number(m[4].replace(/\s+/g, ""));
    if (Number.isFinite(qty)) out.push({ tod, mkt, mktB, qty });
  }
  return out;
}

async function collectPairs(): Promise<Pair[]> {
  const pos = await prisma.salesContractPo.findMany({ include: { contract: true } });
  const pairs: Pair[] = [];
  for (const po of pos) {
    const rows: any[] = JSON.parse(po.rowsJson || "[]");
    for (const r of rows) {
      const breakdown = parseCountryLines(r.country || "");
      for (const b of breakdown) {
        pairs.push({
          poId: po.id,
          orderNo: r.orderNo || po.orderNo,
          pcs: typeof r.orderQty === "number" ? r.orderQty : null,
          fob: typeof r.fob === "number" ? r.fob : null,
          composition: r.itemDes || "",
          todRaw: b.tod,
          marketCode: b.mkt,
          marketSubCode: b.mktB,
          marketQty: b.qty,
        });
      }
    }
  }
  return pairs;
}

(async () => {
  const pairs = await collectPairs();
  console.log(`\nCollected ${pairs.length} (TOD × market) pairs from ${(await prisma.salesContractPo.count())} POs.\n`);

  // Preview the parsing before we hit the DB.
  const byMarket = new Map<string, number>();
  for (const p of pairs) byMarket.set(p.marketCode, (byMarket.get(p.marketCode) ?? 0) + 1);
  console.log("Markets seen:", [...byMarket.entries()].sort((a,b)=>b[1]-a[1]).map(([k,v])=>`${k}=${v}`).join(" "));

  // Check which markets are missing from cfs-cutoff-day mapping before running.
  const refs = await prisma.referenceData.findMany({ where: { type: "cfs-cutoff-day" } });
  const mapped = new Set(refs.map(r => r.code));
  const unmappedMarkets = [...byMarket.keys()].filter(k => !mapped.has(k));
  if (unmappedMarkets.length) {
    console.log(`UNMAPPED markets (${unmappedMarkets.length}):`, unmappedMarkets.join(", "));
  } else {
    console.log("All markets seen are covered by the CFS mapping.");
  }

  // Preview week assignments from TOD alone.
  const weekDist = new Map<string, number>();
  for (const p of pairs) {
    const d = parseTodDate(p.todRaw);
    if (!d) continue;
    const w = computeWeekFromDate(d);
    const key = `${w.year}-W${String(w.weekNo).padStart(2,'0')}`;
    weekDist.set(key, (weekDist.get(key) ?? 0) + 1);
  }
  console.log("\nWeek distribution (year-week → #pairs):");
  for (const k of [...weekDist.keys()].sort()) console.log(`  ${k}: ${weekDist.get(k)}`);

  // Now actually auto-route each pair.
  const stats = { routed: 0, failed: 0, byReason: new Map<string, number>() };
  const createdWeeks = new Set<string>();
  const touchedRows: string[] = [];
  for (const p of pairs) {
    const result = await autoScheduleSummaryRow({
      todRaw: p.todRaw,
      marketCode: p.marketCode,
      marketSubCode: p.marketSubCode,
      orderNo: p.orderNo,
      poId: p.poId,              // auto-resolves buyerCode / contractNo / contractDate / style
      pcs: p.pcs,
      fob: p.fob,
      composition: p.composition,
      actor: "test-auto-route-script",
    });
    if (result.routed) {
      stats.routed++;
      createdWeeks.add(`${result.year}-W${String(result.weekNo).padStart(2,'0')}-${result.cutoffLabel}`);
      touchedRows.push(result.rowId);
    } else {
      stats.failed++;
      const key = `${result.reason}${result.detail ? ":" + result.detail : ""}`;
      stats.byReason.set(key, (stats.byReason.get(key) ?? 0) + 1);
    }
  }
  console.log(`\n=== ROUTING RESULT ===`);
  console.log(`Routed:  ${stats.routed}`);
  console.log(`Failed:  ${stats.failed}`);
  if (stats.failed) {
    console.log(`Failure reasons:`);
    for (const [k, v] of [...stats.byReason.entries()].sort((a,b)=>b[1]-a[1])) console.log(`  ${v}× ${k}`);
  }
  console.log(`Distinct (week × cutoff) slots touched: ${createdWeeks.size}`);
  for (const w of [...createdWeeks].sort()) console.log(`  ${w}`);

  // Sanity-check the resulting schedules.
  const schedules = await prisma.shipmentSchedule.findMany({
    include: { cutoffs: { include: { rows: true } } },
    orderBy: [{ weekNo: "asc" }],
  });
  console.log(`\n=== SHIPMENT SCHEDULES AFTER ROUTING: ${schedules.length} ===`);
  for (const s of schedules) {
    console.log(`\nWeek ${s.weekNo}  [${s.weekTitle}]`);
    for (const c of s.cutoffs.sort((a,b)=>a.sortOrder-b.sortOrder)) {
      console.log(`  ${c.label}  date=${c.date || "(blank)"}  rows=${c.rows.length}`);
      for (const r of c.rows.slice(0, 3)) {
        console.log(`    - orderNo=${r.orderNo}  market=${r.marketCode}/${r.marketSubCode}  pcs=${r.pcs}  fob=${r.fob}  style="${r.style||""}"  buyer="${r.buyerCode||""}"  contract="${r.contractNo||""}"  date="${r.contractDate||""}"`);
      }
      if (c.rows.length > 3) console.log(`    … and ${c.rows.length - 3} more`);
    }
  }

  await prisma.$disconnect();
})();
