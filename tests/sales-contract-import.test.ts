import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import { parseSalesContractXlsx } from "@/server/hm-sales-contract/import-xlsx";

/** Build a Sales Contract export-shaped xlsx in-memory for parse tests. */
async function buildXlsx(opts: {
  headers?: string[];
  dataRows?: (string | number | null)[][];
  bannerRows?: (string | number | null)[][];
}): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sales Contract");
  for (const b of opts.bannerRows ?? []) ws.addRow(b);
  if (opts.headers) ws.addRow(opts.headers);
  for (const r of opts.dataRows ?? []) ws.addRow(r);
  const arr = (await wb.xlsx.writeBuffer()) as ArrayBuffer;
  return Buffer.from(arr);
}

const HEADERS = [
  "Order No.", "Style No.", "Description", "Order Qty",
  "Total Qty With Packs", "Unit Price", "Value", "Time of Delivery",
];

describe("Sales Contract bulk import parser (user spec 2026-10-20)", () => {
  it("extracts rows from a plain layout (header on row 1, data below)", async () => {
    const buf = await buildXlsx({
      headers: HEADERS,
      dataRows: [
        ["643159-8756", "Slim denim", "Boys Jeans", 4078, 4078, 6.18, 25201.8, "29 Jun, 2026"],
        ["729708-1234", "Classic tee", "Men Cotton Tee", 3000, 3000, 8.6, 25800.0, "31 Aug, 2026"],
      ],
    });
    const { rows, rejectedRows } = await parseSalesContractXlsx(buf);
    expect(rejectedRows).toEqual([]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      orderNo: "643159-8756", styleNo: "Slim denim", itemDes: "Boys Jeans",
      orderQty: 4078, totalWithPacks: 4078, fob: 6.18, value: 25201.8, tod: "29 Jun, 2026",
    });
    expect(rows[1].orderNo).toBe("729708-1234");
  });

  it("finds the header row below a banner (rows 1-4 non-header)", async () => {
    const buf = await buildXlsx({
      bannerRows: [
        ["Block Contract Ref:  : AGL/H&M/99/2026"],
        [],
        ["Revise: 21"],
        [],
      ],
      headers: HEADERS,
      dataRows: [["691351-5686", "Cub RX Cargo", "Men Trousers", 3000, 3000, 8.6, 25800, "31 Aug, 2026"]],
    });
    const { rows } = await parseSalesContractXlsx(buf);
    expect(rows).toHaveLength(1);
    expect(rows[0].orderNo).toBe("691351-5686");
  });

  it("accepts case-insensitive header names and common synonyms (order no / orderno / tod)", async () => {
    const buf = await buildXlsx({
      headers: ["ORDERNO", "style no", "description", "order qty", "total qty", "fob", "value", "TOD"],
      dataRows: [["123-456", "", "", 10, 10, 1.5, 15, ""]],
    });
    const { rows } = await parseSalesContractXlsx(buf);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ orderNo: "123-456", orderQty: 10, fob: 1.5, value: 15 });
  });

  it("skips rows with blank Order No. without erroring", async () => {
    const buf = await buildXlsx({
      headers: HEADERS,
      dataRows: [
        ["", "", "", null, null, null, null, ""],
        ["643159-8756", "Slim", "Jeans", 100, 100, 2, 200, "today"],
        [null, null, null, null, null, null, null, null],
      ],
    });
    const { rows } = await parseSalesContractXlsx(buf);
    expect(rows).toHaveLength(1);
    expect(rows[0].orderNo).toBe("643159-8756");
  });

  it("rejects a workbook whose header row cannot be found", async () => {
    const buf = await buildXlsx({
      bannerRows: [["Random title"], ["more junk"]],
      // no HEADERS row at all
      dataRows: [["X", "Y"]],
    });
    const { rows, rejectedRows } = await parseSalesContractXlsx(buf);
    expect(rows).toEqual([]);
    expect(rejectedRows.length).toBe(1);
    expect(rejectedRows[0].reason).toMatch(/Order No/i);
  });

  it("tolerates missing non-Order-No columns (fields default to blank / null)", async () => {
    const buf = await buildXlsx({
      headers: ["Order No.", "Order Qty"],
      dataRows: [["999-111", 50]],
    });
    const { rows } = await parseSalesContractXlsx(buf);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      orderNo: "999-111", orderQty: 50,
      styleNo: "", itemDes: "", totalWithPacks: null, fob: null, value: null, tod: "",
    });
  });

  it("extracts the cached result of a formula cell (e.g. Value = D*F)", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Sales Contract");
    ws.addRow(HEADERS);
    const dataRow = ws.addRow(["643159-8756", "S", "D", 10, 10, 2, null, "today"]);
    // Replace Value with a formula + cached result.
    dataRow.getCell(7).value = { formula: "D2*F2", result: 20 } as unknown as ExcelJS.CellFormulaValue;
    const buf = Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
    const { rows } = await parseSalesContractXlsx(buf);
    expect(rows[0].value).toBe(20);
  });
});
