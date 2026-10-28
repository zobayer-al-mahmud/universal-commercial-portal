import { readFileSync } from "fs";
import { parseBookingFilename } from "@/server/shipment-schedule/parse-filename";
import { parseBookingPdfText } from "@/server/shipment-schedule/parse-booking-pdf";
import { parsePdfText } from "@/server/pdf/parse-pdf";

async function main() {
  const buf = readFileSync("D:/Running Backup/Downloads/698518.pdf");
  const fn = parseBookingFilename("698518.pdf");
  const { text } = await parsePdfText(buf);
  console.log("---lines near TOTAL---");
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const tIdx = lines.findIndex((l) => /^TOTAL\s*:/i.test(l));
  for (let i = Math.max(0, tIdx - 15); i < Math.min(lines.length, tIdx + 10); i++) {
    console.log(`${i === tIdx ? "*" : " "}${i}:`, JSON.stringify(lines[i]));
  }
  console.log("---end---");
  const pdf = parseBookingPdfText(text);
  console.log("filename:", JSON.stringify(fn));
  console.log("pdfOrderNo:", pdf.pdfOrderNo, "| categories:", pdf.categories, "| derivedMarket:", pdf.categories.slice(0, 2));
  console.log("bcn:", pdf.bcn, "| bookingRef:", pdf.bookingRef, "| status:", pdf.bookingStatus);
  console.log("POL:", pdf.portOfLoading, "| POD:", pdf.portOfDischarge, "| PlaceOfDelivery:", pdf.placeOfDelivery);
  console.log("mode:", pdf.transportMode, "| pcs:", pdf.pdfPcs, "| cartons:", pdf.cartons);
  console.log("weight:", pdf.grossWeightKg, "kg | cbm:", pdf.measurementCbm);
  console.log("skuItem:", pdf.skuItem);
}
main();
