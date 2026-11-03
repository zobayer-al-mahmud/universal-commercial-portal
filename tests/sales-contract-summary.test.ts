import { describe, it, expect, beforeAll } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import ExcelJS from "exceljs";
import { mapToSummaryRows, buildExtraPricesFromPo } from "@/server/sales-contract/summary-rows";
import { writeSummaryWorkbook, SUMMARY_HEADERS } from "@/server/sales-contract/summary-writer";
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
      creationDate: null,
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
    // One row per DISTINCT (tod, country, price). Articles 051 and 052 ship
    // at different prices, so each (market, price) stays a separate row:
    // OE×5.20, OE×5.80, OF×5.20, OF×5.80, OD×5.20 (052 qty = 0 drops), LH×5.20, LH×5.80
    // = 7 combinations. User rule 2026-10-28: no `[art N]` suffix in the
    // country column; article identity is dropped at merge time.
    expect(rows.length).toBe(7);
    const low = rows.filter((r) => r.fob === 5.20);
    const high = rows.filter((r) => r.fob === 5.80);
    expect(low.length + high.length).toBe(7);
    // Country column is `<marketCode> (<marketCodeB>)` only — no article suffix.
    for (const r of rows) expect(r.country).not.toMatch(/\[art /);
    expect(rows.find((r) => r.marketCode === "OE" && r.fob === 5.20)!.country).toBe("OE (OLCEU)");
    // CONTRACT VALUE per row = that row's price × that row's qty.
    const oeLow = rows.find((r) => r.marketCode === "OE" && r.fob === 5.20)!;
    expect(oeLow.contractValue).toBeCloseTo(5.20 * 1800, 2);
  });

  it("merges same-(TOD, country, price) rows when the article split would produce duplicates", () => {
    // Two articles with DISTINCT prices, so the article×market expansion
    // kicks in; the (051 × OE) and (052 × OE) combos should still appear as
    // ONE row each (never two with [art …] suffixes). The country column
    // never carries an article suffix (user rule 2026-10-28).
    const po = fakePo({
      articles: [
        { articleNo: "051", hmColourCode: "75-901", ptArticleNumber: "03", colourName: "A", optionNoWithVersion: "x (V1)", cost: 5.20, costCurrency: "USD", qtyPerArticle: 1800 },
        { articleNo: "052", hmColourCode: "75-902", ptArticleNumber: "04", colourName: "B", optionNoWithVersion: "y (V1)", cost: 5.80, costCurrency: "USD", qtyPerArticle: 1744 },
      ],
      marketRows: [
        { tod: "29 Jun, 2026", marketCode: "OE", marketCodeB: "OLCEU", quantity: 3544, quantityRaw: "3 544", pct: 100 },
      ],
      totalQty: 3544,
    });
    const country: SalesContractCountryBreakdownExtract = {
      kind: "TotalCountryBreakdown",
      header: po.header,
      articles: ["051", "052"],
      rows: [
        { marketCode: "OE", marketCodeB: "OLCEU", articleQuantities: { "051": 1800, "052": 1744 }, rowTotal: 3544 },
      ],
      grandTotal: 3544,
      articleTotals: { "051": 1800, "052": 1744 },
      sizeTotals: [],
    };
    const extras = buildExtraPricesFromPo(po, country);
    const rows = mapToSummaryRows(po, cfg({ extraPrices: extras }), "po1");
    // Two distinct prices → two rows (one per price), both for OE. No
    // "[art …]" suffix in the country column.
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r.country).toBe("OE (OLCEU)");
    for (const r of rows) expect(r.country).not.toMatch(/\[art /);
    const prices = rows.map((r) => r.fob).sort();
    expect(prices).toEqual([5.20, 5.80]);
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
});
