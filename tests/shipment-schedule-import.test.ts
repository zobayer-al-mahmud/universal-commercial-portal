import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import { parseScheduleXlsx, isValidOrderNo, orderShortKey } from "@/server/shipment-schedule/import-xlsx";

const HEADERS = ["Buyer Code", "Cont.No.", "Date", "OrderNo.", "PCS", "STYLE", "FOB", "COMPOSITION", "CAT", "HTS", "Value", "INVOICE", "Market+Sub", "Market", "Mode"];

async function makeXlsx(rows: (string | number | null)[][], opts: { title?: boolean } = {}): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  let r = 1;
  if (opts.title) { ws.getRow(r).values = ["Week 32 1st cut off"]; r++; }
  ws.getRow(r).values = HEADERS; r++;
  for (const row of rows) { ws.getRow(r).values = row; r++; }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe("order number helpers", () => {
  it("validates 6+ digit order numbers", () => {
    expect(isValidOrderNo("745408-8313")).toBe(true);
    expect(isValidOrderNo("644637")).toBe(true);
    expect(isValidOrderNo("ABC")).toBe(false);
    expect(isValidOrderNo("")).toBe(false);
  });
  it("extracts the short join key", () => {
    expect(orderShortKey("745408-8313")).toBe("745408");
    expect(orderShortKey("498160/8757")).toBe("498160");
    expect(orderShortKey("x")).toBe("x");
  });
});

describe("parseScheduleXlsx", () => {
  it("maps the exported columns to fields and skips blank Order No rows", async () => {
    const buf = await makeXlsx([
      ["AGL 365 C", "AGL/H&M/42/2026", "01.09.2026", "745408-8313", 263, "ST-9", 5.51, "Cotton Shirt", "FCA", "Sea", "", "45238", "PEW153", "PE", "CFS/CY"],
      ["", "", "", "", "", "", "", "", "", "", "", "", "", "", ""], // blank → skipped
    ]);
    const { rows } = await parseScheduleXlsx(buf);
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.orderNo).toBe("745408-8313");
    expect(r.buyerCode).toBe("AGL 365 C");
    expect(r.contractNo).toBe("AGL/H&M/42/2026");
    expect(r.pcs).toBe(263);
    expect(r.fob).toBeCloseTo(5.51);
    expect(r.invoiceNo).toBe("45238");
    expect(r.marketSubCode).toBe("PEW153");
    expect(r.marketCode).toBe("PE");
    expect(r.transportMode).toBe("CFS/CY");
  });
  it("finds the header even when a title banner row precedes it", async () => {
    const buf = await makeXlsx([["AGL 1", "C1", "01.01.2026", "900001-1", 10, "S", 2, "desc", "FCA", "Sea", "", "INV1", "OBW1", "OB", "Sea"]], { title: true });
    const { rows } = await parseScheduleXlsx(buf);
    expect(rows).toHaveLength(1);
    expect(rows[0].orderNo).toBe("900001-1");
  });
  it("reports when no header row is present", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Sheet1");
    ws.getRow(1).values = ["nothing", "useful", "here"];
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const { rows, rejected } = await parseScheduleXlsx(buf);
    expect(rows).toHaveLength(0);
    expect(rejected[0].reason).toMatch(/OrderNo/i);
  });
});
