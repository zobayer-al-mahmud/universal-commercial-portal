import { describe, it, expect } from "vitest";
import { buildPlan, type ProcessedFile } from "@/server/pdf-rename/folder-rename";
import { buildG4Tiff } from "@/server/pdf-rename/ocr";

function processed(partial: Partial<ProcessedFile> & { originalName: string }): ProcessedFile {
  return {
    docType: "bill-of-export",
    invoiceNumber: null,
    raw: null,
    countryToken: null,
    source: "text",
    method: "text-bill",
    textChars: 2400,
    pages: 1,
    status: "planned",
    reason: "",
    ...partial,
  };
}

describe("buildPlan", () => {
  it("assigns <invoice>.pdf targets to files with a number read", () => {
    const { items, summary } = buildPlan([
      processed({ originalName: "a.pdf", invoiceNumber: "65341" }),
      processed({ originalName: "b.pdf", invoiceNumber: "65342" }),
    ]);
    expect(items.map((i) => i.newName)).toEqual(["65341.pdf", "65342.pdf"]);
    expect(summary.planned).toBe(2);
    expect(summary.collision).toBe(0);
  });

  it("flags duplicate invoice numbers as a collision and renames neither", () => {
    const { items, summary } = buildPlan([
      processed({ originalName: "a.pdf", invoiceNumber: "65341" }),
      processed({ originalName: "b.pdf", invoiceNumber: "65341" }),
      processed({ originalName: "c.pdf", invoiceNumber: "65999" }),
    ]);
    expect(summary.collision).toBe(2);
    expect(summary.planned).toBe(1);
    const dupes = items.filter((i) => i.status === "collision");
    expect(dupes.every((d) => /Duplicate invoice/.test(d.reason))).toBe(true);
  });

  it("carries needs_review files through without a target", () => {
    const { items, summary } = buildPlan([
      processed({ originalName: "scan.pdf", status: "needs_review", invoiceNumber: null, reason: "OCR disabled" }),
    ]);
    expect(items[0].newName).toBeNull();
    expect(summary.needsReview).toBe(1);
  });
});

describe("buildG4Tiff", () => {
  it("wraps raw G4 bytes in a little-endian Group-4 TIFF", () => {
    const raw = Buffer.from([0x26, 0xa0, 0x00, 0xff]);
    const tiff = buildG4Tiff(raw, 1648, 2336, 0);
    // Byte-order mark + magic.
    expect(tiff.subarray(0, 2).toString("latin1")).toBe("II");
    expect(tiff.readUInt16LE(2)).toBe(42);
    // IFD at offset 8; first entry is ImageWidth (tag 256) = 1648.
    const ifd = tiff.readUInt32LE(4);
    const nEntries = tiff.readUInt16LE(ifd);
    expect(nEntries).toBe(12);
    expect(tiff.readUInt16LE(ifd + 2)).toBe(256); // ImageWidth tag
    expect(tiff.readUInt32LE(ifd + 2 + 8)).toBe(1648);
    // Compression tag (259) must be 4 (CCITT Group 4).
    let compression = 0;
    for (let e = 0; e < nEntries; e++) {
      const o = ifd + 2 + e * 12;
      if (tiff.readUInt16LE(o) === 259) compression = tiff.readUInt16LE(o + 8);
    }
    expect(compression).toBe(4);
    // The raw fax bytes are appended verbatim at the end.
    expect(tiff.subarray(tiff.length - raw.length).equals(raw)).toBe(true);
  });
});
