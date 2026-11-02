import { describe, it } from "vitest";
import { readFileSync } from "fs";
import { PrismaClient } from "@prisma/client";
import { parsePackingListXlsx } from "@/server/booking-correction/excel";
import { createBookingExcelBatch, processDocument } from "@/server/booking-correction/batch";

const runIt = process.env.RUN_BOOKING_1ROW === "1" ? it : it.skip;
const FILE = "D:/UCP — REQUIRED DATA & FILES/PackingLists.xlsx";
const ROW = Number(process.env.ROW ?? "1");

describe("Booking Correction — live 1-row end-to-end", () => {
  runIt(
    "processes a single PackingLists row against the live Damco portal",
    async () => {
      const prisma = new PrismaClient();
      const buffer = readFileSync(FILE);
      const parsed = await parsePackingListXlsx(buffer);
      console.log("headerOk:", parsed.headerOk, "missing:", parsed.missingColumns, "rows:", parsed.rows.length);

      const one = parsed.rows[ROW - 1];
      console.log("TEST ROW:", JSON.stringify(one));

      const res = await createBookingExcelBatch({ name: "PackingLists.xlsx", buffer }, [one], { actor: "vitest-1row" });
      console.log("batchId:", res.batchId, "accepted:", res.accepted, "invalid:", res.invalid);

      const doc = await prisma.bookingDocument.findFirst({ where: { batchId: res.batchId }, orderBy: { serial: "asc" } });
      if (!doc) { console.log("No document created."); await prisma.$disconnect(); return; }
      console.log("doc:", doc.id, "po:", doc.poNumber, "sku:", doc.countryCode, "fr:", doc.frCode,
        "qty:", doc.extractedQuantity, "ctn:", doc.extractedCartons, "gw:", doc.extractedGrossWeight);

      console.log("\n--- processing LIVE (watch the visible Damco window) ---");
      const t0 = Date.now();
      await processDocument(doc.id, { actor: "vitest-1row", force: true });
      console.log(`--- returned in ${((Date.now() - t0) / 1000).toFixed(1)}s ---`);

      const after = await prisma.bookingDocument.findUnique({ where: { id: doc.id } });
      console.log("RESULT state:", after?.state, "outcome:", after?.matchOutcome, "final:", after?.finalStatus);
      console.log("bookingRef:", after?.bookingRef, "heading:", after?.headingStatus, "field:", after?.fieldStatus);
      console.log("WARN:", after?.warning);
      console.log("ERR:", after?.error);

      const events = await prisma.bookingDocEvent.findMany({ where: { docId: doc.id }, orderBy: { createdAt: "asc" } });
      console.log("\n--- events ---");
      for (const e of events) console.log(`  [${e.stage}] ${e.status}: ${e.message}`);

      await prisma.$disconnect();
    },
    600_000,
  );
});
