import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import { existsSync, readdirSync } from "fs";
import { join } from "path";
import { parseInvoiceBulkXlsx } from "@/server/customs-invoice/bulk";
import { sanitizeColumnPlan, sanitizeTemplateOverrides } from "@/server/customs-invoice/config";
import { listTemplates, resolveTemplate } from "@/server/customs-invoice/templates";
import { patchTemplate } from "@/server/customs-invoice/zip-write";
import type { InvoiceFields } from "@/server/customs-invoice/types";

async function xlsx(rows: (string | number | null)[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  rows.forEach((r, i) => { ws.getRow(i + 1).values = r; });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe("parseInvoiceBulkXlsx", () => {
  const HEADERS = ["Order No.", "Country code", "Invoice No.", "Quantity (PCS)", "Unit price"];
  it("maps columns and keys rows by short Order No.", async () => {
    const buf = await xlsx([
      HEADERS,
      ["498160/8757", "NH", "45238", 263, 5.51],
      ["644637-8756", "OB", "45237", 100, 2.5],
    ]);
    const { rows, rejected } = await parseInvoiceBulkXlsx(buf);
    expect(rejected).toHaveLength(0);
    expect(rows).toHaveLength(2);
    expect(rows[0].orderKey).toBe("498160");
    expect(rows[0].marketCode).toBe("NH");
    expect(rows[0].fields.invoiceNumber).toBe("45238");
    expect(rows[0].fields.quantityPcs).toBe(263);
    expect(rows[0].fields.unitPrice).toBeCloseTo(5.51);
  });
  it("rejects rows missing an Order No. or a country code", async () => {
    const buf = await xlsx([
      HEADERS,
      ["", "NH", "1", 1, 1],            // no order → rejected
      ["700001-1", "", "2", 2, 2],      // no country → rejected
      ["700002-2", "OB", "3", 3, 3],    // ok
    ]);
    const { rows, rejected } = await parseInvoiceBulkXlsx(buf);
    expect(rows).toHaveLength(1);
    expect(rows[0].orderKey).toBe("700002");
    expect(rejected.length).toBe(2);
  });
  it("reports when no usable header row exists", async () => {
    const buf = await xlsx([["foo", "bar", "baz"], ["1", "2", "3"]]);
    const { rows, rejected } = await parseInvoiceBulkXlsx(buf);
    expect(rows).toHaveLength(0);
    expect(rejected[0].reason).toMatch(/Order No/i);
  });
});

describe("generation config validation", () => {
  it("sanitizeColumnPlan drops invalid cols/fields/kinds and de-dupes columns", () => {
    const clean = sanitizeColumnPlan([
      { col: "a", field: "invoiceNumber", kind: "string" },  // lowercased → A
      { col: "A", field: "contractNo", kind: "string" },     // dup col A → dropped
      { col: "F", field: "unitPrice", kind: "number" },
      { col: "1", field: "contractNo", kind: "string" },     // bad col → dropped
      { col: "G", field: "notAField", kind: "string" },      // bad field → dropped
      { col: "H", field: "category", kind: "weird" },        // bad kind → dropped
    ]);
    expect(clean).toEqual([
      { col: "A", field: "invoiceNumber", kind: "string" },
      { col: "F", field: "unitPrice", kind: "number" },
    ]);
  });
  it("sanitizeTemplateOverrides drops codes pointing at non-existent template files", () => {
    const ov = sanitizeTemplateOverrides({ OB: "definitely-not-a-real-template.xlsx" });
    expect(ov).toEqual({});
  });
});

// End-to-end: a custom column plan writes a field into a different cell.
const TEMPLATE_DIR = existsSync(join(process.cwd(), "Customs Invoice templates and sample files"))
  ? join(process.cwd(), "Customs Invoice templates and sample files")
  : (process.env.CUSTOMS_INVOICE_TEMPLATE_DIR || "");
const hasTemplates = !!TEMPLATE_DIR && existsSync(TEMPLATE_DIR) && readdirSync(TEMPLATE_DIR).some((f) => f.endsWith(".xlsx"));

describe.skipIf(!hasTemplates)("custom column plan routes a value to a chosen cell", () => {
  const BASE: InvoiceFields = {
    invoiceNumber: "90009", invoiceDate: "", contractNo: "AGL/H&M/42/2026", contractDate: "",
    hmOrderNo: "644637/8756", marketCode: "OB", marketSubCode: "OB", countryCode: "OB",
    expNo: "", expDate: "", portOfLoading: "CHITTAGONG", portOfDischarge: "", placeOfDelivery: "",
    countryOfOrigin: "Bangladesh", countryOfFinalDestination: "", transportMode: "SEA",
    termsOfDelivery: "", termsOfPayment: "", vesselName: "", voyageNo: "", sailingDate: "", currency: "USD",
    exporterName: "ANANTA", buyerName: "H&M", consigneeName: "H&M", cargoDeliveryName: "", issuingBank: "",
    descriptionOfGoods: "Shirt", styleNo: "S", buyerCode: "AGL 1", hsCode: "620520", category: "8",
    quantityPcs: 10, unitPrice: 2, totalCartons: 1, grossWeightKg: 5, netWeightKg: 4, measurementCbm: 0.1,
    dimension: "", packSet: "",
  };
  it("writes invoiceNumber into column A when the plan says so", async () => {
    const ob = listTemplates(TEMPLATE_DIR).find((t) => t.countryCode === "OB")
      ?? resolveTemplate("OB", "OB", listTemplates(TEMPLATE_DIR));
    expect(ob).toBeTruthy();
    const r = await patchTemplate(ob!.path, BASE, [{ col: "A", field: "invoiceNumber", kind: "string" }]);
    expect(r).not.toBeNull();
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(r!.buffer);
    const ws = wb.getWorksheet("PAYMENT INVOICE")!;
    expect(String(ws.getRow(r!.inputRow).getCell(1).value)).toBe("90009"); // col A
  });
});
