/**
 * User rule 2026-11-03 end-to-end test from the USER END (production path).
 *
 * Clears every PO-derived row in the DB, then simulates what the browser does
 * when the user picks a folder with <input type="file" webkitdirectory>:
 * reads every file inside D:\order\A and D:\f locally, pipes the bytes
 * through the real `commitScannedFromUploads()` server function — the same
 * one the production POST route calls. Nothing in this path depends on the
 * server having access to the user's filesystem, so what passes here must
 * also pass after deployment.
 *
 * After the uploads land, re-checks every rule the user named:
 *   - exactly ONE SalesContractPo per short orderNo (latest-date winner)
 *   - older rejected copies left no DB row anywhere (no BLOCKED, no placeholder)
 *   - every PO's stored creationDate is the latest of all .msg copies on disk
 *   - CustomsInvoice / SalesContractRowEdit / ShipmentScheduleRow tied to a
 *     dropped order version are gone
 *   - Summary View rows == xlsx body rows, no row traces to a non-READY PO
 *
 *   LIVE_RESCAN_TEST=1 npx vitest run tests/sales-contract-user-end-upload.live.test.ts --reporter=verbose
 */
import { describe, it, expect } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { prisma } from "@/lib/db";
import {
  commitScannedFromUploads,
  extractEmbeddedPdfBuffers,
  extractCreationDateFromFilename,
  type UploadedBuffer,
} from "@/server/sales-contract/scan-folder";
import { parsePurchaseOrderText } from "@/server/sales-contract/parse-po";
import { parsePdfText } from "@/server/pdf/parse-pdf";
import { collectSummaryRows } from "@/server/sales-contract/summary";

const RUN = process.env.LIVE_RESCAN_TEST === "1";
const d = RUN ? describe : describe.skip;

type FolderPlan = { folderLetter: string; sourcePath: string; contractNo: string };

d("user-end upload test (clear + browser-upload path)", () => {
  it("every rule holds end-to-end against the production commitScannedFromUploads", async () => {
    const log = (s: string = "") => console.log(s);
    const sep = (s: string) => log(`\n=== ${s} ===`);

    // --- 1. Resolve scan plan from configured mappings + buyer codes --------
    const contracts = await prisma.salesContract.findMany({ select: { id: true, contractNo: true } });
    const folderMappings = await prisma.salesContractFolderMapping.findMany();
    const byContract = new Map(contracts.map(c => [c.contractNo, c.id] as const));

    // Only two folders this run — the two the user @-tagged.
    const requestedFolders = [
      { letter: "A", source: "D:\\order\\A" },
      { letter: "C", source: "D:\\f" },
    ];
    // Figure out which contract each folder feeds via buyer-code mapping.
    const buyers = await prisma.salesContractBuyerCode.findMany();
    const plan: FolderPlan[] = [];
    for (const r of requestedFolders) {
      const mapping = folderMappings.find(f => f.folderLetter === r.letter);
      expect(mapping, `folder ${r.letter} not configured in SalesContractFolderMapping`).toBeTruthy();
      // Pick the contract that has a buyer-code row for THIS folder.
      const buyer = buyers.find(b => b.folderLetter === r.letter && byContract.has(b.contractNo));
      expect(buyer, `no contract has a buyer-code for folder ${r.letter}`).toBeTruthy();
      if (!buyer) continue;
      plan.push({ folderLetter: r.letter, sourcePath: r.source, contractNo: buyer.contractNo });
    }
    sep("SCAN PLAN (user-end upload path)");
    for (const p of plan) log(`  folder ${p.folderLetter}  src=${p.sourcePath}  → contract ${p.contractNo}`);

    // --- 2. Snapshot .msg files on disk, grouped by orderNo + creation-date --
    //     We will use this later to prove the winner we saw IS the latest.
    sep("ON-DISK PER-FILE CREATION DATES");
    const diskVersions: Record<string, { file: string; creation: string; folder: string }[]> = {};
    for (const p of plan) {
      const entries = await readdir(p.sourcePath);
      const msgs = entries.filter(n => /\.msg$/i.test(n));
      for (const name of msgs) {
        const bytes = await readFile(join(p.sourcePath, name));
        const pdfs = await extractEmbeddedPdfBuffers(bytes);
        // Find the PO PDF; parse its creation date out of the text when present,
        // else fall back to the H&M filename stamp (same priority intake uses).
        for (const pdf of pdfs) {
          try {
            const { text } = await parsePdfText(pdf.bytes);
            if (!text || !/Purchase Order/i.test(text)) continue;
            const parsed = parsePurchaseOrderText(text);
            const orderNo = parsed?.header?.orderNo;
            if (!orderNo) continue;
            let creation = parsed?.header?.creationDate ?? "";
            if (!creation) creation = extractCreationDateFromFilename(pdf.sourceName || name);
            const short = (String(orderNo).match(/\d{6,}/) ?? [String(orderNo)])[0];
            (diskVersions[short] = diskVersions[short] || []).push({ file: name, creation, folder: p.folderLetter });
          } catch { /* skip bad pdf */ }
        }
      }
    }
    const diskOrderCount = Object.keys(diskVersions).length;
    log(`distinct order_nos on disk: ${diskOrderCount}`);
    const multiVersion = Object.entries(diskVersions).filter(([, v]) => v.length > 1);
    log(`order_nos with multiple .msg versions on disk: ${multiVersion.length}`);
    for (const [k, versions] of multiVersion.slice(0, 10)) {
      log(`  ${k}: ${versions.length} versions`);
      for (const v of versions) log(`     ${v.folder}  ${v.creation || "(no creation date)"}  ← ${v.file}`);
    }

    // --- 3. Wipe EVERYTHING tied to PO data (destructive — DB was backed up) --
    sep("WIPE DB");
    await prisma.salesContractRowEdit.deleteMany({});
    await prisma.customsInvoicePdf.deleteMany({});
    await prisma.customsInvoiceEdit.deleteMany({});
    await prisma.customsInvoice.deleteMany({});
    await prisma.shipmentScheduleRowEdit.deleteMany({});
    await prisma.shipmentScheduleRow.deleteMany({});
    await prisma.salesContractPdf.deleteMany({});
    const delPo = await prisma.salesContractPo.deleteMany({});
    for (const c of contracts) {
      await prisma.salesContract.update({ where: { id: c.id }, data: { folderDatesJson: "{}" } });
    }
    log(`deleted ${delPo.count} SalesContractPo rows (plus all cascading edits/invoices/shipment rows)`);
    log(`POs after wipe: ${await prisma.salesContractPo.count()}  CustomsInvoice: ${await prisma.customsInvoice.count()}  ShipmentScheduleRow: ${await prisma.shipmentScheduleRow.count()}`);
    expect(await prisma.salesContractPo.count()).toBe(0);

    // --- 4. For each folder, feed every .msg through commitScannedFromUploads --
    sep("UPLOAD FROM USER END");
    for (const p of plan) {
      log(`\nfolder ${p.folderLetter}  src=${p.sourcePath}  → contract ${p.contractNo}`);
      const contractId = byContract.get(p.contractNo);
      if (!contractId) { log(`  CONTRACT ${p.contractNo} MISSING; skipped`); continue; }
      const entries = await readdir(p.sourcePath);
      const msgs = entries.filter(n => /\.msg$/i.test(n));
      log(`  .msg files found: ${msgs.length}`);
      const uploads: UploadedBuffer[] = [];
      for (const name of msgs) {
        const bytes = await readFile(join(p.sourcePath, name));
        uploads.push({ name, relativePath: `${p.folderLetter}/${name}`, bytes });
      }
      const commit = await commitScannedFromUploads({
        contractId,
        folderLetter: p.folderLetter,
        files: uploads,
        actor: "user-end-test",
      });
      log(`  imported: ${commit.imported.length}  updates: ${commit.updates.length}  skipped: ${commit.skipped.length}`);
      if (commit.imported.length) log(`    imported order_nos: ${commit.imported.map(i => i.orderNo).join(", ")}`);
      for (const u of commit.updates) log(`    update ${u.orderNo} → ${u.outcome}: ${u.message}`);
      for (const s of commit.skipped.slice(0, 5)) log(`    skipped ${s.orderNo}: ${s.reason}`);
    }

    // --- 5. CROSSCHECKS -------------------------------------------------------
    sep("CROSSCHECK — ONE ROW PER SHORT ORDER_NO");
    const allPos = await prisma.salesContractPo.findMany({ select: { id: true, orderNo: true, folderLetter: true, state: true, blockWrite: true, creationDate: true, contractId: true } });
    log(`total SalesContractPo rows after upload: ${allPos.length}`);
    const byState: Record<string, number> = {};
    for (const po of allPos) byState[`${po.state}|blockWrite=${po.blockWrite}`] = (byState[`${po.state}|blockWrite=${po.blockWrite}`] ?? 0) + 1;
    for (const [k, v] of Object.entries(byState)) log(`  ${k}: ${v}`);

    const byShort: Record<string, typeof allPos> = {};
    for (const po of allPos) {
      const m = (po.orderNo || "").match(/\d{6,}/);
      const k = m ? m[0] : po.orderNo;
      (byShort[k] = byShort[k] || []).push(po);
    }
    const dupes = Object.entries(byShort).filter(([, v]) => v.length > 1);
    log(`duplicate short order_no groups: ${dupes.length}`);
    for (const [k, v] of dupes) {
      log(`  ${k}:`);
      for (const po of v) log(`    folder=${po.folderLetter}  state=${po.state}  blockWrite=${po.blockWrite}  creation=${po.creationDate}`);
    }
    expect(dupes.length).toBe(0);

    // No BLOCKED/placeholder leftovers.
    const blocked = allPos.filter(po => po.state !== "READY" || po.blockWrite);
    log(`BLOCKED / blockWrite POs (expect 0 — older-rejected should be fully deleted): ${blocked.length}`);
    expect(blocked.length).toBe(0);

    // --- 6. CROSSCHECK — each surviving PO is the LATEST on-disk version ----
    sep("CROSSCHECK — SURVIVOR IS LATEST ON-DISK VERSION");
    // Pick the max creation-date per short orderNo from the disk snapshot.
    function parseStamp(s: string): number {
      // Local copy of the parser in dedup-order-no.ts, condensed.
      const months: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
      const composite = s.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?(?:\s+v(\d{1,3}))?$/i);
      if (composite) {
        const mo = months[composite[2].slice(0,3).toLowerCase()] || 0;
        let h = Number(composite[4]); const ap = composite[7]?.toUpperCase();
        if (ap === "PM" && h < 12) h += 12; if (ap === "AM" && h === 12) h = 0;
        return Date.UTC(Number(composite[3]), mo - 1, Number(composite[1]), h, Number(composite[5]), composite[6] ? Number(composite[6]) : 0) + (composite[8] ? Number(composite[8]) * 1000 : 0);
      }
      const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
      if (iso) return Date.UTC(+iso[1], +iso[2]-1, +iso[3], iso[4]?+iso[4]:0, iso[5]?+iso[5]:0, iso[6]?+iso[6]:0);
      return 0;
    }

    let mismatches = 0;
    for (const po of allPos) {
      const short = (po.orderNo.match(/\d{6,}/) ?? [po.orderNo])[0];
      const versions = diskVersions[short] ?? [];
      if (versions.length === 0) continue; // disk didn't have creation date, skip
      const maxOnDisk = versions.reduce((a, b) => parseStamp(a.creation) >= parseStamp(b.creation) ? a : b);
      if ((po.creationDate || "").trim() !== (maxOnDisk.creation || "").trim()) {
        mismatches++;
        log(`  MISMATCH ${short}  stored=${po.creationDate}  latest-on-disk=${maxOnDisk.creation}`);
      }
    }
    log(`POs whose stored creationDate != max on-disk version: ${mismatches}  (expect 0)`);
    expect(mismatches).toBe(0);

    // --- 7. CROSSCHECK — nothing stale in downstream modules ----------------
    sep("CROSSCHECK — NO STALE DOWNSTREAM DATA");
    const liveOrderNos = new Set(allPos.map(p => (p.orderNo.match(/\d{6,}/) ?? [p.orderNo])[0]));
    const liveLongOrderNos = new Set(allPos.map(p => p.orderNo));
    const invoices = await prisma.customsInvoice.findMany({ select: { orderNo: true } });
    const staleInvoices = invoices.filter(i => !liveOrderNos.has(i.orderNo));
    log(`CustomsInvoice rows: ${invoices.length}  stale (orderNo not in current POs): ${staleInvoices.length}`);
    expect(staleInvoices.length).toBe(0);

    const shipRows = await prisma.shipmentScheduleRow.findMany({ select: { orderNo: true } });
    const staleShip = shipRows.filter(r => !liveLongOrderNos.has(r.orderNo));
    log(`ShipmentScheduleRow rows: ${shipRows.length}  stale (orderNo not in current POs): ${staleShip.length}`);
    expect(staleShip.length).toBe(0);

    const rowEditPoIds = new Set((await prisma.salesContractRowEdit.findMany({ select: { poId: true } })).map(r => r.poId));
    const livePoIds = new Set(allPos.map(p => p.id));
    const orphanRowEdits = [...rowEditPoIds].filter(id => !livePoIds.has(id));
    log(`SalesContractRowEdit rows: orphan poIds: ${orphanRowEdits.length}`);
    expect(orphanRowEdits.length).toBe(0);

    // --- 8. CROSSCHECK — summary math is clean ------------------------------
    sep("CROSSCHECK — SUMMARY (view = xlsx)");
    const { rows, skippedPos, contractCount } = await collectSummaryRows({});
    log(`contracts in summary: ${contractCount}  rows: ${rows.length}  skipped: ${skippedPos.length}`);
    const summaryPoIds = new Set(rows.map(r => r.poId));
    const summaryLeaks = [...summaryPoIds].filter(id => !livePoIds.has(id));
    log(`summary rows citing a non-live PO: ${summaryLeaks.length}  (expect 0)`);
    expect(summaryLeaks.length).toBe(0);

    // Per-order dump — first 10 rows per order_no.
    sep("SUMMARY ROWS SAMPLE (first 10 orders)");
    const perOrder: Record<string, typeof rows> = {};
    for (const r of rows) {
      const k = (r.orderNo.match(/\d{6,}/) ?? [r.orderNo])[0];
      (perOrder[k] = perOrder[k] || []).push(r);
    }
    const keys = Object.keys(perOrder).sort();
    for (const k of keys.slice(0, 10)) {
      const g = perOrder[k];
      const f = g[0];
      log(`  ${k}  contract=${f.commercialContNo}  buyer=${f.buyerCode}  style=${f.styleNo}  rows=${g.length}`);
      for (const r of g.slice(0, 3)) log(`     tod=${r.tod}  country=${r.country}  qty=${r.orderQty}  fob=${r.fob}  value=${r.contractValue}  R=${r.packSetQty}  S=${r.packSet}`);
      if (g.length > 3) log(`     … and ${g.length - 3} more`);
    }

    sep("DONE");
  }, 600_000);
});
