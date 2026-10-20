import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyHmDoc, parsePoText, summariseExtraction } from "@/server/sales-contract/parse";
import { runPipeline } from "@/server/sales-contract/pipeline";

/**
 * Regression tests for the generic Sales Contract batch flow against the real
 * three H&M PDFs for order 643159-8756. These are the three documents that
 * previously bounced out of the batch as `SCHEMA_DRIFT: Purchase Order text
 * did not match the expected market-row layout`.
 */
const PO_TEXT = readFileSync(join(__dirname, "fixtures/hm-643159-po.txt"), "utf8");
const SIZE_TEXT = readFileSync(join(__dirname, "fixtures/hm-643159-size.txt"), "utf8");
const COUNTRY_TEXT = readFileSync(join(__dirname, "fixtures/hm-643159-country.txt"), "utf8");

describe("classifyHmDoc", () => {
  it("recognises each of the three H&M document kinds", () => {
    expect(classifyHmDoc(PO_TEXT)).toBe("PurchaseOrder");
    expect(classifyHmDoc(SIZE_TEXT)).toBe("SizePerColourBreakdown");
    expect(classifyHmDoc(COUNTRY_TEXT)).toBe("TotalCountryBreakdown");
  });

  it("falls back to the filename when text has no banner", () => {
    expect(classifyHmDoc("", "643159_PurchaseOrder_Supplier.pdf")).toBe("PurchaseOrder");
    expect(classifyHmDoc("", "643159_SizePerColourBreakdown_Supplier.pdf")).toBe("SizePerColourBreakdown");
    expect(classifyHmDoc("", "643159_TotalCountryBreakdown_Supplier.pdf")).toBe("TotalCountryBreakdown");
    expect(classifyHmDoc("", "whatever.pdf")).toBe("Unknown");
  });
});

describe("parsePoText — real H&M concatenated layout", () => {
  it("yields one normalised row per market from the real 643159 PO PDF", () => {
    const rows = parsePoText(PO_TEXT);
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.orderNo === "643159-8756")).toBe(true);
    const byMarket = Object.fromEntries(rows.map((r) => [r.planningMarketA, r.quantity]));
    expect(byMarket).toEqual({ OE: "3544", OF: "274", OD: "10", LH: "250" });
    // Price + currency reach each row from the Invoice Average Price block.
    for (const r of rows) {
      expect(r.invoiceAveragePrice).toBe("6.18");
      expect(r.currency).toBe("USD");
    }
    // PM-B stays in `(code)` form for the existing validator (PM_B_RE).
    const codesB = Object.fromEntries(rows.map((r) => [r.planningMarketA, r.planningMarketB]));
    expect(codesB).toEqual({ OE: "(OLCEU)", OF: "(OLSEU)", OD: "(OL-ME)", LH: "(OLEEU)" });
  });

  it("keeps the historical one-line layout working for the legacy fixture", () => {
    // Mimic the normalised pdftotext layout documented in SRS §C.3.
    const legacy =
      "PO Number: 644923-5672\n" +
      "Season: 2-2026\n" +
      "Customer Group: Boys\n" +
      "Construction: Woven\n" +
      "Currency: USD\n" +
      "OW (OL-MX) 2000 12.64 09 Jun, 2026\n";
    const rows = parsePoText(legacy);
    expect(rows).toHaveLength(1);
    expect(rows[0].orderNo).toBe("644923-5672");
    expect(rows[0].planningMarketA).toBe("OW");
    expect(rows[0].invoiceAveragePrice).toBe("12.64");
  });
});

describe("runPipeline — H&M PO PDF end-to-end through the generic batch", () => {
  it("produces 4 validated per-market rows and ONE aggregated contract row (NO SCHEMA_DRIFT)", () => {
    const result = runPipeline(
      { subject: "643159-8756", poText: PO_TEXT, attachments: ["643159_PurchaseOrder_Supplier.pdf"] },
      { skipAttachmentCheck: true },
    );
    expect(result.outcome).toBe("draft");
    expect(result.poRows).toHaveLength(4);
    expect(result.poRows.every((r) => r.success)).toBe(true);
    expect(result.contractRows).toHaveLength(1);
    expect(result.contractRows[0].orderQty).toBe(4078);
    expect(result.contractRows[0].orderNo).toBe("643159-8756");
    // Not a SCHEMA_DRIFT: no hard reason survives from the parser.
    expect(result.reviewReasons.some((r) => r.code === "SCHEMA_DRIFT")).toBe(false);
  });
});

describe("summariseExtraction — rich per-file extraction summaries", () => {
  it("exposes every PO header field so the batch UI can show them", () => {
    const s = summariseExtraction(PO_TEXT, "643159_PurchaseOrder.pdf");
    expect(s.kind).toBe("PurchaseOrder");
    const by = Object.fromEntries(s.fields.map((f) => [f.label, f.value]));
    expect(by["Order No"]).toBe("643159-8756");
    expect(by["Supplier Code"]).toBe("0197");            // leading zero preserved
    expect(by["Product No"]).toBe("0803160");
    expect(by["Development No"]).toBe("0001732C");
    expect(by["Invoice Average Price"]).toBe("6.18 USD");
    expect(by["Article 051 · H&M Colour Code"]).toBe("75-901");
    expect(s.rows).toHaveLength(4);
    expect(s.totals.find((t) => t.label === "PO Total Quantity")?.value).toBe("4078");
  });

  it("summarises a Size breakdown with per-market pages and per-size qtys", () => {
    const s = summariseExtraction(SIZE_TEXT);
    expect(s.kind).toBe("SizePerColourBreakdown");
    expect(s.rows).toHaveLength(0);
    const by = Object.fromEntries(s.fields.map((f) => [f.label, f.value]));
    expect(by["Order No"]).toBe("643159-8756");
    expect(by["OE · Market Quantity"]).toBe("3544");
    expect(by["OE · size 134 (134)*"]).toBe("284");
    expect(s.totals.find((t) => t.label === "Sum of market quantities")?.value).toBe("4078");
    expect(s.notes[0]).toMatch(/not a Purchase Order/i);
  });

  it("summarises a Country breakdown with per-article totals + size totals", () => {
    const s = summariseExtraction(COUNTRY_TEXT);
    expect(s.kind).toBe("TotalCountryBreakdown");
    const by = Object.fromEntries(s.fields.map((f) => [f.label, f.value]));
    expect(by["Order No"]).toBe("643159-8756");
    expect(by["OE (OLCEU) · article 051"]).toBe("3544");
    expect(by["Articles"]).toBe("051");
    expect(s.totals.find((t) => t.label === "Grand total")?.value).toBe("4078");
    expect(s.notes[0]).toMatch(/not a Purchase Order/i);
  });

  it("marks an unknown-kind PDF honestly without inventing fields", () => {
    const s = summariseExtraction("random noise text that is not an H&M document", "misc.pdf");
    expect(s.kind).toBe("Unknown");
    expect(s.rows).toEqual([]);
    expect(s.fields).toEqual([]);
    expect(s.notes.length).toBeGreaterThan(0);
  });
});
