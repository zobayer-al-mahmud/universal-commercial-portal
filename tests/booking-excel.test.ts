import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import ExcelJS from "exceljs";
import { parsePackingListXlsx, writePackingListXlsx, rowHash, PACKING_HEADERS } from "@/server/booking-correction/excel";

const SAMPLE_ROWS = [
  { poNumber: "728045", sku: "OF", shipper: "ABM Fashions Ltd (134715)", frCode: "NLW174", quantity: "521", cartons: "16", grossWeight: "109.14" },
  { poNumber: "726936", sku: "LH", shipper: "ANANTA GARMENTS LTD (106573)", frCode: "PLW256", quantity: "360", cartons: "9", grossWeight: "106.52" },
];

describe("packing-list excel round-trip", () => {
  it("writes and re-parses rows with the 7-column layout", async () => {
    const buf = await writePackingListXlsx(SAMPLE_ROWS);
    const res = await parsePackingListXlsx(buf);
    expect(res.headerOk).toBe(true);
    expect(res.missingColumns).toEqual([]);
    expect(res.rows).toHaveLength(2);
    expect(res.rows[0]).toMatchObject({ rowNo: 1, poNumber: "728045", sku: "OF", shipper: "ABM Fashions Ltd (134715)", frCode: "NLW174", quantity: "521", cartons: "16", grossWeight: "109.14", valid: true });
    expect(res.rows[0].errors).toEqual([]);
  });

  it("exposes the exact header labels", () => {
    expect(PACKING_HEADERS).toEqual(["PO Number", "SKU/Item", "Select Shipper", "FR", "Quantity", "Packages/CARTON", "Gross weight"]);
  });
});

describe("packing-list header + validation tolerance", () => {
  async function build(headers: unknown[], dataRows: unknown[][]): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("PackingLists");
    ws.addRow(headers);
    for (const r of dataRows) ws.addRow(r);
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  it("matches headers despite tabs/casing/spacing (real file has a tab before SKU/Item)", async () => {
    const buf = await build(
      ["PO Number", "\tSKU/Item", "Select Shipper", "FR", "Quantity", "Packages/CARTON", "Gross weight"],
      [["733031", "se", "ABM Fashions Ltd (134715)", "sew001", 3621, 110, 1057]],
    );
    const res = await parsePackingListXlsx(buf);
    expect(res.headerOk).toBe(true);
    expect(res.rows[0]).toMatchObject({ sku: "SE", frCode: "SEW001", quantity: "3621", cartons: "110", grossWeight: "1057" });
  });

  it("flags invalid rows instead of dropping them, and skips blank rows", async () => {
    const buf = await build(
      [...PACKING_HEADERS],
      [
        ["", "OF", "ABM", "NLW174", 10, 1, 5], // missing PO
        ["744661", "TR", "ABM", "TRW059", 0, 12, 104.81], // zero quantity
        ["", "", "", "", "", "", ""], // blank → skipped
        ["600641", "CL", "ABM", "CLW093", 80, 1, 9.15], // valid
      ],
    );
    const res = await parsePackingListXlsx(buf);
    expect(res.rows).toHaveLength(3); // blank skipped
    expect(res.rows[0].valid).toBe(false);
    expect(res.rows[0].errors.join(" ")).toMatch(/PO Number/);
    expect(res.rows[1].valid).toBe(false);
    expect(res.rows[1].errors.join(" ")).toMatch(/Quantity/);
    expect(res.rows[2].valid).toBe(true);
  });

  it("reports missing required columns", async () => {
    const buf = await build(["PO Number", "SKU/Item"], [["728045", "OF"]]);
    const res = await parsePackingListXlsx(buf);
    expect(res.headerOk).toBe(false);
    expect(res.missingColumns).toEqual(expect.arrayContaining(["Quantity", "Packages/CARTON", "Gross weight"]));
  });
});

describe("rowHash", () => {
  it("is stable and case/space-insensitive, distinct per content", () => {
    const a = rowHash(SAMPLE_ROWS[0]);
    const b = rowHash({ ...SAMPLE_ROWS[0], poNumber: " 728045 ", sku: "of" });
    expect(a).toBe(b);
    expect(rowHash(SAMPLE_ROWS[1])).not.toBe(a);
  });
});

// Optional: validate against the real supplied workbook when present (it lives in
// the read-only source-evidence folder one level above the repo). Skipped on a
// checkout that doesn't have it, like the existing shipment-schedule sample tests.
const REAL = join(__dirname, "..", "..", "PackingLists.xlsx");
describe.skipIf(!existsSync(REAL))("real PackingLists.xlsx", () => {
  it("parses all data rows with the expected columns", async () => {
    const res = await parsePackingListXlsx(readFileSync(REAL));
    expect(res.headerOk).toBe(true);
    expect(res.rows.length).toBeGreaterThan(300);
    const r728045 = res.rows.find((r) => r.poNumber === "728045" && r.sku === "OF");
    expect(r728045).toBeTruthy();
    expect(r728045).toMatchObject({ frCode: "NLW174", quantity: "521", cartons: "16", grossWeight: "109.14" });
    expect(r728045!.shipper).toMatch(/ABM Fashions/i);
    // Every row that validates has the five required numeric/identity fields.
    for (const r of res.rows.filter((x) => x.valid)) {
      expect(r.poNumber).not.toBe("");
      expect(Number(r.quantity)).toBeGreaterThan(0);
      expect(Number(r.cartons)).toBeGreaterThan(0);
      expect(Number(r.grossWeight)).toBeGreaterThan(0);
    }
  });
});
