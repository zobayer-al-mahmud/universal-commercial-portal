import { describe, it, expect } from "vitest";
import { buildBookingPdf } from "@/server/booking-correction/pdf-writer";
import { buildZip } from "@/server/booking-correction/zip";

describe("buildBookingPdf", () => {
  const pdf = buildBookingPdf({ title: "BOOKING CONFIRMED", lines: ["SO Number: SO-SAMPLE-001", "Gross Weight: 88.61 kg"], footer: "test" });

  it("produces a valid PDF header and trailer", () => {
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(pdf.toString("latin1")).toContain("%%EOF");
  });

  it("embeds the heading and values as text", () => {
    const text = pdf.toString("latin1");
    expect(text).toContain("BOOKING CONFIRMED");
    expect(text).toContain("SO-SAMPLE-001");
  });

  it("is readable/valid per pdfIsReadable (parses + has a page)", async () => {
    const { pdfIsReadable } = await import("@/server/booking-correction/extract");
    const r = await pdfIsReadable(pdf);
    expect(r.ok).toBe(true);
    expect(r.pages).toBeGreaterThanOrEqual(1);
  });
});

describe("buildZip", () => {
  it("produces a valid ZIP (PK local header + EOCD) with the right entry count", () => {
    const zip = buildZip([
      { name: "a.pdf", data: Buffer.from("%PDF-1.4 a") },
      { name: "b.pdf", data: Buffer.from("%PDF-1.4 bb") },
    ]);
    expect(zip.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04])); // PK\x03\x04
    // EOCD signature PK\x05\x06 near the end, with 2 entries.
    const eocd = zip.subarray(zip.length - 22);
    expect(eocd.readUInt32LE(0)).toBe(0x06054b50);
    expect(eocd.readUInt16LE(10)).toBe(2);
  });

  it("is empty-safe", () => {
    const zip = buildZip([]);
    expect(zip.length).toBe(22); // EOCD only
  });
});
