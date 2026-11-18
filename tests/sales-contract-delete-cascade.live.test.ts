/**
 * User rule 2026-11-03: a Sales Contract Delete action must wipe EVERYTHING
 * downstream — all POs, their PDFs on disk, every ShipmentScheduleRow for
 * those orderNos, every CustomsInvoice (+ invoice PDFs on disk), and the
 * contract row itself. This test proves it on real data:
 *
 *   1. Snapshot pre-delete counts for contract 97 (POs, PDF paths, shipment
 *      rows). Seed one CustomsInvoice + PDF for one of its orderNos.
 *   2. Call the real deleteSalesContractWithCascade service function.
 *   3. Verify: contract gone, 0 POs/PDFs/edits for its orderNos, 0 shipment
 *      rows, 0 customs invoices, all PDF files gone from disk.
 *
 *   LIVE_RESCAN_TEST=1 npx vitest run tests/sales-contract-delete-cascade.live.test.ts --reporter=verbose
 */
import { describe, it, expect } from "vitest";
import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prisma } from "@/lib/db";
import { deleteSalesContractWithCascade } from "@/server/sales-contract/intake";

const RUN = process.env.LIVE_RESCAN_TEST === "1";
const d = RUN ? describe : describe.skip;

d("delete sales contract cascades through every module (live)", () => {
  it("contract + POs + PDFs + shipment rows + invoices all gone", async () => {
    const log = (s: string = "") => console.log(s);
    const sep = (s: string) => log(`\n=== ${s} ===`);

    // --- 1. Pick an existing contract as the delete target -----------------
    const contract = await prisma.salesContract.findFirst({
      where: { contractNo: "97" },
      select: { id: true, contractNo: true, marchentContNo: true },
    });
    expect(contract, "Contract 97 missing — run the user-end upload test first").toBeTruthy();
    if (!contract) return;
    sep("SUBJECT");
    log(`contract id=${contract.id}  contractNo=${contract.contractNo}  marchentContNo=${contract.marchentContNo}`);

    // --- 2. Snapshot pre-delete state --------------------------------------
    const pos = await prisma.salesContractPo.findMany({
      where: { contractId: contract.id },
      select: { id: true, orderNo: true, pdfs: { select: { storagePath: true } } },
    });
    const longOrderNos = pos.map(p => p.orderNo);
    const shortOrderNos = Array.from(new Set(longOrderNos.map(o => (o.match(/\d{6,}/) ?? [o])[0]).filter(Boolean)));
    const poPdfPaths = pos.flatMap(p => p.pdfs.map(f => f.storagePath));

    sep("BEFORE SNAPSHOT");
    log(`POs: ${pos.length}  short orderNos: ${shortOrderNos.length}  PO PDFs on disk: ${poPdfPaths.length}`);
    const existingShipmentRows = await prisma.shipmentScheduleRow.count({ where: { orderNo: { in: longOrderNos } } });
    log(`ShipmentScheduleRow for these orderNos: ${existingShipmentRows}`);

    // Seed a CustomsInvoice + 1 PDF for one of this contract's orderNos so
    // the delete has something to wipe from the invoice side (otherwise this
    // contract hasn't produced invoices yet in this test env).
    const seedOrder = shortOrderNos[0];
    expect(seedOrder, "contract 97 has no POs to seed an invoice against").toBeTruthy();
    const seedPdfPath = join(tmpdir(), `test-delete-invoice-${Date.now()}.pdf`);
    writeFileSync(seedPdfPath, Buffer.from("%PDF-1.4\n%%EOF\n"));
    const inv = await prisma.customsInvoice.create({
      data: {
        orderNo: seedOrder,
        countryCode: "OE",
        invoiceNumber: `DEL-TEST-${Date.now()}`,
        invoiceDate: "01 Nov, 2026",
        marketCode: "OE",
        marketSubCode: "OLCEU",
        pdfs: { create: { originalName: "delete-test.pdf", sha256: "del" + Date.now(), sizeBytes: 20, storagePath: seedPdfPath, uploadedBy: "test" } },
      },
      include: { pdfs: true },
    });
    log(`seeded CustomsInvoice for order ${seedOrder}: ${inv.id} (+1 PDF at ${seedPdfPath})`);

    // Also seed one SalesContractRowEdit on one of the POs.
    await prisma.salesContractRowEdit.create({
      data: { poId: pos[0].id, marketCode: "OE", overridesJson: JSON.stringify({ cat: "DELETE-TEST" }), editedBy: "test-user" },
    });

    const beforeCounts = {
      pos: await prisma.salesContractPo.count({ where: { contractId: contract.id } }),
      poPdfs: await prisma.salesContractPdf.count({ where: { po: { contractId: contract.id } } }),
      rowEdits: await prisma.salesContractRowEdit.count({ where: { po: { contractId: contract.id } } }),
      shipmentRows: await prisma.shipmentScheduleRow.count({ where: { orderNo: { in: longOrderNos } } }),
      customsInvoices: await prisma.customsInvoice.count({ where: { orderNo: { in: shortOrderNos } } }),
      customsInvoicePdfs: await prisma.customsInvoicePdf.count({ where: { invoice: { orderNo: { in: shortOrderNos } } } }),
    };
    log(`BEFORE: ${JSON.stringify(beforeCounts)}`);
    expect(beforeCounts.customsInvoices).toBeGreaterThan(0);
    expect(beforeCounts.rowEdits).toBeGreaterThan(0);
    expect(beforeCounts.poPdfs).toBeGreaterThan(0);

    // --- 3. Call the REAL delete service -----------------------------------
    sep("DELETE");
    const result = await deleteSalesContractWithCascade(contract.id, { actor: "test" });
    log(`result: ${JSON.stringify(result)}`);
    expect(result.pos).toBe(pos.length);
    expect(result.poPdfs).toBe(poPdfPaths.length);
    expect(result.customsInvoices).toBeGreaterThan(0);
    expect(result.invoicePdfs).toBeGreaterThan(0);

    // --- 4. Verify total wipe ----------------------------------------------
    sep("AFTER VERIFY");
    const afterCounts = {
      contract: await prisma.salesContract.count({ where: { id: contract.id } }),
      pos: await prisma.salesContractPo.count({ where: { contractId: contract.id } }),
      poPdfs: await prisma.salesContractPdf.count({ where: { po: { contractId: contract.id } } }),
      rowEdits: await prisma.salesContractRowEdit.count({ where: { po: { contractId: contract.id } } }),
      shipmentRows: await prisma.shipmentScheduleRow.count({ where: { orderNo: { in: longOrderNos } } }),
      customsInvoices: await prisma.customsInvoice.count({ where: { orderNo: { in: shortOrderNos } } }),
      customsInvoicePdfs: await prisma.customsInvoicePdf.count({ where: { invoice: { orderNo: { in: shortOrderNos } } } }),
    };
    log(`AFTER: ${JSON.stringify(afterCounts)}`);
    log(`seeded invoice PDF still on disk? ${existsSync(seedPdfPath)}  (want false)`);
    for (const path of poPdfPaths.slice(0, 5)) log(`  PO pdf on disk? ${existsSync(path)}  ← ${path}`);

    expect(afterCounts.contract).toBe(0);
    expect(afterCounts.pos).toBe(0);
    expect(afterCounts.poPdfs).toBe(0);
    expect(afterCounts.rowEdits).toBe(0);
    expect(afterCounts.shipmentRows).toBe(0);
    expect(afterCounts.customsInvoices).toBe(0);
    expect(afterCounts.customsInvoicePdfs).toBe(0);
    expect(existsSync(seedPdfPath)).toBe(false);
    for (const path of poPdfPaths) expect(existsSync(path), `PO pdf still on disk: ${path}`).toBe(false);

    sep("DONE");
  }, 180_000);
});
