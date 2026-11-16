import { describe, it, expect } from "vitest";
import { expPdfBase, expPdfFilename, uniqueExpPdfName, type ExpNameFields } from "@/server/exp-automation/output-name";

/**
 * EXP PDF naming: name by the record's own EXP fields, with a stable priority
 * (Save_As → EXP No → ADSCode_Serial_Year → Invoice → row). Flat, sanitised,
 * de-duplicated — never a path, never ".pdf/" nesting, never an overwrite.
 */
describe("expPdfBase priority", () => {
  it("prefers an explicit Save_As (Download rows keep their name)", () => {
    const row: ExpNameFields = { saveAs: "MyExport.pdf", expNo: "26120000123456", adscode: "012345", expSerial: "4408", expYear: "2026" };
    expect(expPdfBase(row)).toBe("MyExport");
    expect(expPdfFilename(row)).toBe("MyExport.pdf");
  });

  it("uses EXP No when there is no Save_As (Correction/Duplicate)", () => {
    expect(expPdfFilename({ expNo: "26120000123456", adscode: "012345", expSerial: "4408", expYear: "2026" })).toBe("26120000123456.pdf");
  });

  it("falls back to ADSCode_Serial_Year when there is no EXP No", () => {
    expect(expPdfFilename({ adscode: "012345", expSerial: "4408", expYear: "2026" })).toBe("012345_4408_2026.pdf");
  });

  it("falls back to the invoice, then the row number", () => {
    expect(expPdfFilename({ invoiceNo: "64408TW" })).toBe("64408TW.pdf");
    expect(expPdfFilename({ rowNo: 7 })).toBe("row-7.pdf");
    expect(expPdfFilename({})).toBe("exp.pdf");
  });

  it("sanitises to a flat, safe basename (no paths, no double extension)", () => {
    expect(expPdfBase({ saveAs: "../../etc/pa ss?.pdf" })).toBe("etc_pa_ss");
    expect(expPdfBase({ saveAs: "a/b\\c.pdf" })).toBe("a_b_c");
    // A partial AD/serial/year set must NOT produce "012345__2026".
    expect(expPdfFilename({ adscode: "012345", expYear: "2026" })).toBe("012345.pdf");
  });
});

describe("uniqueExpPdfName de-duplication", () => {
  it("suffixes -2, -3 so two rows with the same identifier never overwrite", () => {
    const used = new Set<string>();
    const a = { expNo: "26120000123456" };
    expect(uniqueExpPdfName(a, used)).toBe("26120000123456.pdf");
    expect(uniqueExpPdfName(a, used)).toBe("26120000123456-2.pdf");
    expect(uniqueExpPdfName(a, used)).toBe("26120000123456-3.pdf");
  });

  it("is case-insensitive when detecting collisions", () => {
    const used = new Set<string>();
    expect(uniqueExpPdfName({ saveAs: "Export" }, used)).toBe("Export.pdf");
    expect(uniqueExpPdfName({ saveAs: "export" }, used)).toBe("export-2.pdf");
  });
});
