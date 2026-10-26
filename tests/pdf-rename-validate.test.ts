import { describe, it, expect } from "vitest";
import { validateInvoice, collectPageCandidates, type PageText } from "@/server/pdf-rename/validate";

const OPTS = { minConfidence: 0.75 };
const textPage = (text: string, page = 1): PageText => ({ page, text, method: "text" });
const ocrPage = (text: string, confidence: number, page = 1): PageText => ({ page, text, method: "ocr", ocrConfidence: confidence });

describe("validateInvoice — happy paths", () => {
  it("FCR 'INV NO :' preserves the full token (64408TW)", () => {
    const r = validateInvoice([textPage("No.Of Pcs :\nINV NO : 64408TW\nINV DT : 13-09-2026\nORDER NO : 685029-1939")], OPTS);
    expect(r.decision).toBe("RENAME");
    expect(r.invoiceNumber).toBe("64408TW");
    expect(r.numericKey).toBe("64408");
    expect(r.countryToken).toBe("TW");
  });

  it("Bill box-44 yields the leading digits only (65341, not BR/date)", () => {
    const r = validateInvoice([textPage("Description of Goods INV\n65341 BR 05.10.2026\nAGL/H&M/98/2025")], OPTS);
    expect(r.decision).toBe("RENAME");
    expect(r.invoiceNumber).toBe("65341");
  });
});

describe("validateInvoice — PO / exclusion safety", () => {
  it("never treats a PO/Order number as an invoice", () => {
    const r = validateInvoice([textPage("ORDER NO : 685029-1939\nS/C NO : AGL/H&M/98/2025\nEXP NO : 1558-21129-2026")], OPTS);
    expect(r.decision).toBe("REVIEW");
    expect(r.reasonCode).toBe("POSSIBLE_PO_NUMBER");
    expect(r.invoiceNumber).toBeNull();
  });

  it("does not collect a bare number with no invoice label", () => {
    expect(collectPageCandidates(textPage("Total declaration 162034300 6,757.92 USD"))).toHaveLength(0);
  });

  it("INVOICE_NUMBER_NOT_FOUND when nothing is labelled", () => {
    const r = validateInvoice([textPage("Some shipping document with no invoice field at all.")], OPTS);
    expect(r.reasonCode).toBe("INVOICE_NUMBER_NOT_FOUND");
  });
});

describe("validateInvoice — conflicts & ambiguity", () => {
  it("MULTIPLE_INVOICE_CANDIDATES when two strong distinct invoices appear", () => {
    const r = validateInvoice([textPage("INV NO : 64408TW", 1), textPage("INV NO : 70000AB", 2)], OPTS);
    expect(r.reasonCode).toBe("MULTIPLE_INVOICE_CANDIDATES");
  });

  it("TEXT_OCR_CONFLICT when native text and OCR disagree", () => {
    const r = validateInvoice([textPage("INV NO : 64408TW"), ocrPage("INV NO : 99999XX", 0.9)], OPTS);
    expect(r.reasonCode).toBe("TEXT_OCR_CONFLICT");
  });

  it("OCR_LOW_CONFIDENCE when the only candidate is a weak OCR read", () => {
    const r = validateInvoice([ocrPage("65341 BR 05.10.2026", 0.5)], OPTS);
    expect(r.decision).toBe("REVIEW");
    expect(r.reasonCode).toBe("OCR_LOW_CONFIDENCE");
  });

  it("text + OCR AGREEING boosts to a confident rename (source=both)", () => {
    const r = validateInvoice([textPage("INV NO : 64408TW"), ocrPage("INV NO : 64408TW", 0.8)], OPTS);
    expect(r.decision).toBe("RENAME");
    expect(r.invoiceNumber).toBe("64408TW");
    expect(r.source).toBe("both");
  });
});
