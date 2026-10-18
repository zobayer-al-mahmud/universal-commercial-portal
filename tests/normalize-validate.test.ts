import { describe, it, expect } from "vitest";
import { normalizeDate, normalizePoRow, buildItemDescription } from "@/server/sales-contract/normalize";
import { validatePoRow } from "@/server/sales-contract/validate";

describe("normalizeDate", () => {
  it("parses 'dd Mon, yyyy'", () => {
    expect(normalizeDate("09 Jun, 2026")).toBe("2026-06-09");
  });
  it("parses 'dd.mm.yyyy'", () => {
    expect(normalizeDate("08.06.2026")).toBe("2026-06-08");
  });
  it("returns null for junk", () => {
    expect(normalizeDate("not a date")).toBeNull();
  });
});

describe("normalizePoRow", () => {
  it("normalises currency and transport defaults", () => {
    const n = normalizePoRow({ orderNo: "644923-5672", quantity: "2,000", invoiceAveragePrice: "12.64" });
    expect(n.currency).toBe("USD");
    expect(n.transportBy).toBe("Sea");
    expect(n.quantity).toBe(2000);
    expect(n.invoiceAveragePrice).toBe(12.64);
  });
});

describe("buildItemDescription (BR-SC-15)", () => {
  it("joins description + group + construction", () => {
    const n = normalizePoRow({
      orderNo: "644923-5672",
      productDescription: "Trousers",
      customsCustomerGroup: "Men",
      typeOfConstruction: "Woven",
    });
    expect(buildItemDescription(n)).toBe("Trousers Men Woven");
  });
});

describe("validatePoRow (§C.3 / §D)", () => {
  const good = normalizePoRow({
    orderNo: "644923-5672",
    season: "3-2026",
    planningMarketA: "OW",
    planningMarketB: "(OL-MX)",
    quantity: "2000",
    invoiceAveragePrice: "12.64",
    timeOfDelivery: "09 Jun, 2026",
    currency: "USD",
  });

  it("accepts a well-formed row", () => {
    const v = validatePoRow(good);
    expect(v.success).toBe(true);
    expect(v.issues).toHaveLength(0);
  });

  it("rejects an invalid OrderNo", () => {
    const v = validatePoRow({ ...good, orderNo: "99-9" });
    expect(v.success).toBe(false);
    expect(v.issues.some((i) => i.code === "INVALID_PO_NUMBER")).toBe(true);
  });

  it("flags non-USD currency as pending (not hard)", () => {
    const v = validatePoRow({ ...good, currency: "EUR" });
    expect(v.success).toBe(true);
    expect(v.issues.some((i) => i.code === "NON_USD_CURRENCY" && i.severity === "pending")).toBe(true);
  });

  it("rejects zero quantity", () => {
    const v = validatePoRow({ ...good, quantity: 0 });
    expect(v.success).toBe(false);
    expect(v.issues.some((i) => i.code === "INVALID_QTY")).toBe(true);
  });
});
