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

describe("H&M Sales Contract — A..U template rows (AC-4, AC-5)", () => {
  it("creates one anchor row + N-1 blank-qty rows per PO", () => {
    const po = parsePurchaseOrderText(PO_TEXT);
    const size = parseSizeBreakdownText(SIZE_TEXT);
    const country = parseCountryBreakdownText(COUNTRY_TEXT);
    const recon = reconcileSet(po, size, country);
    const rows = mapToTemplateRows(po, size, country, recon);
    expect(rows).toHaveLength(4); // 4 markets
    expect(rows.filter((r) => r.isAnchor)).toHaveLength(1);
    expect(rows[0].isAnchor).toBe(true);
    expect(rows[0].orderQty).toBe(4078);
    // Non-anchor rows have null Order Qty (encoded in O instead) — AC-5.
    for (let i = 1; i < rows.length; i++) expect(rows[i].orderQty).toBeNull();
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

  it("encodes TOD, market and per-market qty in column O (AC-5)", () => {
    const po = parsePurchaseOrderText(PO_TEXT);
    const rows = mapToTemplateRows(po, null, null, { ok: true, checks: [], warnings: [] });
    const oe = rows.find((r) => r.marketCode === "OE")!;
    expect(oe.country).toBe("29 Jun, 2026 OE (OLCEU) 3 544 87%");
    const od = rows.find((r) => r.marketCode === "OD")!;
    expect(od.country).toBe("24 Aug, 2026 OD (OL-ME) 10 <1%");
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
  it("builds a passing envelope with 4 rows for the 643159 set", () => {
    const po = parsePurchaseOrderText(PO_TEXT);
    const size = parseSizeBreakdownText(SIZE_TEXT);
    const country = parseCountryBreakdownText(COUNTRY_TEXT);
    const match = matchSet(po, size, country);
    const recon = reconcileSet(po, size, country);
    const result = buildSetResult(po, size, country, match, recon);
    expect(result.blockWrite).toBe(false);
    expect(result.rows).toHaveLength(4);
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

describe("H&M Sales Contract — workbook writer (AC-6, AC-8, AC-9)", () => {
  const tmpDir = join(tmpdir(), `hm-xlsx-${Date.now()}`);

  it("writes to a NEW copy of the template and appends A..U rows with formulas", async () => {
    mkdirSync(tmpDir, { recursive: true });
    // Build a small template on the fly so the test does not depend on the
    // user's local workbook. The real production path points at the user's
    // Sales Contract workbook; the shape here mirrors its H&M sheet exactly.
    const templatePath = join(tmpDir, "template.xlsx");
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("H&M");
    ws.addRow([
      "Marchent Cont.No.", "Date", "Buyer Code", "commercial Cont.No.", "Date",
      "Order No.", "Order Qty", "Style No.", "FOB", "Item Des.",
      "Cat", "HTS", "CONTRACT VALUE", "TOD", "COUNTRY",
      "REMARKS", "Merchandiser Name:", "pack/set Qty", "pack/set",
      "Without Discount / Old FOB ", "Discount FOB con: date",
    ]);
    await wb.xlsx.writeFile(templatePath);

    const po = parsePurchaseOrderText(PO_TEXT);
    const size = parseSizeBreakdownText(SIZE_TEXT);
    const country = parseCountryBreakdownText(COUNTRY_TEXT);
    const match = matchSet(po, size, country);
    const recon = reconcileSet(po, size, country);
    const result = buildSetResult(po, size, country, match, recon);

    const outputPath = join(tmpDir, "SalesContract_test.xlsx");
    const r = await writeSalesContractWorkbook({
      templatePath,
      outputPath,
      header: { marchentContNo: "AGL/H&M/99/2026", merchandiserName: "Test" },
      sets: [result],
    });
    expect(r.appendedRows).toBe(4);
    expect(existsSync(outputPath)).toBe(true);
    // Original template still exists and is unchanged (sanity).
    expect(existsSync(templatePath)).toBe(true);

    // Reload the output and verify the A..U cells.
    const out = new ExcelJS.Workbook();
    await out.xlsx.readFile(outputPath);
    const sheet = out.getWorksheet("H&M")!;
    // Headers preserved.
    expect(sheet.getCell("A1").value).toBe("Marchent Cont.No.");
    expect(sheet.getCell("F1").value).toBe("Order No.");
    expect(sheet.getCell("U1").value).toBe("Discount FOB con: date");
    // Anchor row (row 2) has G, I populated and M, R as formulas; subsequent
    // rows have G blank/null.
    const anchor = sheet.getRow(2);
    expect(anchor.getCell(6).value).toBe("643159-8756");           // F
    expect(anchor.getCell(7).value).toBe(4078);                    // G
    expect(Number(anchor.getCell(9).value)).toBe(6.18);            // I
    expect(anchor.getCell(10).value).toBe("Boys Jeans - Garment Lower body Woven"); // J
    expect(anchor.getCell(13).value).toMatchObject({ formula: "G2*I2" }); // M
    expect(anchor.getCell(18).value).toMatchObject({ formula: "S2*G2" }); // R
    expect(String(anchor.getCell(15).value)).toContain("OE (OLCEU)"); // O

    const nonAnchor = sheet.getRow(3);
    expect(nonAnchor.getCell(6).value).toBe("643159-8756");
    const g3 = nonAnchor.getCell(7).value;
    expect(g3 === null || g3 === "" || g3 === undefined).toBe(true); // G blank
    expect(nonAnchor.getCell(13).value).toBeFalsy();                 // M blank
  });

  it("respects user edits via `overrides` (AC-8)", async () => {
    const templatePath = join(tmpDir, "template.xlsx");
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
      templatePath,
      outputPath,
      header: { marchentContNo: "AGL/H&M/99/2026" },
      sets: [result],
      overrides: {
        "643159-8756:OE": { itemDes: "USER EDITED Item Des.", remarks: "URGENT" },
      },
    });
    const out = new ExcelJS.Workbook();
    await out.xlsx.readFile(outputPath);
    const row = out.getWorksheet("H&M")!.getRow(2);
    expect(row.getCell(10).value).toBe("USER EDITED Item Des."); // J edit
    expect(row.getCell(16).value).toBe("URGENT");                 // P edit
  });

  it("skips blocked sets and lists them in the result (AC-10 adjacent)", async () => {
    const templatePath = join(tmpDir, "template.xlsx");
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

    const r = await writeSalesContractWorkbook({
      templatePath,
      outputPath,
      sets: [result],
    });
    expect(r.appendedRows).toBe(0);
    expect(r.blockedSets.map((b) => b.orderNo)).toContain(po.header.orderNo);
  });

  // Clean up at end-of-file.
  it("teardown", () => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
    expect(true).toBe(true);
  });
});

describe("H&M Sales Contract — Sales Contract grouping (AC-6)", () => {
  it("accumulates rows from several PO sets under one Sales Contract", async () => {
    const tmp = join(tmpdir(), `hm-group-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });
    const templatePath = join(tmp, "template.xlsx");
    const outputPath = join(tmp, "SalesContract_group.xlsx");
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("H&M").addRow(Array(21).fill(""));
    await wb.xlsx.writeFile(templatePath);

    const po = parsePurchaseOrderText(PO_TEXT);
    const size = parseSizeBreakdownText(SIZE_TEXT);
    const country = parseCountryBreakdownText(COUNTRY_TEXT);
    const result = buildSetResult(
      po, size, country,
      matchSet(po, size, country),
      reconcileSet(po, size, country),
    );
    // Duplicate the set as a second "PO" (same orderNo would be a dedup
    // concern upstream, but here we just verify the writer appends both).
    const r = await writeSalesContractWorkbook({
      templatePath,
      outputPath,
      sets: [result, result],
    });
    expect(r.appendedRows).toBe(8); // 4 rows × 2 PO sets

    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  });
});
