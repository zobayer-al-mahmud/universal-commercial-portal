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
