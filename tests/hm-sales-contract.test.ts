import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import {
  parsePurchaseOrderText,
  parseSizeBreakdownText,
  parseCountryBreakdownText,
  matchSet,
  reconcileSet,
  buildSetResult,
  buildItemDes,
  formatQtySpaced,
  mapToTemplateRows,
  writeSalesContractWorkbook,
} from "@/server/hm-sales-contract";

const PO_TEXT = readFileSync(join(__dirname, "fixtures/hm-643159-po.txt"), "utf8");
const SIZE_TEXT = readFileSync(join(__dirname, "fixtures/hm-643159-size.txt"), "utf8");
const COUNTRY_TEXT = readFileSync(join(__dirname, "fixtures/hm-643159-country.txt"), "utf8");

describe("H&M Sales Contract — PO PDF parser (AC-1, AC-2)", () => {
  it("parses the shared header block of the Purchase Order PDF", () => {
    const po = parsePurchaseOrderText(PO_TEXT);
    expect(po.header.orderNo).toBe("643159-8756");
    expect(po.header.ptProdNo).toBe("95320");
    expect(po.header.dateOfOrder).toBe("20 Apr, 2026");
    expect(po.header.supplierCode).toBe("0197"); // leading zero preserved
    expect(po.header.supplierName).toBe("ANANTA GARMENTS LTD.");
    expect(po.header.optionNo).toBe("SQ0174829");
    expect(po.header.developmentNo).toBe("0001732C"); // leading zeros preserved
    expect(po.header.productNo).toBe("0803160"); // leading zero preserved
    expect(po.header.productName).toBe("Slim denim");
    expect(po.header.productDescription).toBe("Jeans - Garment Lower body");
    expect(po.header.season).toBe("4-2026");
    expect(po.header.customsCustomerGroup).toBe("Boys");
    expect(po.header.typeOfConstruction).toBe("Woven");
  });

  it("extracts total PO quantity 4078 (AC-2)", () => {
    const po = parsePurchaseOrderText(PO_TEXT);
    expect(po.totalQty).toBe(4078);
    expect(po.totalPct).toBe(100);
  });

  it("extracts all four market rows with the correct market codes", () => {
    const po = parsePurchaseOrderText(PO_TEXT);
    expect(po.marketRows.map((r) => r.marketCode).sort()).toEqual(["LH", "OD", "OE", "OF"]);
    const codesB = Object.fromEntries(po.marketRows.map((r) => [r.marketCode, r.marketCodeB]));
    expect(codesB).toEqual({ OE: "OLCEU", OF: "OLSEU", OD: "OL-ME", LH: "OLEEU" });
  });

  it("extracts the article/colour/cost subtable", () => {
    const po = parsePurchaseOrderText(PO_TEXT);
    expect(po.articles).toHaveLength(1);
    const a = po.articles[0];
    expect(a.articleNo).toBe("051"); // leading zero
    expect(a.hmColourCode).toBe("75-901");
    expect(a.ptArticleNumber).toBe("03"); // leading zero
    expect(a.colourName).toBe("Denim Blue Light");
    expect(a.cost).toBe(6.15);
    expect(a.costCurrency).toBe("USD");
    expect(a.qtyPerArticle).toBe(4078);
  });

  it("extracts Invoice Average Price with currency and country list", () => {
    const po = parsePurchaseOrderText(PO_TEXT);
    expect(po.invoiceAveragePrice).toBe(6.18);
    expect(po.invoiceCurrency).toBe("USD");
    expect(po.invoiceCountries).toBe("OE, OF, LH, OD");
  });
});

describe("H&M Sales Contract — Country Breakdown parser (AC-2)", () => {
  it("extracts per-market totals OE/OF/OD/LH", () => {
    const country = parseCountryBreakdownText(COUNTRY_TEXT);
    const byMarket = Object.fromEntries(country.rows.map((r) => [r.marketCode, r.rowTotal]));
    expect(byMarket).toEqual({ OE: 3544, OF: 274, OD: 10, LH: 250 });
  });

  it("extracts the article list and the grand total 4078", () => {
    const country = parseCountryBreakdownText(COUNTRY_TEXT);
    expect(country.articles).toEqual(["051"]);
    expect(country.grandTotal).toBe(4078);
    expect(country.articleTotals["051"]).toBe(4078);
  });

  it("extracts the per-article size totals (7 size columns)", () => {
    const country = parseCountryBreakdownText(COUNTRY_TEXT);
    expect(country.sizeTotals).toHaveLength(1);
    const t = country.sizeTotals[0];
    expect(t.article).toBe("051");
    expect(t.hmColourCode).toBe("75-901");
    expect(t.sizes).toEqual(["134", "140", "146", "152", "158", "164", "170"]);
    expect(t.quantities).toEqual([316, 634, 919, 736, 549, 502, 422]);
    expect(t.total).toBe(4078);
  });
});

describe("H&M Sales Contract — Size/Colour Breakdown parser", () => {
  it("extracts one page per market with the market quantity", () => {
    const size = parseSizeBreakdownText(SIZE_TEXT);
    expect(size.pages).toHaveLength(4);
    const byMarket = Object.fromEntries(size.pages.map((p) => [p.marketCode, p.marketQuantity]));
    expect(byMarket).toEqual({ OE: 3544, OF: 274, OD: 10, LH: 250 });
  });

  it("extracts size-level quantities on each market page", () => {
    const size = parseSizeBreakdownText(SIZE_TEXT);
    const oe = size.pages.find((p) => p.marketCode === "OE")!;
    expect(oe.articleNo).toBe("051");
    expect(oe.hmColourCode).toBe("75-901");
    expect(oe.ptArticleNumber).toBe("03");
    expect(oe.variant).toBe("Solid");
    const sum = Object.values(oe.sizes).reduce((a, b) => a + b, 0);
    expect(sum).toBe(3544);
  });

  it("recognises the OD market's year-style size labels (8-9Y (134)* etc.)", () => {
    const size = parseSizeBreakdownText(SIZE_TEXT);
    const od = size.pages.find((p) => p.marketCode === "OD")!;
    expect(od.marketQuantity).toBe(10);
    const sum = Object.values(od.sizes).reduce((a, b) => a + b, 0);
    expect(sum).toBe(10);
  });
});

describe("H&M Sales Contract — three-way match (AC-1)", () => {
  it("accepts the matching 643159 three-PDF set", () => {
    const po = parsePurchaseOrderText(PO_TEXT);
    const size = parseSizeBreakdownText(SIZE_TEXT);
    const country = parseCountryBreakdownText(COUNTRY_TEXT);
    const m = matchSet(po, size, country);
    expect(m.matched).toBe(true);
    expect(m.orderNo).toBe("643159-8756");
    expect(m.mismatches).toEqual([]);
  });

  it("blocks a mismatched set and reports which key disagrees (AC-7)", () => {
    const po = parsePurchaseOrderText(PO_TEXT);
    const size = parseSizeBreakdownText(SIZE_TEXT.replace("643159-8756", "999999-8756"));
    const country = parseCountryBreakdownText(COUNTRY_TEXT);
    const m = matchSet(po, size, country);
    expect(m.matched).toBe(false);
    expect(m.orderNo).toBeNull();
    expect(m.mismatches).toContain("orderNo");
  });
});

describe("H&M Sales Contract — cross-document reconciliation (AC-3, AC-11)", () => {
  it("passes every check on the matching 643159 set", () => {
    const po = parsePurchaseOrderText(PO_TEXT);
    const size = parseSizeBreakdownText(SIZE_TEXT);
    const country = parseCountryBreakdownText(COUNTRY_TEXT);
    const recon = reconcileSet(po, size, country);
    expect(recon.ok).toBe(true);
    // The headline sum check must be present and green.
    const sumCheck = recon.checks.find((c) => c.name === "po_market_sum_equals_po_total")!;
    expect(sumCheck.ok).toBe(true);
    expect(sumCheck.actual).toBe(4078);
  });

  it("reports a QTY_MISMATCH without silently altering the extracted values (AC-11)", () => {
    const po = parsePurchaseOrderText(PO_TEXT);
    // Tamper with the Country Breakdown so OE = 3000 instead of 3544.
    const country = parseCountryBreakdownText(COUNTRY_TEXT);
    country.rows.find((r) => r.marketCode === "OE")!.rowTotal = 3000;
    country.rows.find((r) => r.marketCode === "OE")!.articleQuantities["051"] = 3000;
    const recon = reconcileSet(po, parseSizeBreakdownText(SIZE_TEXT), country);
    expect(recon.ok).toBe(false);
    const check = recon.checks.find((c) => c.name === "country_vs_po_market_OE")!;
    expect(check.ok).toBe(false);
    expect(check.expected).toBe(3544);
    expect(check.actual).toBe(3000);
    // Extracted values are not altered — PO market still shows 3544.
    expect(po.marketRows.find((r) => r.marketCode === "OE")!.quantity).toBe(3544);
  });
});

describe("H&M Sales Contract — A..U template rows (AC-4, AC-5, one-row-per-PO 2026-10-20)", () => {
  it("creates EXACTLY ONE row per PO regardless of market count", () => {
    const po = parsePurchaseOrderText(PO_TEXT);
    const size = parseSizeBreakdownText(SIZE_TEXT);
    const country = parseCountryBreakdownText(COUNTRY_TEXT);
    const recon = reconcileSet(po, size, country);
    const rows = mapToTemplateRows(po, size, country, recon);
    expect(rows).toHaveLength(1); // 4 markets in 643159 → still ONE row
    expect(rows[0].isAnchor).toBe(true);
    expect(rows[0].orderQty).toBe(4078); // total PO qty on the single row
    expect(rows[0].orderNo).toBe("643159-8756");
  });

  it("leaves the fields that are not in any PDF blank (AC-4)", () => {
    const po = parsePurchaseOrderText(PO_TEXT);
    const rows = mapToTemplateRows(po, null, null, { ok: true, checks: [], warnings: [] });
    const r = rows[0];
    expect(r.blanks.buyerCode).toBe("");
    expect(r.blanks.commercialContNo).toBe("");
    expect(r.blanks.cat).toBe("");
    expect(r.blanks.hts).toBe("");
    expect(r.blanks.merchandiserName).toBe("");
    expect(r.blanks.packSet).toBe("");
    expect(r.blanks.withoutDiscount).toBe("");
    expect(r.blanks.discountFobDate).toBe("");
    // Style No. stays blank: spec rule 3-H forbids substituting Product Name.
    expect(r.styleNo).toBe("");
  });

  it("concatenates every market into column O (newline-separated, one line per market)", () => {
    const po = parsePurchaseOrderText(PO_TEXT);
    const rows = mapToTemplateRows(po, null, null, { ok: true, checks: [], warnings: [] });
    expect(rows).toHaveLength(1);
    const country = rows[0].country;
    // All four 643159 markets appear in the single row.
    expect(country).toContain("29 Jun, 2026 OE (OLCEU) 3 544 87%");
    expect(country).toContain("24 Aug, 2026 OD (OL-ME) 10 <1%");
    expect(country.split("\n").length).toBe(po.marketRows.length);
  });

  it("records every market code on the single row for traceability", () => {
    const po = parsePurchaseOrderText(PO_TEXT);
    const rows = mapToTemplateRows(po, null, null, { ok: true, checks: [], warnings: [] });
    const codes = rows[0].marketCode.split(",").sort();
    expect(codes).toEqual(["LH", "OD", "OE", "OF"]);
    // marketQuantity on the merged row = sum across markets, equals totalQty
    // when every market is allocated (PO 643159 is 100% allocated → 4078).
    expect(rows[0].marketQuantity).toBe(4078);
  });

  it("builds Item Des. as 'group description construction' (BR-HM-03 default)", () => {
    const po = parsePurchaseOrderText(PO_TEXT);
    expect(buildItemDes(po)).toBe("Boys Jeans - Garment Lower body Woven");
  });

  it("formats quantities with space-separated thousands (template convention)", () => {
    expect(formatQtySpaced(3544)).toBe("3 544");
    expect(formatQtySpaced(4078)).toBe("4 078");
    expect(formatQtySpaced(10)).toBe("10");
    expect(formatQtySpaced(1234567)).toBe("1 234 567");
  });
});

describe("H&M Sales Contract — set envelope + blocked sets (AC-7)", () => {
  it("builds a passing envelope with ONE row for the 643159 set (one-row-per-PO)", () => {
    const po = parsePurchaseOrderText(PO_TEXT);
    const size = parseSizeBreakdownText(SIZE_TEXT);
    const country = parseCountryBreakdownText(COUNTRY_TEXT);
    const match = matchSet(po, size, country);
    const recon = reconcileSet(po, size, country);
    const result = buildSetResult(po, size, country, match, recon);
    expect(result.blockWrite).toBe(false);
    expect(result.rows).toHaveLength(1);
    expect(result.orderNo).toBe("643159-8756");
  });

  it("blockWrite=true when the set does not match", () => {
    const po = parsePurchaseOrderText(PO_TEXT);
    const size = parseSizeBreakdownText(SIZE_TEXT.replace("643159-8756", "999999-8756"));
    const country = parseCountryBreakdownText(COUNTRY_TEXT);
    const match = matchSet(po, size, country);
    const recon = reconcileSet(po, size, country);
    const result = buildSetResult(po, size, country, match, recon);
    expect(result.blockWrite).toBe(true);
    expect(result.rows).toEqual([]);
    expect(result.reasons.join("\n")).toMatch(/does not match/i);
  });
});

describe("H&M Sales Contract — fresh workbook writer (prototype layout, 2026-10-20)", () => {
  const tmpDir = join(tmpdir(), `hm-xlsx-${Date.now()}`);

  it("writes a FRESH workbook with user-typed banner (row 1 + 3) + column headers (row 5) + data rows (row 6+)", async () => {
    mkdirSync(tmpDir, { recursive: true });

    const po = parsePurchaseOrderText(PO_TEXT);
    const size = parseSizeBreakdownText(SIZE_TEXT);
    const country = parseCountryBreakdownText(COUNTRY_TEXT);
    const result = buildSetResult(
      po, size, country,
      matchSet(po, size, country),
      reconcileSet(po, size, country),
    );

    const outputPath = join(tmpDir, "SalesContract_test.xlsx");
    const r = await writeSalesContractWorkbook({
      outputPath,
      header: { marchentContNo: "AGL/H&M/99/2026", reviseNo: "21" },
      sets: [result],
    });
    expect(r.appendedRows).toBe(1);
    expect(existsSync(outputPath)).toBe(true);

    const out = new ExcelJS.Workbook();
    await out.xlsx.readFile(outputPath);
    const sheet = out.getWorksheet("Sales Contract")!;

    // --- Banner (user-typed; appears only when values are set) ---
    expect(String(sheet.getCell("A1").value)).toContain("Block Contract Ref");
    expect(String(sheet.getCell("A1").value)).toContain("AGL/H&M/99/2026");
    expect(String(sheet.getCell("A3").value)).toContain("Revise: 21");

    // --- Column header row (row 5) — field names appear ONLY here, never on data rows ---
    const header = sheet.getRow(5);
    expect(header.getCell(1).value).toBe("Order No.");
    expect(header.getCell(2).value).toBe("Style No.");
    expect(header.getCell(3).value).toBe("Description");
    expect(header.getCell(4).value).toBe("Order Qty");
    expect(header.getCell(5).value).toBe("Total Qty With Packs");
    expect(header.getCell(6).value).toBe("Unit Price");
    expect(header.getCell(7).value).toBe("Value");
    expect(header.getCell(8).value).toBe("Time of Delivery");

    // --- Data row (row 6) — one row per PO, PDF-sourced values ---
    const row = sheet.getRow(6);
    expect(row.getCell(1).value).toBe("643159-8756");                     // Order No.
    expect(row.getCell(2).value).toBe("Slim denim");                      // Style No. = productName
    expect(row.getCell(3).value).toBe("Boys Jeans - Garment Lower body Woven"); // Description
    expect(row.getCell(4).value).toBe(4078);                              // Order Qty
    expect(row.getCell(5).value).toBe(4078);                              // Total Qty With Packs (packSet default 1)
    expect(Number(row.getCell(6).value)).toBe(6.18);                      // Unit Price
    expect(row.getCell(7).value).toMatchObject({ formula: "D6*F6" });     // Value formula
    const tod = String(row.getCell(8).value);                             // Time of Delivery
    expect(tod).toContain("29 Jun, 2026");

    // Row 7 must be empty — ONE row per PO.
    const next = sheet.getRow(7);
    for (let c = 1; c <= 8; c++) {
      const v = next.getCell(c).value;
      expect(v === null || v === undefined || v === "").toBe(true);
    }
  });

  it("omits the banner lines when the user has not typed Block Contract Ref / Revise", async () => {
    const outputPath = join(tmpDir, "SalesContract_no_banner.xlsx");
    const po = parsePurchaseOrderText(PO_TEXT);
    const size = parseSizeBreakdownText(SIZE_TEXT);
    const country = parseCountryBreakdownText(COUNTRY_TEXT);
    const result = buildSetResult(
      po, size, country,
      matchSet(po, size, country),
      reconcileSet(po, size, country),
    );
    await writeSalesContractWorkbook({ outputPath, sets: [result] });

    const out = new ExcelJS.Workbook();
    await out.xlsx.readFile(outputPath);
    const sheet = out.getWorksheet("Sales Contract")!;
    const a1 = sheet.getCell("A1").value;
    const a3 = sheet.getCell("A3").value;
    expect(a1 === null || a1 === undefined || a1 === "").toBe(true);
    expect(a3 === null || a3 === undefined || a3 === "").toBe(true);
  });

  it("respects user edits via `overrides` keyed by orderNo", async () => {
    const outputPath = join(tmpDir, "SalesContract_overrides.xlsx");

    const po = parsePurchaseOrderText(PO_TEXT);
    const size = parseSizeBreakdownText(SIZE_TEXT);
    const country = parseCountryBreakdownText(COUNTRY_TEXT);
    const result = buildSetResult(
      po, size, country,
      matchSet(po, size, country),
      reconcileSet(po, size, country),
    );

    await writeSalesContractWorkbook({
      outputPath,
      header: { marchentContNo: "AGL/H&M/99/2026" },
      sets: [result],
      overrides: {
        "643159-8756": { itemDes: "USER EDITED Description", styleNo: "USER EDITED Style" },
      },
    });
    const out = new ExcelJS.Workbook();
    await out.xlsx.readFile(outputPath);
    const row = out.getWorksheet("Sales Contract")!.getRow(6);
    expect(row.getCell(2).value).toBe("USER EDITED Style");       // Style No. (B)
    expect(row.getCell(3).value).toBe("USER EDITED Description"); // Description (C)
  });

  it("skips blocked sets and lists them in the result", async () => {
    const outputPath = join(tmpDir, "SalesContract_blocked.xlsx");

    const po = parsePurchaseOrderText(PO_TEXT);
    const size = parseSizeBreakdownText(SIZE_TEXT.replace("643159-8756", "999999-8756"));
    const country = parseCountryBreakdownText(COUNTRY_TEXT);
    const result = buildSetResult(
      po, size, country,
      matchSet(po, size, country),
      reconcileSet(po, size, country),
    );
    expect(result.blockWrite).toBe(true);

    const r = await writeSalesContractWorkbook({ outputPath, sets: [result] });
    expect(r.appendedRows).toBe(0);
    expect(r.blockedSets.map((b) => b.orderNo)).toContain(po.header.orderNo);
  });

  it("accumulates rows from several PO sets under one Sales Contract", async () => {
    const outputPath = join(tmpDir, "SalesContract_group.xlsx");

    const po = parsePurchaseOrderText(PO_TEXT);
    const size = parseSizeBreakdownText(SIZE_TEXT);
    const country = parseCountryBreakdownText(COUNTRY_TEXT);
    const result = buildSetResult(
      po, size, country,
      matchSet(po, size, country),
      reconcileSet(po, size, country),
    );
    const r = await writeSalesContractWorkbook({ outputPath, sets: [result, result] });
    expect(r.appendedRows).toBe(2); // one row per PO × 2 PO sets
  });

  it("does not throw when a set's PO extract has no `header` (poJson='{}') — regression", async () => {
    // Loaded-from-DB sets can carry a truthy-but-headerless `po` object when a
    // PO's PurchaseOrder PDF produced an empty extract (poJson stored as "{}").
    // The writer must treat that as a blank Style No., not crash on
    // `set.po.header.productName`.
    const outputPath = join(tmpDir, "SalesContract_headerless_po.xlsx");
    const headerlessSet = {
      orderNo: "500000-6565",
      match: {},
      reconciliation: {},
      po: {}, // truthy object, no `header`
      size: null,
      country: null,
      blockWrite: false,
      reasons: [],
      rows: [
        {
          orderNo: "500000-6565",
          orderQty: 1200,
          styleNo: "",
          fob: 5.5,
          itemDes: "Country-breakdown-only set",
          tod: "01 Jan, 2026",
          country: "DE",
        },
      ],
    };
    const r = await writeSalesContractWorkbook({ outputPath, sets: [headerlessSet] as never });
    expect(r.appendedRows).toBe(1);

    const out = new ExcelJS.Workbook();
    await out.xlsx.readFile(outputPath); // reopen must succeed
    const row = out.getWorksheet("Sales Contract")!.getRow(6);
    expect(row.getCell(1).value).toBe("500000-6565"); // Order No.
    expect(row.getCell(2).value === "" || row.getCell(2).value === null || row.getCell(2).value === undefined).toBe(true); // Style No. blank
    expect(row.getCell(4).value).toBe(1200); // Order Qty
  });

  // Clean up at end-of-file.
  it("teardown", () => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
    expect(true).toBe(true);
  });
});
