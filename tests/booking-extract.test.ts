import { describe, it, expect } from "vitest";
import { extractBookingData, normalizeNumber, applyManualCorrections, parseFilenameStem, parseCtnsQtyTable } from "@/server/booking-correction/extract";

// Sanitised excerpt mirroring the real H&M packing-list text layout. The
// "Ctns/Col | Qty/Col" table's total row concatenates both totals in the
// extracted text ("Total7114" = 7 cartons / 114 pcs); the quantity (114) is the
// numeric suffix shared with the article row "004046114".
const HM_TEXT = `Packing list
Order/Season/PM/Delivery no: 698757/4-2026/VN/1Packing list no: 88864
Final receiver
VNW221
Total weight (kg)
Net:82.75
Gross:88.61
Ctns/ColQty/Col
SolidAsst
004046114
Mixed1Pcs incl. in totals
Total7114
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

  it("resolves the concatenated carton/qty total confidently (no review flag)", () => {
    expect(r.cartons?.normalized).toBe("7");
    expect(r.quantity?.normalized).toBe("114");
    expect(r.cartons!.confidence).toBeGreaterThanOrEqual(0.9);
    expect(r.reviewReasons.some((x) => x.code === "CARTON_QTY_AMBIGUOUS")).toBe(false);
    expect(r.complete).toBe(true);
  });
});

describe("parseCtnsQtyTable — real H&M total rows", () => {
  const mk = (article: string, total: string) =>
    `Ctns/ColQty/Col\nSolidAsst\n${article}\nMixed1Pcs incl. in totals\nTotal${total}\n`;
  const cases: [string, string, string, string, string][] = [
    // label, article row, total row, expected cartons, expected quantity
    ["614275 sample (Solid 5 + Asst 1)", "001015151", "6151", "6", "151"],
    ["613625", "0040414263", "15263", "15", "263"],
    ["698757 CN", "0040428581", "29581", "29", "581"],
    ["698757 PH", "004048103", "8103", "8", "103"],
    ["698757 VN", "004046114", "7114", "7", "114"],
    ["729708 EC", "0040715312", "16312", "16", "312"],
    ["729715 EC", "0080814", "114", "1", "14"],
  ];
  for (const [label, article, total, ctn, qty] of cases) {
    it(`splits ${label} → ${ctn} cartons / ${qty} pcs`, () => {
      const t = parseCtnsQtyTable(mk(article, total));
      expect(t).not.toBeNull();
      expect(t!.cartons).toBe(ctn);
      expect(t!.quantity).toBe(qty);
    });
  }
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
