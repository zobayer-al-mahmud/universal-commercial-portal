import { describe, it, expect } from "vitest";
import { extractFields, extractCustom, toFileStem } from "@/server/pdf-rename/fields";
import type { PageText } from "@/server/pdf-rename/validate";

const textPage = (text: string, page = 1): PageText => ({ page, text, method: "text" });
const ocrPage = (text: string, confidence: number, page = 1): PageText => ({ page, text, method: "ocr", ocrConfidence: confidence });

// A faithful excerpt of the real FCR text (FCR EXTRACT & RENAME/64408.pdf).
const FCR_TEXT = `ANANTA GARMENTS LIMITED CTG3320724
CHITTAGONG 25 SEP., 2026
Order No : ORDER NO : 685029-1939
Size : S/C NO : AGL/H&M/98/2025
No.Of Pcs : INV NO : 64408TW
In Crtn INV DT : 13-09-2026
Crtn No : EXP NO : 1558-21129-2026
Crtn Msrmnt EXP DT : 13-09-2026
: HS CODE : 620462
Container No :
CONTAINER NO.
CSNU2397962`;

describe("extractFields — FCR document", () => {
  const f = extractFields([textPage(FCR_TEXT)]);

  it("reads the FCR / receipt number (CTG token)", () => {
    expect(f.fcr.value).toBe("CTG3320724");
    expect(f.fcr.confidence).toBeGreaterThan(0.8);
    expect(f.fcr.source).toBe("text");
  });

  it("reads the ISO 6346 container number near the CONTAINER NO label", () => {
    expect(f.container.value).toBe("CSNU2397962");
    expect(f.container.confidence).toBeGreaterThan(0.9); // labelled + ISO category U
  });

  it("reads the EXP number from the 'EXP NO :' label (not EXP DT)", () => {
    expect(f.exp.value).toBe("1558-21129-2026");
    expect(f.exp.confidence).toBeGreaterThan(0.9);
  });
});

describe("extractFields — fail closed (never invent)", () => {
  it("returns nulls when no credible token is present", () => {
    const f = extractFields([textPage("A plain shipping note with no FCR, container or EXP fields.")]);
    expect(f.fcr.value).toBeNull();
    expect(f.container.value).toBeNull();
    expect(f.exp.value).toBeNull();
  });

  it("does not treat the EXP DATE as the EXP number", () => {
    const f = extractFields([textPage("EXP DT : 13-09-2026\nHS CODE : 620462")]);
    expect(f.exp.value).toBeNull();
  });

  it("does not match a date or money as a container number", () => {
    const f = extractFields([textPage("Total 6,757.92 USD on 05.10.2026")]);
    expect(f.container.value).toBeNull();
  });
});

describe("extractFields — container ISO category weighting", () => {
  it("prefers a labelled container over a stray 4-letter+7-digit token", () => {
    const f = extractFields([textPage("REF ABCD1234567 somewhere\nCONTAINER NO. MIEU4019121")]);
    expect(f.container.value).toBe("MIEU4019121");
  });

  it("still reads a valid ISO token (U/J/Z category) without a label", () => {
    const f = extractFields([textPage("Equipment MRSU8529321 loaded")]);
    expect(f.container.value).toBe("MRSU8529321");
    expect(f.container.confidence).toBeGreaterThan(0.7);
  });
});

describe("extractFields — OCR confidence scaling", () => {
  it("scales confidence down on a low-confidence OCR page", () => {
    const hi = extractFields([textPage(FCR_TEXT)]).fcr.confidence;
    const lo = extractFields([ocrPage(FCR_TEXT, 0.5)]).fcr.confidence;
    expect(lo).toBeLessThan(hi);
    expect(lo).toBeGreaterThan(0);
  });
});

describe("extractCustom — generic label:value", () => {
  it("extracts the value following a user-typed label", () => {
    const v = extractCustom([textPage("HS CODE : 620462\nORDER NO : 685029-1939")], "HS CODE");
    expect(v.value).toBe("620462");
  });

  it("supports multi-word labels with flexible spacing", () => {
    const v = extractCustom([textPage("ORDER   NO : 685029-1939")], "Order No");
    expect(v.value).toBe("685029-1939");
  });

  it("returns null when the label is absent", () => {
    expect(extractCustom([textPage("nothing here")], "Booking Ref").value).toBeNull();
  });

  it("is only added to the result when a label is requested", () => {
    expect(extractFields([textPage(FCR_TEXT)]).custom).toBeUndefined();
    expect(extractFields([textPage(FCR_TEXT)], { customLabel: "HS CODE" }).custom?.value).toBe("620462");
  });
});

describe("toFileStem", () => {
  it("strips illegal filename characters and a .pdf suffix", () => {
    expect(toFileStem("CTG3320724.pdf")).toBe("CTG3320724");
    expect(toFileStem("1558-21129-2026")).toBe("1558-21129-2026");
    expect(toFileStem("a/b:c*?.pdf")).toBe("abc");
    expect(toFileStem(null)).toBe("");
  });
});
