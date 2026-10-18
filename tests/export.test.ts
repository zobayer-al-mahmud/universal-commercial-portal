import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import { buildScheduleWorkbook, type ScheduleLineExport } from "@/server/export/schedule-workbook";
import { buildCustomsInvoiceWorkbook, type InvoiceExport } from "@/server/export/customs-invoice-workbook";

const LINE: ScheduleLineExport = {
  weekNo: 43, firstCutOff: "2026-10-19", secondCutOff: "2026-10-23",
  buyerCode: "AGL 365 C", contractNo: "AGL/H&M/99/2026", contractDate: "2026-06-09",
  orderNo: "644637-8756", pcs: 2500, style: "Slim Denim", fob: 10.5,
  composition: "Women Woven", incoterm: "FCA", transport: "Sea",
  value: 26250, marketCode: "OW", invoiceNo: "66000", cutOff: "1st",
};

const INVOICE: InvoiceExport = {
  invoiceKey: "66000 OW", invoiceNumber: "66000", marketCode: "OW", invoiceDate: "28.12.2025",
  contractNo: "AGL/H&M/99/2026", contractDate: "2026-06-09", hmOrderNo: "644637-8756",
  expNo: "31999", expDate: "28.12.2025", portOfLoading: "CHITTAGONG", portOfDelivery: "Singapore",
  countryOfOrigin: "Bangladesh", countryOfFinalDestination: "MALAYSIA", currency: "USD",
  exporterName: "ANANTA GARMENTS LIMITED", buyerName: "H&M GBC AB", consigneeName: "H&M GBC AB",
  cargoDeliveryName: "Consignee X", totalQty: 2500, totalValue: 26250,
  lineItems: [{ description: "Women Woven Trouser", hsCode: "62046200", quantity: 2500, unitPrice: 10.5, amount: 26250 }],
};

describe("buildScheduleWorkbook", () => {
  it("produces a Summary sheet with title, header and data", async () => {
    const buf = await buildScheduleWorkbook([LINE]);
    expect(buf.byteLength).toBeGreaterThan(1000);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const ws = wb.getWorksheet("Summary")!;
    expect(String(ws.getRow(1).getCell(1).value)).toContain("Week 43");
    expect(String(ws.getRow(2).getCell(1).value)).toBe("Buyer Code");
    expect(String(ws.getRow(3).getCell(4).value)).toBe("644637-8756");
  });
});

describe("buildCustomsInvoiceWorkbook", () => {
  it("produces INVOICE, SUMMARY and BL DRAFT sheets with the totals", async () => {
    const buf = await buildCustomsInvoiceWorkbook(INVOICE);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    expect(wb.getWorksheet("INVOICE")).toBeTruthy();
    const sum = wb.getWorksheet("SUMMARY")!;
    expect(String(sum.getRow(2).getCell(2).value)).toBe("66000 OW");

    const bl = wb.getWorksheet("BL DRAFT");
    expect(bl).toBeTruthy();
    // The BL DRAFT must carry the shipper, the negotiating bank, and the invoice key.
    const text = bl!.getSheetValues().flat().map((v) => String(v ?? "")).join(" | ");
    expect(text).toContain("ANANTA GARMENTS LIMITED");
    expect(text).toContain("PRIME BANK LTD.");
    expect(text).toContain("66000 OW");
  });
});
