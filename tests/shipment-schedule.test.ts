import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import ExcelJS from "exceljs";
import { parseBookingFilename } from "@/server/shipment-schedule/parse-filename";
import { parseBookingPdfText } from "@/server/shipment-schedule/parse-booking-pdf";
import { matchByOrderNoPrefix } from "@/server/shipment-schedule/match-sales-contract";
import { parsePdfText } from "@/server/pdf/parse-pdf";
import { validateField, computeValue, isEditableField, changesLineValue } from "@/server/shipment-schedule/edit";
import { buildCutoffWorkbook, type XlsxRow } from "@/server/shipment-schedule/write-xlsx";
import type { SalesContractLookup } from "@/server/shipment-schedule/types";

const SAMPLE_DIR = "D:/oct-2026/automation docs/New folder/2. Week Wise Shipment Schedule Creation/41";

describe("parseBookingFilename", () => {
  it("parses AUW118 pattern", () => {
    expect(parseBookingFilename("569959 AUW118.pdf")).toEqual({
      orderNoPrefix: "569959",
      marketCode: "AU",
      marketSubCode: "AUW118",
      ok: true,
    });
  });

  it("parses CL/UY cases with 3-digit buyer code", () => {
    const a = parseBookingFilename("571381 CLW093.pdf");
    expect(a.ok).toBe(true);
    expect(a.marketCode).toBe("CL");
    expect(a.marketSubCode).toBe("CLW093");
  });

  it("accepts dash-separated market codes like OW-NLW195", () => {
    const r = parseBookingFilename("734928 OW-NLW195.pdf");
    expect(r.ok).toBe(true);
    expect(r.marketCode).toBe("OW");
    expect(r.marketSubCode).toBe("OW-NLW195");
  });

  it("rejects filenames with no digit prefix", () => {
    const r = parseBookingFilename("not-a-booking.pdf");
    expect(r.ok).toBe(false);
  });

  it("rejects filenames whose sub-code does not start with two letters", () => {
    const r = parseBookingFilename("123456 00abc.pdf");
    expect(r.ok).toBe(false);
  });
});

describe("parseBookingPdfText (real sample PDFs)", () => {
  it("extracts BCN, BRef, status and ports from AUW118", async () => {
    const buf = readFileSync(join(SAMPLE_DIR, "1", "569959 AUW118.pdf"));
    const { text } = await parsePdfText(buf);
    const f = parseBookingPdfText(text);
    expect(f.bcn).toMatch(/^\d{7,9}$/);
    expect(f.bookingRef).toMatch(/^CTG\d+$/);
    expect(f.bookingStatus).toBe("CONFIRMED");
    expect(f.portOfLoading).toBe("Chittagong");
    expect(f.portOfDischarge).not.toBe("");
    expect(f.pdfOrderNo).toMatch(/^569959\/\d+-\d{4}$/);
    expect(f.skuItem).toMatch(/^AU\/\d+$/);
    expect(f.categories).toBe("AUW118");
    expect(f.pdfPcs).toBeTypeOf("number");
    expect(f.transportMode).toBe("SEA");
  });

  it("extracts PE market from PEW153 (cut-off 2)", async () => {
    const buf = readFileSync(join(SAMPLE_DIR, "2", "583635 PEW153.pdf"));
    const { text } = await parsePdfText(buf);
    const f = parseBookingPdfText(text);
    expect(f.bookingStatus).toBe("CONFIRMED");
    expect(f.categories).toBe("PEW153");
  });

  it("returns blank-everywhere with a warning on empty text", () => {
    const f = parseBookingPdfText("");
    expect(f.bcn).toBe("");
    expect(f.bookingRef).toBe("");
    expect(f.warnings).toContain("empty_or_tiny_pdf_text");
  });
});

describe("matchByOrderNoPrefix", () => {
  const candidate: SalesContractLookup = {
    contract: {
      marchentContNo: "AGL/H&M/99/2026",
      contractDate: "09.06.2026",
      buyerCode: "AGL 365 C",
      commercialContNo: "",
      commercialDate: "",
    },
    orderNo: "569959-5686",
    state: "READY",
    rowsJson: JSON.stringify([
      { isAnchor: true, orderNo: "569959-5686", orderQty: 2000, styleNo: "Kaito Ripstop Trousers", fob: 12.64, itemDes: "Trousers Men Woven Shell" },
    ]),
  };

  it("matches when prefix equals the first segment of orderNo", () => {
    const r = matchByOrderNoPrefix("569959", [candidate]);
    expect(r.matched).toBe(true);
    expect(r.reason).toBe("matched");
    expect(r.hydrated?.buyerCode).toBe("AGL 365 C");
    expect(r.hydrated?.contractNo).toBe("AGL/H&M/99/2026");
    expect(r.hydrated?.pcs).toBe(2000);
    expect(r.hydrated?.fob).toBe(12.64);
  });

  it("returns no_sales_contract_po when nothing matches", () => {
    const r = matchByOrderNoPrefix("111111", [candidate]);
    expect(r.matched).toBe(false);
    expect(r.reason).toBe("no_sales_contract_po");
  });

  it("flags ambiguous when the same prefix maps to multiple full orderNos", () => {
    const b: SalesContractLookup = { ...candidate, orderNo: "569959-8404", rowsJson: "[]" };
    const r = matchByOrderNoPrefix("569959", [candidate, b]);
    expect(r.matched).toBe(false);
    expect(r.reason).toBe("ambiguous");
    expect(r.candidates).toContain("569959-5686");
    expect(r.candidates).toContain("569959-8404");
  });

  it("flags not_ready when the matched PO is still UPLOADED", () => {
    const notReady: SalesContractLookup = { ...candidate, state: "UPLOADED" };
    const r = matchByOrderNoPrefix("569959", [notReady]);
    expect(r.matched).toBe(false);
    expect(r.reason).toBe("not_ready");
    expect(r.hydrated?.buyerCode).toBe("AGL 365 C"); // hydrated anyway so UI shows something
  });
});

describe("edit validators", () => {
  it("accepts a non-negative integer for pcs/cartons/pdfPcs", () => {
    expect(validateField("pcs", "250")).toEqual({ ok: true, normalized: 250 });
    expect(validateField("cartons", "0")).toEqual({ ok: true, normalized: 0 });
  });
  it("accepts an empty string as 'clear the cell' for numeric fields", () => {
    expect(validateField("pcs", "")).toEqual({ ok: true, normalized: null });
    expect(validateField("fob", "   ")).toEqual({ ok: true, normalized: null });
  });
  it("rejects negatives and non-numbers for numeric fields", () => {
    const r = validateField("pcs", "-1");
    expect(r.ok).toBe(false);
    const r2 = validateField("fob", "abc");
    expect(r2.ok).toBe(false);
  });
  it("accepts decimals for fob/grossWeightKg/measurementCbm but rejects decimals for pcs", () => {
    expect(validateField("fob", "12.64")).toEqual({ ok: true, normalized: 12.64 });
    expect(validateField("grossWeightKg", "26.66")).toEqual({ ok: true, normalized: 26.66 });
    expect(validateField("pcs", "250.5").ok).toBe(false);
  });
  it("trims string fields and rejects line breaks in code fields", () => {
    expect(validateField("style", "  Fly LW Bootcut  ")).toEqual({ ok: true, normalized: "Fly LW Bootcut" });
    const bad = validateField("invoiceNo", "65598\n65599");
    expect(bad.ok).toBe(false);
  });
  it("isEditableField guards against unknown field names", () => {
    expect(isEditableField("pcs")).toBe(true);
    expect(isEditableField("createdAt")).toBe(false);
  });
  it("changesLineValue only true for pcs/fob", () => {
    expect(changesLineValue("pcs")).toBe(true);
    expect(changesLineValue("fob")).toBe(true);
    expect(changesLineValue("style")).toBe(false);
  });
  it("computeValue returns null when either side is missing and rounds to 2dp", () => {
    expect(computeValue(null, 10)).toBeNull();
    expect(computeValue(5, null)).toBeNull();
    expect(computeValue(2000, 12.64)).toBe(25280);
    expect(computeValue(1000, 0.333)).toBe(333);
  });
});

describe("buildCutoffWorkbook (per-cut-off .xlsx export)", () => {
  const rows: XlsxRow[] = [
    {
      buyerCode: "AGL 365 C",
      contractNo: "AGL/H&M/99/2026",
      contractDate: "09.06.2026",
      orderNo: "734928-8404",
      pcs: 2000,
      style: "Kaito Ripstop Trousers",
      fob: 12.64,
      composition: "Women 100% Cotton Woven Trousers",
      cat: "FCA",
      hts: "Sea",
      invoiceNo: "65596",
      marketSubCode: "OW-NLW195",
      marketCode: "OW",
      transportMode: "SEA",
    },
  ];

  it("writes a title row + green header + one data row with a live Value formula", async () => {
    const buf = await buildCutoffWorkbook(rows, {
      weekTitle: "Week 43 1st cut off 19.10.2026 2nd 23.10.2026",
      cutoffLabel: "1st cut off",
      cutoffDate: "19.10.2026",
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const ws = wb.worksheets[0];
    expect(ws.name).toBe("1st cut off");

    // Title row.
    const title = String(ws.getCell(1, 1).value ?? "");
    expect(title).toContain("Week 43");
    expect(title).toContain("1st cut off");
    expect(title).toContain("19.10.2026");

    // Header row — all 15 labels.
    const headerLabels = Array.from({ length: 15 }, (_, i) => String(ws.getCell(2, i + 1).value ?? ""));
    expect(headerLabels).toEqual([
      "Buyer Code", "Cont.No.", "Date", "OrderNo.", "PCS", "STYLE", "FOB",
      "COMPOSITION", "CAT", "HTS", "Value", "INVOICE", "Market+Sub", "Market", "Mode",
    ]);

    // Data row.
    expect(ws.getCell(3, 1).value).toBe("AGL 365 C");
    expect(ws.getCell(3, 4).value).toBe("734928-8404");
    expect(ws.getCell(3, 5).value).toBe(2000);
    expect(ws.getCell(3, 7).value).toBe(12.64);
    // Value cell carries a formula referencing E3*G3.
    const valueCell = ws.getCell(3, 11).value as { formula?: string } | null;
    expect(valueCell?.formula).toBe("E3*G3");
    expect(ws.getCell(3, 12).value).toBe("65596");
    expect(ws.getCell(3, 13).value).toBe("OW-NLW195");
  });

  it("leaves the Value cell blank when pcs or fob is missing (never invents)", async () => {
    const partial: XlsxRow[] = [
      { ...rows[0], pcs: null, orderNo: "999999-0000", invoiceNo: "65999" },
    ];
    const buf = await buildCutoffWorkbook(partial, { weekTitle: "W", cutoffLabel: "x", cutoffDate: "" });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const ws = wb.worksheets[0];
    expect(ws.getCell(3, 11).value).toBeNull();
  });

  it("sanitises the sheet name (max 31 chars, no illegal chars)", async () => {
    const buf = await buildCutoffWorkbook([], { weekTitle: "", cutoffLabel: "Very / long \\ label? that cannot fit into an Excel sheet name", cutoffDate: "" });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    expect(wb.worksheets[0].name.length).toBeLessThanOrEqual(31);
    expect(wb.worksheets[0].name).not.toMatch(/[\\\/\?\*\[\]:]/);
  });
});
