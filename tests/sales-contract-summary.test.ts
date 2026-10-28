import { describe, it, expect, beforeAll } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import ExcelJS from "exceljs";
import { mapToSummaryRows, buildExtraPricesFromPo } from "@/server/sales-contract/summary-rows";
import { writeSummaryWorkbook, SUMMARY_HEADERS, buildBusinessFp } from "@/server/sales-contract/summary-writer";
import type { SalesContractPoExtract, SalesContractCountryBreakdownExtract } from "@/server/sales-contract/types";
import type { SalesContractSummaryConfig } from "@/server/sales-contract/summary-rows";

function fakePo(overrides: Partial<SalesContractPoExtract> = {}): SalesContractPoExtract {
  return {
    kind: "PurchaseOrder",
    header: {
      orderNo: "643159-8756",
      ptProdNo: "95320",
      dateOfOrder: "20 Apr, 2026",
      supplierCode: "0197",
      supplierName: "ANANTA",
      optionNo: "SQ0174829",
      developmentNo: "0001732C",
      productNo: "0803160",
      productName: "Slim denim",
      productDescription: "Jeans - Garment Lower body",
      season: "4-2026",
      customsCustomerGroup: "Boys",
      typeOfConstruction: "Woven",
    },
    countryOfProduction: null, countryOfDelivery: null, countryOfOrigin: null,
    termsOfPayment: null, salesMode: null, noOfPieces: null,
    marketsHeaderList: null, termsOfDeliveryText: null,
    marketRows: [
      { tod: "29 Jun, 2026", marketCode: "OE", marketCodeB: "OLCEU", quantity: 3544, quantityRaw: "3 544", pct: 87 },
      { tod: "29 Jun, 2026", marketCode: "OF", marketCodeB: "OLSEU", quantity: 274,  quantityRaw: "274",   pct: 6 },
      { tod: "29 Jun, 2026", marketCode: "OD", marketCodeB: "OL-ME", quantity: 10,   quantityRaw: "10",    pct: "<1" },
      { tod: "29 Jun, 2026", marketCode: "LH", marketCodeB: "OLEEU", quantity: 250,  quantityRaw: "250",   pct: 6 },
    ],
    totalQty: 4078, totalPct: 100,
    articles: [],
    invoiceAveragePrice: 6.18,
    invoiceCurrency: "USD",
    invoiceCountries: "OE, OF, LH, OD",
    ...overrides,
  };
}

function cfg(overrides: Partial<SalesContractSummaryConfig> = {}): SalesContractSummaryConfig {
  const contractNo = overrides.contractNo ?? "97";
  const folderLetter = (overrides.folderLetter ?? "A").toUpperCase();
  return {
    contractNo,
    folderLetter,
    contractDate: "23 Oct, 2026",
    folderCommercialDate: "01 Nov, 2026",
    buyerCode: "AGL 349 A",
    merchandiserName: "S-4-2026- Manik, Aslam",
    packSet: "1",
    marchentContNoOverride: `AGL/H&M/${contractNo}-${folderLetter}/2026`,
    ...overrides,
  };
}

describe("mapToSummaryRows (spec Â§11)", () => {
  it("Order Qty + Pack/Set Qty appear only on the first row for a PO", () => {
    const rows = mapToSummaryRows(fakePo(), cfg(), "po1");
    expect(rows).toHaveLength(4);
    expect(rows[0].orderQty).toBe(4078);
    expect(rows[0].packSetQty).toBe(4078); // packSet=1 × 4078
    for (const r of rows.slice(1)) {
      expect(r.orderQty).toBeNull();
      expect(r.packSetQty).toBeNull();
      expect(r.packSet).toBe("");
    }
  });

  it("TOD, COUNTRY, FOB, CONTRACT VALUE populated on every applicable row", () => {
    const rows = mapToSummaryRows(fakePo(), cfg(), "po1");
    for (const r of rows) {
      expect(r.tod).toBe("29 Jun, 2026");
      expect(r.country).toMatch(/^(OE|OF|OD|LH) \(.+\)$/);
      expect(r.fob).toBe(6.18);
      expect(r.contractValue).toBeGreaterThan(0);
    }
    // Per-row contract value uses the row's own qty, never the full order qty.
    const oeRow = rows.find((r) => r.marketCode === "OE")!;
    expect(oeRow.contractValue).toBeCloseTo(6.18 * 3544, 2);
  });

  it("does NOT multiply order qty across every combination", () => {
    const rows = mapToSummaryRows(fakePo(), cfg(), "po1");
    const sumPerRowQty = rows.reduce((n, r) => n + (Number.isFinite(r.contractValue) ? (r.contractValue! / 6.18) : 0), 0);
    expect(Math.round(sumPerRowQty)).toBe(4078);
    // Sum of per-row CONTRACT VALUE must equal order total × unit price (never multiplied by number of rows).
    const totalCV = rows.reduce((n, r) => n + (r.contractValue ?? 0), 0);
    expect(totalCV).toBeCloseTo(6.18 * 4078, 2);
  });

  it("preserves distinct unit prices when extraPrices supplied – never averages", () => {
    const rows = mapToSummaryRows(fakePo(), cfg({
      extraPrices: [
        { key: "market:OE", price: 5.20, qty: 3544 },
        { key: "market:OF", price: 5.80, qty: 274 },
      ],
    }), "po1");
    const prices = Object.fromEntries(rows.map((r) => [r.marketCode, r.fob]));
    expect(prices.OE).toBe(5.20);
    expect(prices.OF).toBe(5.80);
    expect(prices.OD).toBe(6.18); // fell back to invoice average
    expect(prices.LH).toBe(6.18);
  });

  it("flags QTY_RECONCILIATION_FAILED when per-row qty sum â‰  PO total", () => {
    const po = fakePo({ totalQty: 9999 });
    const rows = mapToSummaryRows(po, cfg(), "po1");
    for (const r of rows) expect(r.issues).toContain("QTY_RECONCILIATION_FAILED");
  });
});

describe("buildExtraPricesFromPo (spec Â§7 – distinct prices preserved, never averaged)", () => {
  it("returns [] for a single-article PO (nothing to split)", () => {
    expect(buildExtraPricesFromPo(fakePo(), null)).toEqual([]);
  });

  it("returns [] when every article is the same cost (no distinct prices)", () => {
    const po = fakePo({
      articles: [
        { articleNo: "051", hmColourCode: "75-901", ptArticleNumber: "03", colourName: "A", optionNoWithVersion: "x (V1)", cost: 6.15, costCurrency: "USD", qtyPerArticle: 2000 },
        { articleNo: "052", hmColourCode: "75-902", ptArticleNumber: "04", colourName: "B", optionNoWithVersion: "y (V1)", cost: 6.15, costCurrency: "USD", qtyPerArticle: 2078 },
      ],
    });
    expect(buildExtraPricesFromPo(po, null)).toEqual([]);
  });

  it("multi-article with distinct costs → article-level entries from po.articles", () => {
    const po = fakePo({
      articles: [
        { articleNo: "051", hmColourCode: "75-901", ptArticleNumber: "03", colourName: "A", optionNoWithVersion: "x (V1)", cost: 5.20, costCurrency: "USD", qtyPerArticle: 2000 },
        { articleNo: "052", hmColourCode: "75-902", ptArticleNumber: "04", colourName: "B", optionNoWithVersion: "y (V1)", cost: 5.80, costCurrency: "USD", qtyPerArticle: 2078 },
      ],
    });
    const extras = buildExtraPricesFromPo(po, null);
    expect(extras).toEqual([
      { key: "article:051", price: 5.20, qty: 2000 },
      { key: "article:052", price: 5.80, qty: 2078 },
    ]);
  });

  it("multi-article + country breakdown → one entry per (article × market) with the breakdown's qty", () => {
    const po = fakePo({
      articles: [
        { articleNo: "051", hmColourCode: "75-901", ptArticleNumber: "03", colourName: "A", optionNoWithVersion: "x (V1)", cost: 5.20, costCurrency: "USD", qtyPerArticle: 2000 },
        { articleNo: "052", hmColourCode: "75-902", ptArticleNumber: "04", colourName: "B", optionNoWithVersion: "y (V1)", cost: 5.80, costCurrency: "USD", qtyPerArticle: 2078 },
      ],
    });
    const country: SalesContractCountryBreakdownExtract = {
      kind: "TotalCountryBreakdown",
      header: po.header,
      articles: ["051", "052"],
      rows: [
        { marketCode: "OE", marketCodeB: "OLCEU", articleQuantities: { "051": 1800, "052": 1744 }, rowTotal: 3544 },
        { marketCode: "OF", marketCodeB: "OLSEU", articleQuantities: { "051": 100, "052": 174 }, rowTotal: 274 },
        { marketCode: "OD", marketCodeB: "OL-ME", articleQuantities: { "051": 10, "052": 0 }, rowTotal: 10 },
        { marketCode: "LH", marketCodeB: "OLEEU", articleQuantities: { "051": 90, "052": 160 }, rowTotal: 250 },
      ],
      grandTotal: 4078,
      articleTotals: { "051": 2000, "052": 2078 },
      sizeTotals: [],
    };
    const extras = buildExtraPricesFromPo(po, country);
    // 7 non-zero (article, market) combinations (OD-052 is 0, so excluded).
    expect(extras).toHaveLength(7);
    expect(extras.find((e) => e.key === "article:051:market:OE")).toEqual({ key: "article:051:market:OE", price: 5.20, qty: 1800 });
    expect(extras.find((e) => e.key === "article:052:market:LH")).toEqual({ key: "article:052:market:LH", price: 5.80, qty: 160 });
    // Zero-qty combinations omitted (do not create an empty row).
    expect(extras.find((e) => e.key === "article:052:market:OD")).toBeUndefined();
  });
});

describe("mapToSummaryRows with article × market expansion", () => {
  it("expands to one row per (article × market) when extraPrices has that shape", () => {
    const po = fakePo({
      articles: [
        { articleNo: "051", hmColourCode: "75-901", ptArticleNumber: "03", colourName: "A", optionNoWithVersion: "x (V1)", cost: 5.20, costCurrency: "USD", qtyPerArticle: 2000 },
        { articleNo: "052", hmColourCode: "75-902", ptArticleNumber: "04", colourName: "B", optionNoWithVersion: "y (V1)", cost: 5.80, costCurrency: "USD", qtyPerArticle: 2078 },
      ],
    });
    const country: SalesContractCountryBreakdownExtract = {
      kind: "TotalCountryBreakdown",
      header: po.header,
      articles: ["051", "052"],
      rows: [
        { marketCode: "OE", marketCodeB: "OLCEU", articleQuantities: { "051": 1800, "052": 1744 }, rowTotal: 3544 },
        { marketCode: "OF", marketCodeB: "OLSEU", articleQuantities: { "051": 100, "052": 174 }, rowTotal: 274 },
        { marketCode: "OD", marketCodeB: "OL-ME", articleQuantities: { "051": 10, "052": 0 }, rowTotal: 10 },
        { marketCode: "LH", marketCodeB: "OLEEU", articleQuantities: { "051": 90, "052": 160 }, rowTotal: 250 },
      ],
      grandTotal: 4078,
      articleTotals: { "051": 2000, "052": 2078 },
      sizeTotals: [],
    };
    const extras = buildExtraPricesFromPo(po, country);
    const rows = mapToSummaryRows(po, cfg({ extraPrices: extras }), "po1");
    expect(rows.length).toBe(7); // 7 non-zero combinations
    // Prices stay distinct.
    const art051 = rows.filter((r) => r.country.includes("[art 051]"));
    const art052 = rows.filter((r) => r.country.includes("[art 052]"));
    expect(art051.every((r) => r.fob === 5.20)).toBe(true);
    expect(art052.every((r) => r.fob === 5.80)).toBe(true);
    // CONTRACT VALUE per row = that row's price × that row's qty.
    const oeArt051 = rows.find((r) => r.marketCode === "OE" && r.country.includes("[art 051]"))!;
    expect(oeArt051.contractValue).toBeCloseTo(5.20 * 1800, 2);
    // Order Qty + Pack/Set Qty only on first row (any order).
    const firsts = rows.filter((r) => r.isFirstForPo);
    expect(firsts).toHaveLength(1);
    expect(firsts[0].orderQty).toBe(4078);
    for (const r of rows.filter((r) => !r.isFirstForPo)) expect(r.orderQty).toBeNull();
  });
});

describe("writeSummaryWorkbook (spec Â§9, Â§12)", () => {
  const dir = join(tmpdir(), `hm-summary-${Date.now()}`);
  beforeAll(() => { mkdirSync(dir, { recursive: true }); });

  it("writes 21 header columns in the required order", async () => {
    const out = join(dir, "fresh.xlsx");
    await writeSummaryWorkbook({
      outputPath: out, pos: [{ poId: "po1", po: fakePo(), config: cfg() }],
      folderSequence: [{ folderLetter: "A", sequence: 0 }, { folderLetter: "B", sequence: 1 }],
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(out);
    const sheet = wb.getWorksheet("H&M")!;
    const headerRow = sheet.getRow(1);
    SUMMARY_HEADERS.forEach((h, i) => expect(headerRow.getCell(i + 1).value).toBe(h));
  });

  it("sorts by contract# ASC → folder sequence → PO order within folder", async () => {
    const out = join(dir, "sorted.xlsx");
    // Mix the input intentionally; writer must sort.
    await writeSummaryWorkbook({
      outputPath: out,
      pos: [
        { poId: "p3", po: fakePo({ header: { ...fakePo().header, orderNo: "90000-C" } }), config: cfg({ contractNo: "98", folderLetter: "A" }) },
        { poId: "p1", po: fakePo({ header: { ...fakePo().header, orderNo: "10000-A" } }), config: cfg({ contractNo: "97", folderLetter: "B" }) },
        { poId: "p2", po: fakePo({ header: { ...fakePo().header, orderNo: "20000-B" } }), config: cfg({ contractNo: "97", folderLetter: "A" }) },
      ],
      folderSequence: [{ folderLetter: "A", sequence: 0 }, { folderLetter: "B", sequence: 1 }],
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(out);
    const sheet = wb.getWorksheet("H&M")!;
    // Pull (D commercial Cont, A ref) from every data row that has an orderNo.
    const seen: { contract: string; folder: string; order: string }[] = [];
    sheet.eachRow({ includeEmpty: false }, (r, i) => {
      if (i < 2) return;
      const contract = String(r.getCell(4).value ?? "").trim();
      const ref = String(r.getCell(1).value ?? "");
      const folder = ref.match(/-([A-Z])\//)?.[1] ?? "";
      const order = String(r.getCell(6).value ?? "").trim();
      if (contract && order) seen.push({ contract, folder, order });
    });
    // Only first-for-PO rows carry the order-value in column F? No – every row carries F.
    // Dedup by order to simplify order-level ordering assertion.
    const perOrder = seen.filter((s, i, a) => a.findIndex((x) => x.order === s.order) === i);
    expect(perOrder.map((s) => `${s.contract}-${s.folder}-${s.order}`)).toEqual([
      "97-A-20000-B",
      "97-B-10000-A",
      "98-A-90000-C",
    ]);
  });

  it("preserves rows from other contracts untouched; preserves manual Remarks/T/U columns on same-PO regen", async () => {
    const first = join(dir, "first.xlsx");
    const second = join(dir, "second.xlsx");

    // Pass 1 – contract 97 only.
    await writeSummaryWorkbook({
      outputPath: first,
      pos: [{ poId: "p1", po: fakePo(), config: cfg({ contractNo: "97", folderLetter: "A" }) }],
      folderSequence: [{ folderLetter: "A", sequence: 0 }],
    });
    // Simulate the user editing REMARKS and T/U on the first data row.
    // Writer sorts markets alphabetically (LH, OD, OE, OF for this fake PO),
    // so row 2 holds the LH market.
    const wb1 = new ExcelJS.Workbook();
    await wb1.xlsx.readFile(first);
    const sheet1 = wb1.getWorksheet("H&M")!;
    sheet1.getCell("P2").value = "user remark";
    sheet1.getCell("T2").value = "old-fob";
    sheet1.getCell("U2").value = "date-text";
    await wb1.xlsx.writeFile(first);

    // Pass 2 – add contract 98. Must preserve 97's manual columns because the
    // business fingerprints for 643159's rows match the existing LH/OD/OE/OF
    // rows; the writer skips re-inserting them and keeps the existing row's
    // manual P/T/U untouched.
    const result = await writeSummaryWorkbook({
      templatePath: first,
      outputPath: second,
      pos: [
        { poId: "p1", po: fakePo(), config: cfg({ contractNo: "97", folderLetter: "A" }) },
        { poId: "p2", po: fakePo({ header: { ...fakePo().header, orderNo: "70000-X" } }), config: cfg({ contractNo: "98", folderLetter: "A" }) },
      ],
      folderSequence: [{ folderLetter: "A", sequence: 0 }],
    });
    expect(result.totalRows).toBeGreaterThan(4);
    expect(result.skippedExistingMatches.length).toBe(4); // 643159 all 4 markets matched

    const wb2 = new ExcelJS.Workbook();
    await wb2.xlsx.readFile(second);
    const sheet2 = wb2.getWorksheet("H&M")!;
    // Find the LH row for order 643159-8756 and verify its P/T/U survived.
    let found = false;
    sheet2.eachRow({ includeEmpty: false }, (r, i) => {
      if (i < 2) return;
      if (String(r.getCell(6).value) === "643159-8756" && String(r.getCell(15).value).startsWith("LH")) {
        expect(r.getCell(16).value).toBe("user remark"); // P
        expect(r.getCell(20).value).toBe("old-fob");     // T
        expect(r.getCell(21).value).toBe("date-text");   // U
        found = true;
      }
    });
    expect(found).toBe(true);
  });
});

describe("Row-level business fingerprint (2026-10-26-2 spec)", () => {
  describe("buildBusinessFp", () => {
    it("equal fingerprints for the same business line regardless of case/whitespace", () => {
      const a = buildBusinessFp({ orderNo: " 643159-8756 ", tod: "29 Jun, 2026", marketCode: "OE", fob: 6.18, styleNo: "Slim denim" });
      const b = buildBusinessFp({ orderNo: "643159-8756", tod: " 29  Jun, 2026 ", marketCode: "oe", fob: "6.18", styleNo: "slim denim" });
      expect(a).toBe(b);
      expect(a).not.toBe("");
    });
    it("different fingerprints when TOD differs", () => {
      const a = buildBusinessFp({ orderNo: "643159-8756", tod: "29 Jun, 2026", marketCode: "OE", fob: 6.18, styleNo: "" });
      const b = buildBusinessFp({ orderNo: "643159-8756", tod: "15 Jul, 2026", marketCode: "OE", fob: 6.18, styleNo: "" });
      expect(a).not.toBe(b);
    });
    it("different fingerprints when FOB differs – distinct prices never collide", () => {
      const a = buildBusinessFp({ orderNo: "P1", tod: "d", marketCode: "OE", fob: 5.20, styleNo: "" });
      const b = buildBusinessFp({ orderNo: "P1", tod: "d", marketCode: "OE", fob: 5.80, styleNo: "" });
      expect(a).not.toBe(b);
    });
    it("article number (from column O's [art XX] suffix) further distinguishes multi-article rows", () => {
      const a = buildBusinessFp({ orderNo: "P1", tod: "d", marketCode: "OE", fob: 5.20, styleNo: "x", country: "OE (OLCEU) [art 051]" });
      const b = buildBusinessFp({ orderNo: "P1", tod: "d", marketCode: "OE", fob: 5.20, styleNo: "x", country: "OE (OLCEU) [art 052]" });
      expect(a).not.toBe(b);
    });
    it("returns '' when the line has no order or no market (nothing to match)", () => {
      expect(buildBusinessFp({ orderNo: "", tod: "x", marketCode: "OE", fob: 1, styleNo: "" })).toBe("");
      expect(buildBusinessFp({ orderNo: "P", tod: "x", marketCode: "", fob: 1, styleNo: "" })).toBe("");
    });
  });

  describe("writer regeneration semantics", () => {
    const dir = join(tmpdir(), `hm-fp-${Date.now()}`);
    beforeAll(() => { mkdirSync(dir, { recursive: true }); });

    it("idempotent: same input twice → no new rows, no overwrites, no manual losses", async () => {
      const first = join(dir, "idem1.xlsx");
      const second = join(dir, "idem2.xlsx");
      const r1 = await writeSummaryWorkbook({
        outputPath: first,
        pos: [{ poId: "p1", po: fakePo(), config: cfg() }],
        folderSequence: [{ folderLetter: "A", sequence: 0 }],
      });
      expect(r1.insertedRows).toBe(4);
      expect(r1.skippedExistingMatches.length).toBe(0);

      const r2 = await writeSummaryWorkbook({
        templatePath: first,
        outputPath: second,
        pos: [{ poId: "p1", po: fakePo(), config: cfg() }],
        folderSequence: [{ folderLetter: "A", sequence: 0 }],
      });
      expect(r2.insertedRows).toBe(0);
      expect(r2.skippedExistingMatches.length).toBe(4);
      expect(r2.ambiguousMatches.length).toBe(0);
      expect(r2.totalRows).toBe(4); // SAME as pass 1 – no duplicates
    });

    it("preserves a manual contract reassignment – new config's contractNo does NOT overwrite col D", async () => {
      const first = join(dir, "move1.xlsx");
      const second = join(dir, "move2.xlsx");
      await writeSummaryWorkbook({
        outputPath: first,
        pos: [{ poId: "p1", po: fakePo(), config: cfg({ contractNo: "97", folderLetter: "A" }) }],
        folderSequence: [{ folderLetter: "A", sequence: 0 }],
      });

      // User manually moves the OE row from contract 97 to 98 in the workbook.
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.readFile(first);
      const sh = wb.getWorksheet("H&M")!;
      let movedRow = 0;
      sh.eachRow({ includeEmpty: false }, (r, i) => {
        if (i < 2) return;
        if (String(r.getCell(15).value).startsWith("OE")) { r.getCell(4).value = "98"; movedRow = i; }
      });
      expect(movedRow).toBeGreaterThan(0);
      await wb.xlsx.writeFile(first);

      // Regen with the "current" contract still set to 97. The OE row must
      // STAY on 98 (business fp still matches), the other 3 markets must
      // match on 97, and no duplicates must be created.
      const r2 = await writeSummaryWorkbook({
        templatePath: first,
        outputPath: second,
        pos: [{ poId: "p1", po: fakePo(), config: cfg({ contractNo: "97", folderLetter: "A" }) }],
        folderSequence: [{ folderLetter: "A", sequence: 0 }],
      });
      expect(r2.insertedRows).toBe(0);
      expect(r2.skippedExistingMatches.length).toBe(4);
      const oeSkip = r2.skippedExistingMatches.find((s) => s.marketCode === "OE")!;
      expect(oeSkip.newContract).toBe("97");
      expect(oeSkip.existingContract).toBe("98");
      expect(oeSkip.note).toBe("contract_preserved_from_existing");

      // Verify the OE row's col D is still "98" in the output.
      const wb2 = new ExcelJS.Workbook();
      await wb2.xlsx.readFile(second);
      const sh2 = wb2.getWorksheet("H&M")!;
      let oeContract = "";
      sh2.eachRow({ includeEmpty: false }, (r, i) => {
        if (i < 2) return;
        if (String(r.getCell(15).value).startsWith("OE") && String(r.getCell(6).value) === "643159-8756") {
          oeContract = String(r.getCell(4).value ?? "");
        }
      });
      expect(oeContract).toBe("98");
    });

    it("legacy ref (no folder letter) still matches – AGL/H&M/97/2025 row survives, no duplicate on regen", async () => {
      const first = join(dir, "legacy1.xlsx");
      const second = join(dir, "legacy2.xlsx");
      // Hand-crafted legacy workbook: ref uses the old AGL/H&M/97/2025 shape.
      const wb = new ExcelJS.Workbook();
      const sh = wb.addWorksheet("H&M");
      SUMMARY_HEADERS.forEach((h, i) => sh.getRow(1).getCell(i + 1).value = h);
      const row = sh.getRow(2);
      row.getCell(1).value = "AGL/H&M/97/2025";          // A (legacy, no -A)
      row.getCell(4).value = "97";                        // D
      row.getCell(6).value = "643159-8756";               // F
      row.getCell(7).value = 3544;                        // G
      row.getCell(8).value = "Slim denim";                // H
      row.getCell(9).value = 6.18;                        // I
      row.getCell(14).value = "29 Jun, 2026";             // N
      row.getCell(15).value = "OE (OLCEU)";               // O
      row.getCell(16).value = "legacy remark";            // P (manual)
      row.commit();
      await wb.xlsx.writeFile(first);

      const r = await writeSummaryWorkbook({
        templatePath: first,
        outputPath: second,
        pos: [{ poId: "p1", po: fakePo(), config: cfg({ contractNo: "97", folderLetter: "A" }) }],
        folderSequence: [{ folderLetter: "A", sequence: 0 }],
      });
      // The 4 markets split: OE matches the legacy row (same business line),
      // LH/OD/OF insert fresh.
      expect(r.insertedRows).toBe(3);
      expect(r.skippedExistingMatches.length).toBe(1);
      expect(r.skippedExistingMatches[0].marketCode).toBe("OE");

      const wb2 = new ExcelJS.Workbook();
      await wb2.xlsx.readFile(second);
      const sh2 = wb2.getWorksheet("H&M")!;
      let oeCount = 0;
      let legacyRemarkSurvived = false;
      sh2.eachRow({ includeEmpty: false }, (r2, i) => {
        if (i < 2) return;
        if (String(r2.getCell(6).value) === "643159-8756" && String(r2.getCell(15).value).startsWith("OE")) {
          oeCount++;
          if (String(r2.getCell(16).value) === "legacy remark") legacyRemarkSurvived = true;
        }
      });
      expect(oeCount).toBe(1); // no duplicate
      expect(legacyRemarkSurvived).toBe(true);
    });

    it("ambiguous: 2+ existing rows with the same fingerprint → preserved, flagged, no new row", async () => {
      const first = join(dir, "amb1.xlsx");
      const second = join(dir, "amb2.xlsx");
      // Workbook with TWO rows that both match the OE line's fingerprint.
      const wb = new ExcelJS.Workbook();
      const sh = wb.addWorksheet("H&M");
      SUMMARY_HEADERS.forEach((h, i) => sh.getRow(1).getCell(i + 1).value = h);
      const writeLegacyOE = (row: number, contract: string) => {
        const r = sh.getRow(row);
        r.getCell(1).value = `AGL/H&M/${contract}-A/2026`;
        r.getCell(4).value = contract;
        r.getCell(6).value = "643159-8756";
        r.getCell(7).value = 3544;
        r.getCell(8).value = "Slim denim";
        r.getCell(9).value = 6.18;
        r.getCell(14).value = "29 Jun, 2026";
        r.getCell(15).value = "OE (OLCEU)";
        r.commit();
      };
      writeLegacyOE(2, "97");
      writeLegacyOE(3, "97");
      await wb.xlsx.writeFile(first);

      const r = await writeSummaryWorkbook({
        templatePath: first,
        outputPath: second,
        pos: [{ poId: "p1", po: fakePo(), config: cfg({ contractNo: "97", folderLetter: "A" }) }],
        folderSequence: [{ folderLetter: "A", sequence: 0 }],
      });
      expect(r.ambiguousMatches.length).toBe(1);
      expect(r.ambiguousMatches[0].marketCode).toBe("OE");
      expect(r.ambiguousMatches[0].occurrences).toBe(2);
      // The OE line was NOT inserted (ambiguous), but LH/OD/OF were (3 inserts).
      expect(r.insertedRows).toBe(3);
    });

    it("same PO on different TOD/country combinations → multiple rows, each a distinct fingerprint", async () => {
      const first = join(dir, "multi1.xlsx");
      // Create a PO where two markets happen to share the TOD. Each is still a distinct fp (different market).
      const r = await writeSummaryWorkbook({
        outputPath: first,
        pos: [{ poId: "p1", po: fakePo(), config: cfg() }],
        folderSequence: [{ folderLetter: "A", sequence: 0 }],
      });
      expect(r.insertedRows).toBe(4);
      // Re-run with a modified PO: same markets, same TODs, DIFFERENT fob → 4 new inserts (distinct fp).
      const po2 = fakePo({ invoiceAveragePrice: 7.99 });
      const r2 = await writeSummaryWorkbook({
        templatePath: first,
        outputPath: join(dir, "multi2.xlsx"),
        pos: [{ poId: "p1", po: po2, config: cfg() }],
        folderSequence: [{ folderLetter: "A", sequence: 0 }],
      });
      // Distinct FOB → distinct fingerprints → 4 new rows, 0 skipped.
      expect(r2.insertedRows).toBe(4);
      expect(r2.skippedExistingMatches.length).toBe(0);
      expect(r2.totalRows).toBe(8); // 4 old + 4 new, both preserved
    });
  });
});
