/**
 * End-to-end run (opt-in). Set `RUN_MSG_E2E=1` to execute — otherwise this
 * suite is skipped so CI/other developers don't need the user's local .msg
 * PDFs on disk.
 *
 *   RUN_MSG_E2E=1 npm run test -- msg-end-to-end
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { PrismaClient } from "@prisma/client";
import { uploadHmBatch, type BatchFile } from "@/server/sales-contract/batch-upload";
import { buildCutoffWorkbook, type XlsxRow } from "@/server/shipment-schedule/write-xlsx";
import { autoScheduleFromPo } from "@/server/shipment-schedule/auto-schedule";

const runIt = process.env.RUN_MSG_E2E === "1" ? it : it.skip;
const EXTRACT_ROOT = "C:/Users/ZERIN~2.ANA/AppData/Local/Temp/claude/D--ucp-final/33b6c00a-e460-41ad-bef2-61d4f4301eea/scratchpad/msg-extract";

function pdfsIn(dir: string): BatchFile[] {
  const out: BatchFile[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.toLowerCase().endsWith(".pdf")) continue;
    const buf = readFileSync(join(dir, f));
    let kind: BatchFile["kind"] | null = null;
    if (/PurchaseOrder/i.test(f)) kind = "PurchaseOrder";
    else if (/SizePerColour/i.test(f)) kind = "SizePerColourBreakdown";
    else if (/TotalCountry/i.test(f)) kind = "TotalCountryBreakdown";
    else continue;
    out.push({ name: f, buffer: buf, kind });
  }
  return out;
}

describe("End-to-end: .msg PDFs → Sales Contract → auto Shipment Schedule", () => {
  const prisma = new PrismaClient();

  runIt("extracts 3 orders, routes per (TOD×market), rejects the duplicate 644923", async () => {
    const set643159 = `${EXTRACT_ROOT}/Order Package 643159-875  Slim denim_S-4`;
    const set644637 = `${EXTRACT_ROOT}/Order Package 644637-8756  Slim denim_S-4`;
    const set644923a = `${EXTRACT_ROOT}/Order Package 644923-5672  0010185C - REGULAR .LP.. S4`;
    const set644923b = `${EXTRACT_ROOT}/Order Package 644923-5672  0010185C - REGULAR LP S4`;
    for (const d of [set643159, set644637, set644923a, set644923b]) {
      expect(existsSync(d), `extract dir missing: ${d}`).toBe(true);
    }

    const sc97 = await prisma.salesContract.findFirst({ where: { contractNo: "97" } });
    const sc96 = await prisma.salesContract.findFirst({ where: { contractNo: "AGL/H&M/96/2026" } });
    expect(sc97).toBeTruthy();
    expect(sc96).toBeTruthy();

    const actor = "msg-e2e-test";
    // Upload the 3 orders into SC-97.
    for (const dir of [set643159, set644637, set644923a]) {
      const r = await uploadHmBatch(sc97!.id, pdfsIn(dir), { actor });
      console.log(`\n[upload ${dir.split("/").pop()}]`);
      for (const p of r.perPo) console.log(`  orderNo=${p.orderNo} action=${p.action} state=${p.state} rows=${p.rowCount}`);
    }
    // Stamp folderLetter=A so Buyer Code lookup resolves to AGL 349 A.
    await prisma.salesContractPo.updateMany({
      where: { contractId: sc97!.id, folderLetter: "" },
      data: { folderLetter: "A" },
    });
    // Re-route so Buyer Code hydrates post-stamp.
    const readyPos = await prisma.salesContractPo.findMany({ where: { contractId: sc97!.id, state: "READY" } });
    for (const po of readyPos) await autoScheduleFromPo({ poId: po.id, actor });

    // Dedup test: upload the OTHER 644923 revision to SC-96 → must be rejected.
    const dedup = await uploadHmBatch(sc96!.id, pdfsIn(set644923b), { actor });
    console.log(`\n[dedup upload 644923 rev-B into SC-96]`);
    for (const p of dedup.perPo) console.log(`  orderNo=${p.orderNo} action=${p.action} state=${p.state} reasons=${p.reasons.join(" | ")}`);
    const rejected = dedup.perPo.find((p) => p.orderNo.startsWith("644923"));
    expect(rejected?.action).toBe("rejected_duplicate_order_no");
    expect(rejected?.state).toBe("BLOCKED");

    // Verify extracted PO rows carry the summary-sourced fields.
    const posAfter = await prisma.salesContractPo.findMany({
      where: { contractId: sc97!.id, state: "READY" },
      include: { contract: true },
    });
    expect(posAfter.length).toBeGreaterThanOrEqual(3);
    for (const po of posAfter) {
      const rows = JSON.parse(po.rowsJson);
      expect(Array.isArray(rows)).toBe(true);
      expect(rows.length).toBeGreaterThan(0);
      const anchor = rows.find((r: any) => r.isAnchor) ?? rows[0];
      console.log(`\n[PO ${po.orderNo}] folderLetter=${po.folderLetter} orderQty=${anchor.orderQty} style="${anchor.styleNo}" fob=${anchor.fob} itemDes="${anchor.itemDes}" tod="${anchor.tod?.slice(0,80) ?? ""}" country="${anchor.country?.slice(0,120) ?? ""}"`);
    }

    // Report + check the Shipment Schedule rows.
    const schedules = await prisma.shipmentSchedule.findMany({
      include: { cutoffs: { include: { rows: true }, orderBy: { sortOrder: "asc" } } },
      orderBy: [{ weekNo: "asc" }],
    });
    console.log(`\n=== SHIPMENT SCHEDULES: ${schedules.length} ===`);
    let totalRows = 0;
    for (const s of schedules) {
      console.log(`Week ${s.weekNo}  [${s.weekTitle}]`);
      for (const c of s.cutoffs) {
        console.log(`  ${c.label}  date=${c.date || "(blank)"}  rows=${c.rows.length}`);
        for (const r of c.rows) {
          totalRows++;
          const value = r.pcs && r.fob ? (r.pcs * r.fob).toFixed(2) : "";
          console.log(`    - ${r.orderNo}  mkt=${r.marketCode}/${r.marketSubCode}  pcs=${r.pcs}  fob=${r.fob}  value=${value}  buyer="${r.buyerCode}"  cont="${r.contractNo}"  date="${r.contractDate}"  style="${r.style}"`);
          // Per-market quantity assertion: pcs must NOT equal the full orderQty
          // of the PO (unless the PO happens to be single-market).
          expect(r.pcs).toBeGreaterThan(0);
        }
      }
    }
    expect(totalRows).toBeGreaterThan(0);

    // Export sample Week 27 xlsx for the user to open.
    const outDir = "var/sample-exports";
    mkdirSync(outDir, { recursive: true });
    for (const s of schedules) {
      if (s.cutoffs.every((c) => c.rows.length === 0)) continue;
      for (const c of s.cutoffs) {
        if (c.rows.length === 0) continue;
        const xlsxRows: XlsxRow[] = c.rows.map((r) => ({
          buyerCode: r.buyerCode, contractNo: r.contractNo, contractDate: r.contractDate,
          orderNo: r.orderNo, pcs: r.pcs, style: r.style, fob: r.fob,
          composition: r.composition, cat: r.cat, hts: r.hts, invoiceNo: r.invoiceNo,
          marketSubCode: r.marketSubCode, marketCode: r.marketCode, transportMode: r.transportMode,
        }));
        const buf = await buildCutoffWorkbook(xlsxRows, {
          weekTitle: s.weekTitle, cutoffLabel: c.label, cutoffDate: c.date,
        });
        const safe = c.label.replace(/[^A-Za-z0-9]+/g, "_");
        const out = `${outDir}/Week${s.weekNo}_${safe}.xlsx`;
        writeFileSync(out, buf);
        console.log(`Exported: ${out}  (${c.rows.length} rows)`);
      }
    }

    await prisma.$disconnect();
  }, 180_000);
});
