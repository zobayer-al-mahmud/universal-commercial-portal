import { describe, it, expect } from "vitest";
import { matchBooking } from "@/server/booking-correction/match";
import type { ExtractionResult, ExtractedValue } from "@/server/booking-correction/batch-types";

function val(n: string): ExtractedValue {
  return { value: n, normalized: n, label: "test", page: 1, confidence: 1 };
}
function extraction(gw: string, c: string, q: string): ExtractionResult {
  return {
    poNumber: "698757", countryCode: "VN", marketCode: "VNW221",
    grossWeight: gw ? val(gw) : null, cartons: c ? val(c) : null, quantity: q ? val(q) : null,
    complete: true, confidence: 1, reviewReasons: [], pages: 1, textChars: 100,
  };
}
const OPTS = { grossWeightToleranceKg: 0.5 };

describe("matchBooking", () => {
  it("MATCHED when all three agree (gross within tolerance)", () => {
    const r = matchBooking(extraction("88.61", "7", "114"), { grossWeight: "88.80", cartons: "7", quantity: "114" }, OPTS);
    expect(r.outcome).toBe("MATCHED");
  });

  it("MISMATCH on gross weight beyond tolerance", () => {
    const r = matchBooking(extraction("88.61", "7", "114"), { grossWeight: "93.9", cartons: "7", quantity: "114" }, OPTS);
    expect(r.outcome).toBe("MISMATCH");
    expect(r.comparisons.find((c) => c.field === "grossWeight")!.match).toBe(false);
  });

  it("MISMATCH on carton count (exact rule)", () => {
    const r = matchBooking(extraction("88.61", "7", "114"), { grossWeight: "88.61", cartons: "8", quantity: "114" }, OPTS);
    expect(r.outcome).toBe("MISMATCH");
    expect(r.comparisons.find((c) => c.field === "cartons")!.match).toBe(false);
  });

  it("MISMATCH on quantity", () => {
    const r = matchBooking(extraction("88.61", "7", "114"), { grossWeight: "88.61", cartons: "7", quantity: "120" }, OPTS);
    expect(r.outcome).toBe("MISMATCH");
  });

  it("NEEDS_REVIEW when a value is missing (missing is never a match)", () => {
    const r = matchBooking(extraction("88.61", "", "114"), { grossWeight: "88.61", cartons: "7", quantity: "114" }, OPTS);
    expect(r.outcome).toBe("NEEDS_REVIEW");
  });
});

// Excel-driven 7-field matching + candidate disambiguation (§2/§9).
function excelExtraction(over: Partial<ExtractionResult> = {}): ExtractionResult {
  return {
    poNumber: "728045", countryCode: "OF", marketCode: "OF",
    shipper: "ABM Fashions Ltd (134715)", frCode: "NLW174",
    grossWeight: val("109.14"), cartons: val("16"), quantity: val("521"),
    complete: true, confidence: 1, reviewReasons: [], pages: 0, textChars: 0,
    ...over,
  };
}

describe("matchBooking — identity fields (PO/SKU/Shipper/FR)", () => {
  // The two candidates from the screenshot search 728045*/OF* (both CONFIRMED, same
  // totals readable), disambiguated only by identity.
  const rightBooking = { grossWeight: "109.140", cartons: "16", quantity: "521", poNumber: "728045/5-2027", sku: "OF/7656", shipper: "ABM FASHIONS LTD", frCode: "NLW174" };

  it("MATCHED when identity + totals all agree (manufacturer truncation tolerated)", () => {
    const r = matchBooking(excelExtraction(), { ...rightBooking, shipper: "ABM FASHIONS L" }, OPTS);
    expect(r.outcome).toBe("MATCHED");
    expect(r.comparisons.find((c) => c.field === "shipper")!.match).toBe(true);
    expect(r.comparisons.find((c) => c.field === "frCode")!.match).toBe(true);
  });

  it("PO/SKU match by prefix (booking carries a suffix)", () => {
    const r = matchBooking(excelExtraction(), rightBooking, OPTS);
    expect(r.comparisons.find((c) => c.field === "poNumber")!.match).toBe(true);
    expect(r.comparisons.find((c) => c.field === "sku")!.match).toBe(true);
  });

  it("MISMATCH (not the right booking) when FR differs — the other candidate", () => {
    const r = matchBooking(excelExtraction(), { ...rightBooking, frCode: "PLW256" }, OPTS);
    expect(r.outcome).toBe("MISMATCH");
    expect(r.comparisons.find((c) => c.field === "frCode")!.match).toBe(false);
  });

  it("MISMATCH when the Shipper (manufacturer) differs", () => {
    const r = matchBooking(excelExtraction(), { ...rightBooking, shipper: "ANANTA GARMENTS LTD" }, OPTS);
    expect(r.outcome).toBe("MISMATCH");
  });

  it("identity fields are informational when the booking omits them (legacy PDF path)", () => {
    const r = matchBooking(excelExtraction(), { grossWeight: "109.14", cartons: "16", quantity: "521" }, OPTS);
    expect(r.outcome).toBe("MATCHED");
    expect(r.comparisons.find((c) => c.field === "frCode")!.difference).toBe("not verified");
  });

  it("carton-only mismatch keeps identity intact (right booking, wrong cartons → correct on Damco)", () => {
    const r = matchBooking(excelExtraction(), { ...rightBooking, cartons: "18" }, OPTS);
    expect(r.outcome).toBe("MISMATCH");
    const identityOk = r.comparisons.filter((c) => ["poNumber", "sku", "shipper", "frCode"].includes(c.field)).every((c) => c.match);
    expect(identityOk).toBe(true); // so live-run flags it for carton correction, not a wrong-booking
  });
});
