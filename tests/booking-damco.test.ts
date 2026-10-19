import { describe, it, expect } from "vitest";
import { mockSearch, selectBooking, buildSearchUrl, type BookingCandidate } from "@/server/integrations/damco-portal";
import type { ExtractionResult, ExtractedValue } from "@/server/booking-correction/batch-types";

function val(n: string): ExtractedValue {
  return { value: n, normalized: n, label: "t", page: 1, confidence: 1 };
}
function ex(po: string, country: string): ExtractionResult {
  return {
    poNumber: po, countryCode: country, marketCode: "", grossWeight: val("88.61"), cartons: val("7"), quantity: val("114"),
    complete: true, confidence: 1, reviewReasons: [], pages: 1, textChars: 100,
  };
}
const COMPANY = "ANANTA GARMENTS LIMITED";
const BUYER = "H&M HENNES & MAURITZ GBC AB";

describe("buildSearchUrl", () => {
  it("appends the PO wildcard and country filter", () => {
    const u = buildSearchUrl("698757", "VN");
    expect(u).toContain("docNumber=698757");
    expect(decodeURIComponent(u)).toContain("698757*");
    expect(decodeURIComponent(u)).toContain("VN*");
  });
});

describe("mockSearch scenarios", () => {
  it("returns a matching confirmed booking for a normal PO", () => {
    const r = mockSearch({ company: COMPANY, buyer: BUYER, extraction: ex("698757", "VN") });
    expect(r.ok).toBe(true);
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].headingStatus).toBe("CONFIRMED");
    expect(r.candidates[0].grossWeight).toBe("88.61");
  });

  it("returns no results for the 'none' fixture PO", () => {
    const r = mockSearch({ company: COMPANY, buyer: BUYER, extraction: ex("729715", "EC") });
    expect(r.ok).toBe(true);
    expect(r.candidates).toHaveLength(0);
  });

  it("returns a REQUESTED booking for the requested fixture", () => {
    const r = mockSearch({ company: COMPANY, buyer: BUYER, extraction: ex("613625", "PE") });
    expect(r.candidates[0].headingStatus).toBe("REQUESTED");
  });

  it("fails when no PO is supplied", () => {
    const r = mockSearch({ company: COMPANY, buyer: BUYER, extraction: ex("", "VN") });
    expect(r.ok).toBe(false);
  });
});

describe("selectBooking", () => {
  const base: BookingCandidate = {
    soNumber: "61000001", company: COMPANY, buyer: BUYER, poNumber: "698757", countryCode: "VN",
    grossWeight: "88.61", cartons: "7", quantity: "114", headingStatus: "CONFIRMED", fieldStatus: "CONFIRMED",
  };

  it("never blindly takes the first result — picks the country + value match", () => {
    const wrong: BookingCandidate = { ...base, soNumber: "61000099", countryCode: "CN", cartons: "99" };
    const r = selectBooking([wrong, base], { company: COMPANY, buyer: BUYER, extraction: ex("698757", "VN") });
    expect(r.booking?.soNumber).toBe("61000001");
    expect(r.ambiguous).toBe(false);
  });

  it("flags ambiguity when multiple candidates are equally plausible", () => {
    const twin: BookingCandidate = { ...base, soNumber: "61000002" };
    const r = selectBooking([base, twin], { company: COMPANY, buyer: BUYER, extraction: ex("698757", "VN") });
    expect(r.ambiguous).toBe(true);
  });

  it("returns no booking when the PO does not match any candidate", () => {
    const r = selectBooking([base], { company: COMPANY, buyer: BUYER, extraction: ex("999999", "VN") });
    expect(r.booking).toBeNull();
  });
});
