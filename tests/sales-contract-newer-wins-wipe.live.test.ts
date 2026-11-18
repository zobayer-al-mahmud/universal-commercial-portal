/**
 * User rule 2026-11-03: when a newer-dated PO arrives, NO row from the old
 * version may remain in any module. This test proves it:
 *
 *   1) Seed an existing PO (644923-5672) with "manual edits" the user would
 *      have made against the OLD version: a CustomsInvoice (with a PDF),
 *      a SalesContractRowEdit, and a sheetEditsJson blob.
 *   2) Call the real replacePoWithNewerScan with a NEWER-dated extraction
 *      payload (same path triggered when an incoming scan beats the stored
 *      Creation date).
 *   3) Verify: zero customs invoices for this order, zero row edits for this
 *      poId, sheetEditsJson reset to "{}", PO's creationDate/poJson advanced
 *      to the new values, invoice PDF file removed from disk.
 *
 *   LIVE_RESCAN_TEST=1 npx vitest run tests/sales-contract-newer-wins-wipe.live.test.ts --reporter=verbose
 */
import { describe, it, expect } from "vitest";
import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prisma } from "@/lib/db";
import { _replacePoWithNewerScan } from "@/server/sales-contract/intake";

const RUN = process.env.LIVE_RESCAN_TEST === "1";
const d = RUN ? describe : describe.skip;

d("newer-wins wipes every trace of the old PO (live)", () => {
  it("CustomsInvoice + SalesContractRowEdit + sheetEditsJson all deleted", async () => {
    const log = (s: string = "") => console.log(s);
    const sep = (s: string) => log(`\n=== ${s} ===`);

    // --- 1. Pick a real PO as the test subject ------------------------------
    // Any READY PO works; the earlier hard-coded "644923" was from a prior
    // test run and isn't always present. We pick the first available one.
    const po = await prisma.salesContractPo.findFirst({
      where: { state: "READY" },
      select: { id: true, orderNo: true, creationDate: true, folderLetter: true, contractId: true },
    });
    expect(po, "No READY PO in DB — scan some first").toBeTruthy();
    if (!po) return;
    const shortOrder = (po.orderNo.match(/\d{6,}/) ?? ["644923"])[0];
    sep("SUBJECT");
    log(`PO ${po.orderNo}  id=${po.id}  creation=${po.creationDate}`);

    // --- 2. Seed artificial "user edits" tied to the OLD extract ------------
    sep("SEED MANUAL EDITS (user work on OLD version)");
    // Clean up leftovers from earlier test runs so our seeds are stable.
    await prisma.customsInvoice.deleteMany({ where: { orderNo: shortOrder, invoiceNumber: "TEST-INV-001" } });
    await prisma.salesContractPo.update({
      where: { id: po.id },
      data: { sheetEditsJson: JSON.stringify({ [po.orderNo]: { styleNo: "USER-EDITED", unitPrice: 99.99 } }) },
    });
    await prisma.salesContractRowEdit.create({
      data: { poId: po.id, marketCode: "OE", overridesJson: JSON.stringify({ cat: "USER-CAT" }), editedBy: "test-user" },
    });
    const seedPdfPath = join(tmpdir(), `test-invoice-${po.id}.pdf`);
    writeFileSync(seedPdfPath, Buffer.from("%PDF-1.4\n%%EOF\n"));
    await prisma.customsInvoice.create({
      data: {
        orderNo: shortOrder,
        countryCode: "OE",
        invoiceNumber: "TEST-INV-001",
        invoiceDate: "01 Nov, 2026",
        marketCode: "OE",
        marketSubCode: "OLCEU",
        pdfs: {
          create: {
            originalName: "test-invoice.pdf",
            sha256: "test-sha-" + Date.now(),
            sizeBytes: 20,
            storagePath: seedPdfPath,
            uploadedBy: "test-user",
          },
        },
      },
    });
    log(`seeded sheetEditsJson, 1 rowEdit, 1 customsInvoice (with PDF at ${seedPdfPath})`);
    expect(await prisma.salesContractRowEdit.count({ where: { poId: po.id } })).toBeGreaterThanOrEqual(1);
    expect(await prisma.customsInvoice.count({ where: { orderNo: shortOrder } })).toBeGreaterThanOrEqual(1);
    expect(existsSync(seedPdfPath)).toBe(true);

    // --- 3. Create a placeholder PO (= row the uploader would just have inserted) --
    sep("PLACEHOLDER FOR NEWER SCAN");
    const placeholder = await prisma.salesContractPo.create({
      data: {
        contractId: po.contractId,
        folderLetter: po.folderLetter,
        orderNo: `pending-${Date.now()}`,
        state: "EXTRACTING",
      },
    });

    // --- 4. Call the REAL production replacePoWithNewerScan -----------------
    const newerCreation = "15 Nov, 2026 10:30 AM v99";
    const newerPayload = {
      orderNo: po.orderNo,
      state: "READY",
      blockWrite: false,
      reasons: "",
      matchJson: "{}",
      reconJson: "{}",
      poJson: JSON.stringify({
        header: { productName: "REFRESHED-STYLE", creationDate: newerCreation },
        marketRows: [{ tod: "20 Dec, 2026", marketCode: "OE", marketCodeB: "OLCEU", quantity: 1234 }],
        noOfPieces: 1,
        invoiceAveragePrice: 7.5,
      }),
      sizeJson: "{}",
      countryJson: "{}",
      rowsJson: "[]",
      countryCodesJson: "[]",
      creationDate: newerCreation,
      warning: "",
      processedAt: new Date(),
      season: "",
      poYear: "2026",
    } as const;

    sep("CALL REAL replacePoWithNewerScan");
    const stats = await _replacePoWithNewerScan({
      placeholderPoId: placeholder.id,
      existingPoId: po.id,
      extractionPayload: newerPayload,
      actor: "test",
    });
    log(`wipe stats: ${JSON.stringify(stats)}`);
    // Loose bounds because pre-existing live state may contribute extra rows;
    // the ABSOLUTE post-condition checks below are the real proof.
    expect(stats.rowEdits).toBeGreaterThanOrEqual(1);
    expect(stats.invoices).toBeGreaterThanOrEqual(1);
    expect(stats.invoicePdfs).toBeGreaterThanOrEqual(1);
    expect(stats.hadSheetEdits).toBe(true);
    // Atomic rebuild inside the same txn — stats always report the result.
    expect(stats.shipmentRowsWiped).toBeGreaterThanOrEqual(0);
    expect(stats.shipmentRowsRouted + stats.shipmentRowsFailed).toBeGreaterThanOrEqual(1);

    // --- 5. Verify everything is gone + the PO carries the new data --------
    sep("VERIFY");
    const after = await prisma.salesContractPo.findUnique({
      where: { id: po.id },
      select: { creationDate: true, sheetEditsJson: true, poJson: true },
    });
    const edits = await prisma.salesContractRowEdit.count({ where: { poId: po.id } });
    const invs = await prisma.customsInvoice.count({ where: { orderNo: shortOrder } });
    const invPdfOnDisk = existsSync(seedPdfPath);
    const placeholderGone = (await prisma.salesContractPo.count({ where: { id: placeholder.id } })) === 0;
    log(`creationDate: ${after?.creationDate}  (want ${newerCreation})`);
    log(`sheetEditsJson: ${after?.sheetEditsJson}  (want "{}")`);
    log(`SalesContractRowEdit rows: ${edits}  (want 0)`);
    log(`CustomsInvoice rows for ${shortOrder}: ${invs}  (want 0)`);
    log(`seeded invoice PDF still on disk? ${invPdfOnDisk}  (want false)`);
    log(`placeholder row deleted? ${placeholderGone}  (want true)`);
    log(`poJson.header.productName: ${JSON.parse(after?.poJson || "{}").header?.productName}  (want REFRESHED-STYLE)`);

    expect(after?.creationDate).toBe(newerCreation);
    expect(after?.sheetEditsJson).toBe("{}");
    expect(edits).toBe(0);
    expect(invs).toBe(0);
    expect(invPdfOnDisk).toBe(false);
    expect(placeholderGone).toBe(true);
    expect(JSON.parse(after?.poJson || "{}").header?.productName).toBe("REFRESHED-STYLE");
  }, 180_000);
});
