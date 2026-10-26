import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import { isValidContainerNo, parseContainerList, parseContainerXlsx } from "@/server/container/batch";

describe("isValidContainerNo", () => {
  it("accepts ISO 6346 shaped numbers (4 letters + 7 digits), ignoring spaces/case", () => {
    expect(isValidContainerNo("TLLU4872965")).toBe(true);
    expect(isValidContainerNo("tllu 4872965")).toBe(true);
    expect(isValidContainerNo("MSKU-1234567")).toBe(true);
  });
  it("rejects malformed numbers", () => {
    expect(isValidContainerNo("1234567")).toBe(false);      // no owner letters
    expect(isValidContainerNo("TLLU487296")).toBe(false);   // only 6 digits
    expect(isValidContainerNo("TLL44872965")).toBe(false);  // 3 letters + digit
    expect(isValidContainerNo("")).toBe(false);
  });
});

describe("parseContainerList", () => {
  it("splits on newlines/commas/spaces, normalizes, de-dupes, and flags invalids", () => {
    const r = parseContainerList("TLLU4872965\nmsku1234567 , TLLU4872965\n99999\nMRKU7654321");
    expect(r.valid).toEqual(["TLLU4872965", "MSKU1234567", "MRKU7654321"]);
    expect(r.duplicates).toEqual(["TLLU4872965"]);
    expect(r.invalid.map((i) => i.raw)).toEqual(["99999"]);
  });
  it("returns empty for blank input", () => {
    expect(parseContainerList("   ").valid).toEqual([]);
  });
});

describe("parseContainerXlsx", () => {
  it("finds a 'Container' header column and collects valid numbers below it", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Sheet1");
    ws.getRow(1).values = ["No.", "Container No.", "Notes"];
    ws.getRow(2).values = [1, "TLLU4872965", "x"];
    ws.getRow(3).values = [2, "MSKU1234567", "y"];
    ws.getRow(4).values = [3, "BADNUM", "z"];
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const r = await parseContainerXlsx(buf);
    expect(r.valid).toEqual(["TLLU4872965", "MSKU1234567"]);
    expect(r.invalid.map((i) => i.raw)).toEqual(["BADNUM"]);
  });
  it("falls back to column A when no Container header exists", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Sheet1");
    ws.getRow(1).values = ["TLLU4872965"];
    ws.getRow(2).values = ["MSKU1234567"];
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const r = await parseContainerXlsx(buf);
    expect(r.valid).toEqual(["TLLU4872965", "MSKU1234567"]);
  });
});
