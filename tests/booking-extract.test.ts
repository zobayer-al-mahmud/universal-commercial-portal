import { describe, it, expect } from "vitest";
import { extractBookingData, normalizeNumber, applyManualCorrections, parseFilenameStem } from "@/server/booking-correction/extract";

// Sanitised excerpt mirroring the real H&M packing-list text layout, where the
// carton and quantity totals are concatenated ("Total7114" = 7 ctns / 114 pcs)
// and the detail region has 7 carton dimension rows.
const HM_TEXT = `Packing list
Order/Season/PM/Delivery no: 698757/4-2026/VN/1Packing list no: 88864
Final receiver
VNW221
Total weight (kg)
Net:82.75
Gross:88.61
Ctns/ColQty/Col
SolidAsst
Mixed1Pcs incl. in totals
Total7114
Items/Ctn
SC5c 54*35*25 1
SC5d 54*35*20 2
SC5b 54*35*30 3
SC5c 54*35*25 4
SC5b 54*35*30 5
SC5d 54*35*20 6
SC5c 54*35*25 7
Solid qty/Article
`;

const GENERIC_TEXT = `PACKING LIST
PO Number: 613625
Country of Origin: PE
Gross Weight: 219.50 kg
Total Cartons: 15
Total Quantity: 263`;

describe("normalizeNumber", () => {
  it("handles thousands separators and decimals", () => {
    expect(normalizeNumber("1,234")).toBe("1234");
    expect(normalizeNumber("1,234.56")).toBe("1234.56");
    expect(normalizeNumber("1.234,56")).toBe("1234.56");
    expect(normalizeNumber("88.61 kg")).toBe("88.61");
    expect(normalizeNumber("")).toBe("");
  });
});

describe("parseFilenameStem", () => {
  it("parses '<po> <country> <marketcode>'", () => {
    expect(parseFilenameStem("698757 VN VNW221.pdf")).toEqual({ po: "698757", country: "VN", marketCode: "VNW221" });
  });
});

describe("extractBookingData — H&M packing list", () => {
  const r = extractBookingData({ text: HM_TEXT, filename: "698757 VN VNW221.pdf" });

  it("extracts PO, country, market code and gross weight confidently", () => {
    expect(r.poNumber).toBe("698757");
    expect(r.countryCode).toBe("VN");
    expect(r.marketCode).toBe("VNW221");
    expect(r.grossWeight?.normalized).toBe("88.61");
    expect(r.grossWeight!.confidence).toBeGreaterThan(0.9);
  });

  it("splits the concatenated carton/qty total but flags it for review", () => {
    expect(r.cartons?.normalized).toBe("7");
    expect(r.quantity?.normalized).toBe("114");
    expect(r.reviewReasons.some((x) => x.code === "CARTON_QTY_AMBIGUOUS")).toBe(true);
  });
});

describe("extractBookingData — generic labels", () => {
  it("extracts all three values confidently and is complete", () => {
    const r = extractBookingData({ text: GENERIC_TEXT });
    expect(r.poNumber).toBe("613625");
    expect(r.countryCode).toBe("PE");
    expect(r.grossWeight?.normalized).toBe("219.5");
    expect(r.cartons?.normalized).toBe("15");
    expect(r.quantity?.normalized).toBe("263");
    expect(r.complete).toBe(true);
  });
});

describe("extractBookingData — missing / scanned", () => {
  it("marks missing fields for review and is not complete", () => {
    const r = extractBookingData({ text: "some unrelated text with no totals" });
    expect(r.complete).toBe(false);
    expect(r.reviewReasons.some((x) => x.code === "GROSS_WEIGHT_MISSING")).toBe(true);
  });

  it("flags a scanned (empty-text) PDF as needing OCR", () => {
    const r = extractBookingData({ text: "   " });
    expect(r.reviewReasons.some((x) => x.code === "SCANNED_PDF_OCR_REQUIRED")).toBe(true);
  });
});

describe("applyManualCorrections", () => {
  it("overlays reviewer values, resolves review reasons and completes", () => {
    const base = extractBookingData({ text: HM_TEXT, filename: "698757 VN VNW221.pdf" });
    const fixed = applyManualCorrections(base, { cartons: "7", quantity: "114" });
    expect(fixed.cartons?.confidence).toBe(1);
    expect(fixed.reviewReasons.some((x) => x.code === "CARTON_QTY_AMBIGUOUS")).toBe(false);
    expect(fixed.complete).toBe(true);
  });
});
