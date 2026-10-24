import { describe, it, expect } from "vitest";
import { detectDocType, extractInvoice } from "@/server/pdf-rename/invoice-rules";

/**
 * Text snippets below are copied from the REAL documents in the three dedicated
 * folders under "PDF File Rename/" (trimmed to the invoice-bearing lines), so
 * the tests pin the rules to the actual layouts, not invented ones.
 */

const FCR_TEXT = `
 CONSIGNEE
 ANANTA GARMENTS LIMITED
 TW-TWW155                               Trousers Women Woven
 Order No :                              ORDER NO : 685029-1939
 Size :                                  S/C NO : AGL/H&M/98/2025
 Colour :                                S/C DT : 18-12-2025
 No.Of Pcs :                             INV NO : 64408TW
 In Crtn                                 INV DT : 13-09-2026
                                         EXP NO : 1558-21129-2026
`;

const BILL_TEXT = `
 BILL OF ENTRY / EXPORT
 2 Consignor/Exporter
 Ananta Garments Ltd.
 H&M Hennes & Mauritz Brazil Importacoes Ltda
 44 Add. info
 65341 BR 05.10.2026
 1.0000
`;

const BILL_SLASH = `BILL OF ENTRY / EXPORT\n65402 BE/IT 05.10.2026\n`;
const BILL_MARKET = `BILL OF ENTRY / EXPORT\n65456 DE-PLW519 05.10.2026\n`;
const BILL_OCR_NOISE = `{mv 61753 KS 10.08.2026 i 34,894.75\nOFFICE OF DISPATCH/EXPORT`;

describe("detectDocType", () => {
  it("classifies an FCR by its 'INV NO :' label", () => {
    expect(detectDocType(FCR_TEXT)).toBe("fcr");
  });
  it("classifies a customs Bill of Export", () => {
    expect(detectDocType(BILL_TEXT)).toBe("bill-of-export");
  });
  it("returns unknown for unrelated text", () => {
    expect(detectDocType("hello world, nothing commercial here")).toBe("unknown");
  });
});

describe("extractInvoice — FCR", () => {
  it("reads the numeric key from 'INV NO : 64408TW' and keeps the country suffix", () => {
    const r = extractInvoice(FCR_TEXT);
    expect(r.docType).toBe("fcr");
    expect(r.invoiceNumber).toBe("64408");
    expect(r.raw).toBe("64408TW");
    expect(r.countryToken).toBe("TW");
    expect(r.method).toBe("text-fcr");
  });
});

describe("extractInvoice — Bill of Export box 44", () => {
  it("reads '<invoice> <country> <date>'", () => {
    const r = extractInvoice(BILL_TEXT);
    expect(r.docType).toBe("bill-of-export");
    expect(r.invoiceNumber).toBe("65341");
    expect(r.countryToken).toBe("BR");
    expect(r.method).toBe("text-bill");
  });
  it("handles a slash-joined country token (BE/IT)", () => {
    expect(extractInvoice(BILL_SLASH).invoiceNumber).toBe("65402");
  });
  it("handles a market-code token with a dash (DE-PLW519)", () => {
    expect(extractInvoice(BILL_MARKET).invoiceNumber).toBe("65456");
  });
  it("recovers the invoice from noisy OCR text", () => {
    const r = extractInvoice(BILL_OCR_NOISE);
    expect(r.invoiceNumber).toBe("61753");
    expect(r.countryToken).toBe("KS");
  });
});

describe("extractInvoice — never invents", () => {
  it("returns null when no invoice token is present", () => {
    const r = extractInvoice("BILL OF ENTRY / EXPORT but the box-44 line is unreadable");
    expect(r.invoiceNumber).toBeNull();
    expect(r.method).toBe("none");
  });
  it("does not treat the dash-dated FCR order/exp numbers as a bill invoice", () => {
    // FCR dates use dashes (13-09-2026), so the dotted box-44 rule must not fire.
    const r = extractInvoice(FCR_TEXT);
    expect(r.method).toBe("text-fcr");
    expect(r.invoiceNumber).toBe("64408");
  });
});
