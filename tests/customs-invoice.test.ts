import { describe, it, expect } from "vitest";
import { buildCustomsInvoice, parseLineItems } from "@/server/customs-invoice/build";
import type { CustomsInvoiceInput } from "@/server/customs-invoice/types";

const BASE: CustomsInvoiceInput = {
  invoiceNumber: "45238",
  marketCode: "NH",
  invoiceDate: "28.12.2025",
  contractNo: "AGL/H&M/97/2025",
  contractDate: "06.07.2025",
  hmOrderNo: "498160/8757",
  expNo: "31074",
  expDate: "28.12.2025",
  portOfLoading: "CHITTAGONG",
  portOfDelivery: "Singapore",
  countryOfOrigin: "Bangladesh",
  countryOfFinalDestination: "MALAYSIA",
  lineItems: [
    { description: "Women Woven Trouser", hsCode: "62046200", quantity: 100, unitPrice: 5.5 },
    { description: "Women Woven Trouser", hsCode: "62046200", quantity: 50, unitPrice: 5.5 },
  ],
};

describe("parseLineItems", () => {
  it("parses pipe-delimited line items", () => {
    const items = parseLineItems("Trouser|62046200|100|5.50\nShirt|62052000|20|6.00");
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({ description: "Trouser", hsCode: "62046200", quantity: 100, unitPrice: 5.5 });
  });
});

describe("buildCustomsInvoice", () => {
  it("computes line amounts, totals, and invoice key", () => {
    const doc = buildCustomsInvoice(BASE, { cargoDeliveryByMarket: { NH: "H&M Retail Sdn Bhd" } });
    expect(doc.success).toBe(true);
    expect(doc.invoiceKey).toBe("45238 NH");
    expect(doc.lineItems[0].amount).toBe(550);
    expect(doc.totalQty).toBe(150);
    expect(doc.totalValue).toBe(825);
    expect(doc.cargoDeliveryName).toBe("H&M Retail Sdn Bhd");
    expect(doc.exporterName).toMatch(/ANANTA GARMENTS LIMITED/);
  });

  it("flags a missing consignee mapping as pending (still drafts)", () => {
    const doc = buildCustomsInvoice(BASE, { cargoDeliveryByMarket: {} });
    expect(doc.success).toBe(true);
    expect(doc.issues.some((i) => i.code === "CONSIGNEE_NOT_FOUND" && i.severity === "pending")).toBe(true);
  });

  it("hard-fails on an invalid contract ref", () => {
    const doc = buildCustomsInvoice({ ...BASE, contractNo: "BAD" });
    expect(doc.success).toBe(false);
    expect(doc.issues.some((i) => i.code === "INVALID_CONTRACT_REF")).toBe(true);
  });

  it("hard-fails with no line items", () => {
    const doc = buildCustomsInvoice({ ...BASE, lineItems: [] });
    expect(doc.success).toBe(false);
    expect(doc.issues.some((i) => i.code === "NO_LINE_ITEMS")).toBe(true);
  });

  it("hard-fails on a zero-quantity line", () => {
    const doc = buildCustomsInvoice({ ...BASE, lineItems: [{ description: "X", hsCode: "1", quantity: 0, unitPrice: 5 }] });
    expect(doc.success).toBe(false);
    expect(doc.issues.some((i) => i.code === "INVALID_QTY")).toBe(true);
  });
});
