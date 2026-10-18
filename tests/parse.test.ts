import { describe, it, expect } from "vitest";
import { extractOrderNumbers, checkAttachments, parsePoText } from "@/server/sales-contract/parse";
import {
  SAMPLE_PO_SINGLE_MARKET,
  SAMPLE_PO_MULTI_MARKET_EQUAL,
} from "./fixtures/sample-po";

describe("extractOrderNumbers (BR-SC-19)", () => {
  it("extracts a single OrderNo from a subject", () => {
    expect(extractOrderNumbers("Order Package 644923-5672 REGULAR LP S4")).toEqual(["644923-5672"]);
  });

  it("extracts multiple OrderNos", () => {
    const got = extractOrderNumbers("Order Package 589538-875, 589537-8756");
    expect(got.sort()).toEqual(["589537-8756", "589538-875"].sort());
  });

  it("expands compound <a>_<b>-<suffix> filenames", () => {
    const got = extractOrderNumbers("Order Package 645670_645669-7878 EQ DENIM");
    expect(got.sort()).toEqual(["645669-7878", "645670-7878"].sort());
  });
});

describe("checkAttachments (SC-FR-003)", () => {
  it("passes when all three PDFs present", () => {
    const res = checkAttachments([
      "644923_PurchaseOrder_Supplier_x.pdf",
      "644923_SizePerColourBreakdown_Supplier_x.pdf",
      "644923_TotalCountryBreakdown_Supplier_x.pdf",
    ]);
    expect(res.ok).toBe(true);
    expect(res.missing).toEqual([]);
  });

  it("reports missing PDFs", () => {
    const res = checkAttachments(["644923_PurchaseOrder_Supplier_x.pdf"]);
    expect(res.ok).toBe(false);
    expect(res.missing).toContain("SizePerColourBreakdown");
    expect(res.missing).toContain("TotalCountryBreakdown");
  });
});

describe("parsePoText", () => {
  it("parses a single-market PO", () => {
    const rows = parsePoText(SAMPLE_PO_SINGLE_MARKET);
    expect(rows).toHaveLength(1);
    expect(rows[0].orderNo).toBe("644923-5672");
    expect(rows[0].planningMarketA).toBe("OW");
    expect(rows[0].planningMarketB).toBe("(OL-MX)");
    expect(rows[0].quantity).toBe("2000");
    expect(rows[0].invoiceAveragePrice).toBe("12.64");
  });

  it("parses multiple market rows", () => {
    const rows = parsePoText(SAMPLE_PO_MULTI_MARKET_EQUAL);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.quantity)).toEqual(["1000", "1500"]);
  });
});
