import { describe, it, expect } from "vitest";
import { runPipeline } from "@/server/sales-contract/pipeline";
import {
  resolveUnitPrice,
  resolveTod,
  aggregateContractRow,
} from "@/server/sales-contract/reconcile";
import { normalizePoRow } from "@/server/sales-contract/normalize";
import {
  SAMPLE_PO_MULTI_MARKET_EQUAL,
  SAMPLE_PO_PRICE_DIVERGENCE,
  SAMPLE_PO_BAD_ORDER,
} from "./fixtures/sample-po";

const THREE_PDFS = [
  "x_PurchaseOrder_Supplier_x.pdf",
  "x_SizePerColourBreakdown_Supplier_x.pdf",
  "x_TotalCountryBreakdown_Supplier_x.pdf",
];

describe("resolveUnitPrice (BR-SC-10 / Q-SC-01)", () => {
  it("returns the single price when all equal", () => {
    const r = resolveUnitPrice([10.5, 10.5], [100, 200], { mode: "equal-only" });
    expect(r.value).toBe(10.5);
    expect(r.issue).toBeUndefined();
  });
  it("flags a pending decision when prices differ", () => {
    const r = resolveUnitPrice([6.34, 6.36], [500, 700], { mode: "equal-only" });
    expect(r.issue?.code).toBe("BUSINESS_DECISION_PENDING");
  });
  it("computes weighted average when configured", () => {
    const r = resolveUnitPrice([6.0, 8.0], [100, 300], { mode: "weighted-average" });
    expect(r.value).toBe(7.5);
  });
});

describe("resolveTod (BR-SC-17 / Q-SC-02)", () => {
  it("returns the single TOD when markets agree", () => {
    const r = resolveTod(["2026-06-09", "2026-06-09"], { mode: "earliest" });
    expect(r.value).toBe("2026-06-09");
    expect(r.issue).toBeUndefined();
  });
  it("flags pending + picks earliest when markets differ", () => {
    const r = resolveTod(["2026-06-11", "2026-06-09"], { mode: "earliest" });
    expect(r.value).toBe("2026-06-09");
    expect(r.issue?.code).toBe("BUSINESS_DECISION_PENDING");
  });
});

describe("aggregateContractRow (BR-SC-09..14)", () => {
  it("sums market quantities and computes value", () => {
    const rows = [
      normalizePoRow({ orderNo: "644637-8756", productName: "Slim Denim", quantity: "1000", invoiceAveragePrice: "10.50", timeOfDelivery: "09 Jun, 2026" }),
      normalizePoRow({ orderNo: "644637-8756", productName: "Slim Denim", quantity: "1500", invoiceAveragePrice: "10.50", timeOfDelivery: "09 Jun, 2026" }),
    ];
    const cr = aggregateContractRow("644637-8756", rows, {
      unitPrice: { mode: "equal-only" },
      tod: { mode: "earliest" },
    });
    expect(cr.orderQty).toBe(2500);
    expect(cr.value).toBe(26250);
    expect(cr.issues).toHaveLength(0);
  });
});

describe("runPipeline end-to-end", () => {
  it("drafts a clean multi-market order (SC-TC-001/007)", () => {
    const res = runPipeline({
      subject: "Order Package 644637-8756 Slim Denim S4",
      attachments: THREE_PDFS,
      poText: SAMPLE_PO_MULTI_MARKET_EQUAL,
      blockContractRef: "AGL/H&M/99/2026",
    });
    expect(res.outcome).toBe("draft");
    expect(res.contractRows).toHaveLength(1);
    expect(res.contractRows[0].orderQty).toBe(2500);
    expect(res.reviewReasons).toHaveLength(0);
  });

  it("queues when a PDF is missing (SC-TC-004)", () => {
    const res = runPipeline({
      subject: "Order Package 644637-8756",
      attachments: ["x_PurchaseOrder_Supplier_x.pdf"],
      poText: SAMPLE_PO_MULTI_MARKET_EQUAL,
    });
    expect(res.outcome).toBe("queued");
    expect(res.reviewReasons.some((r) => r.code === "MISSING_PDF")).toBe(true);
  });

  it("queues on an invalid OrderNo and writes no contract rows (SC-TC-005)", () => {
    const res = runPipeline({
      subject: "Order Package 99-9",
      attachments: THREE_PDFS,
      poText: SAMPLE_PO_BAD_ORDER,
    });
    expect(res.outcome).toBe("queued");
    expect(res.contractRows).toHaveLength(0);
    expect(res.reviewReasons.some((r) => r.code === "INVALID_PO_NUMBER")).toBe(true);
  });

  it("drafts but flags a pending decision on price divergence (SC-TC-008)", () => {
    const res = runPipeline({
      subject: "Order Package 649397-5672",
      attachments: THREE_PDFS,
      poText: SAMPLE_PO_PRICE_DIVERGENCE,
    });
    expect(res.outcome).toBe("draft");
    expect(res.reviewReasons.some((r) => r.code === "BUSINESS_DECISION_PENDING")).toBe(true);
  });
});
