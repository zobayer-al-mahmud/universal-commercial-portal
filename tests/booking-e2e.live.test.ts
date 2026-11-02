import { describe, it } from "vitest";
import { readFileSync } from "fs";
import { PrismaClient } from "@prisma/client";
import { parsePackingListXlsx } from "@/server/booking-correction/excel";
import { createBookingExcelBatch, processDocument } from "@/server/booking-correction/batch";

// Full live end-to-end over REAL PackingLists rows, driving the user's already-open
// Brave + logged-in Damco session (via the backend CDP connection). Read-only:
// searches, identifies, matches, retrieves the portal PDF — never confirms/modifies.
const runIt = process.env.RUN_BOOKING_E2E === "1" ? it : it.skip;
const FILE = "D:/UCP — REQUIRED DATA & FILES/PackingLists.xlsx";
const N = Number(process.env.N ?? "3");

describe("Booking Correction — live end-to-end (real data, user's Brave)", () => {
  runIt(
    "processes real rows through search → FR → validation → PDF",
    async () => {
      const prisma = new PrismaClient();
      const buffer = readFileSync(FILE);
      const parsed = await parsePackingListXlsx(buffer);
      const rows = parsed.rows.slice(0, N);
      console.log(`PARSED headerOk=${parsed.headerOk} totalRows=${parsed.rows.length} testing=${rows.length}`);

      const res = await createBookingExcelBatch({ name: "PackingLists.xlsx", buffer }, rows, { actor: "e2e" });
      console.log(`BATCH ${res.batchId} accepted=${res.accepted} invalid=${res.invalid}`);
      console.log(`UI: http://localhost:3300/booking/${res.batchId}\n`);

      const docs = await prisma.bookingDocument.findMany({ where: { batchId: res.batchId }, orderBy: { serial: "asc" } });
      for (const d of docs) {
        console.log(`\n==================== ROW ${d.rowNo}  PO ${d.poNumber} / SKU ${d.countryCode} / FR ${d.frCode}  (qty ${d.extractedQuantity}, ctn ${d.extractedCartons}, gw ${d.extractedGrossWeight}) ====================`);
        const t0 = Date.now();
        await processDocument(d.id, { actor: "e2e", force: true });
        const after = await prisma.bookingDocument.findUnique({ where: { id: d.id } });
        console.log(`-> ${((Date.now() - t0) / 1000).toFixed(1)}s  STATE=${after?.state}  OUTCOME=${after?.matchOutcome}  FINAL=${after?.finalStatus}`);
        console.log(`   bookingRef=${after?.bookingRef}  heading=${after?.headingStatus} field=${after?.fieldStatus}`);
        console.log(`   portalValues GW/Ctn/Qty = ${after?.bookingGrossWeight} / ${after?.bookingCartons} / ${after?.bookingQuantity}`);
        console.log(`   portalPdf=${after?.portalPdfPath ? "yes" : "no"}  sha=${(after?.portalPdfSha256 || "").slice(0, 12)}`);
        if (after?.warning) console.log(`   WARN: ${after.warning}`);
        if (after?.error) console.log(`   ERR: ${after.error}`);
        // Candidate list (search result) + match comparisons (validation)
        try {
          const cands = after?.candidatesJson ? JSON.parse(after.candidatesJson) : [];
          console.log(`   candidates(${cands.length}): ${cands.map((c: any) => c.soNumber).join(", ")}`);
        } catch { /* ignore */ }
        try {
          const m = after?.matchJson ? JSON.parse(after.matchJson) : null;
          if (m?.comparisons) for (const c of m.comparisons) console.log(`     ${c.match ? "✓" : "✗"} ${c.field}: in=${c.input} portal=${c.booking} ${c.difference || ""}`);
        } catch { /* ignore */ }
        const events = await prisma.bookingDocEvent.findMany({ where: { docId: d.id }, orderBy: { createdAt: "asc" } });
        console.log(`   events: ${events.map((e) => `${e.stage}:${e.status}`).join(" → ")}`);
      }

      const fresh = await prisma.bookingBatch.findUnique({ where: { id: res.batchId } });
      console.log(`\nBATCH SUMMARY status=${fresh?.status} liveStatus=${fresh?.liveStatus} completed=${fresh?.completedDocs} review=${fresh?.reviewDocs} failed=${fresh?.failedDocs}`);
      await prisma.$disconnect();
    },
    900_000,
  );
});
