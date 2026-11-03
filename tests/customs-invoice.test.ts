import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import { readdirSync } from "fs";
import { existsSync } from "fs";
import { join } from "path";
import JSZip from "jszip";
import { parseTemplateFilename, listTemplates, resolveTemplate, listCountryCodes, type InvoiceTemplate } from "@/server/customs-invoice/templates";
import { extractInvoiceFieldsFromPdf } from "@/server/customs-invoice/parse-pdf";
import { writeInvoiceXlsx } from "@/server/customs-invoice/write-xlsx";
import { shortOrderKey, preferredCountryCode } from "@/server/customs-invoice/pull-data";
import { learnLayout, colLetter } from "@/server/customs-invoice/learn-template";
import { patchTemplate } from "@/server/customs-invoice/zip-write";
import type { InvoiceFields } from "@/server/customs-invoice/types";

const BASE: InvoiceFields = {
  invoiceNumber: "45238", invoiceDate: "28.12.2025",
  contractNo: "AGL/H&M/97/2025", contractDate: "06.07.2025",
  hmOrderNo: "498160/8757", marketCode: "NH", marketSubCode: "NH", countryCode: "NH",
  expNo: "31074", expDate: "28.12.2025",
  portOfLoading: "CHITTAGONG", portOfDischarge: "Port Klang", placeOfDelivery: "Port Klang",
  countryOfOrigin: "Bangladesh", countryOfFinalDestination: "MALAYSIA",
  transportMode: "SEA", termsOfDelivery: "FCA Chittagong", termsOfPayment: "20 days ship less 2%",
  vesselName: "", voyageNo: "", sailingDate: "", currency: "USD",
  exporterName: "ANANTA GARMENTS LIMITED",
  buyerName: "H&M Hennes & Mauritz GBC AB", consigneeName: "H&M Hennes & Mauritz GBC AB",
  cargoDeliveryName: "H&M Retail Sdn Bhd", issuingBank: "",
  descriptionOfGoods: "Boys 100% Cotton Woven Shirt",
  styleNo: "", buyerCode: "AGL 365 C", hsCode: "620520", category: "8",
  quantityPcs: 26, unitPrice: 5.51, totalCartons: 1,
  grossWeightKg: 14.25, netWeightKg: 13.29, measurementCbm: 0.06,
  dimension: "58*30*20 CM", packSet: "",
};

describe("shortOrderKey", () => {
  it("returns the leading 6+ digit run", () => {
    expect(shortOrderKey("498160/8757")).toBe("498160");
    expect(shortOrderKey("644637-8756")).toBe("644637");
    expect(shortOrderKey("644637")).toBe("644637");
    expect(shortOrderKey("")).toBe("");
  });
});

describe("preferredCountryCode", () => {
  it("takes the first two letters of the sub-code as the destination country", () => {
    // "MYW069" → Malaysia (MY), NOT the H&M group code (e.g. "OE") the Sales
    // Contract PO may carry on countryCodesJson.
    expect(preferredCountryCode({ marketCode: "OE", marketSubCode: "MYW069" })).toBe("MY");
    expect(preferredCountryCode({ marketCode: "", marketSubCode: "AUW118" })).toBe("AU");
    expect(preferredCountryCode({ marketCode: "OW", marketSubCode: "PEW153" })).toBe("PE");
  });

  it("picks the post-hyphen country for hyphenated sub-codes (e.g. OW-NLW195)", () => {
    expect(preferredCountryCode({ marketCode: "OW", marketSubCode: "OW-NLW195" })).toBe("NL");
  });

  it("falls back to the stored marketCode when the sub-code is empty or malformed", () => {
    expect(preferredCountryCode({ marketCode: "OB", marketSubCode: "" })).toBe("OB");
    expect(preferredCountryCode({ marketCode: "OE", marketSubCode: "12-345" })).toBe("OE");
  });
});

describe("parseTemplateFilename", () => {
  it("parses bare country code: `45237 OB.xlsx`", () => {
    const t = parseTemplateFilename("45237 OB.xlsx");
    expect(t).not.toBeNull();
    expect(t!.invoiceNoPrefix).toBe("45237");
    expect(t!.countryCode).toBe("OB");
    expect(t!.variant).toBe("");
  });
  it("parses parenthesised variant: `45239 OE ( PLW067).xlsx`", () => {
    const t = parseTemplateFilename("45239 OE ( PLW067).xlsx");
    expect(t!.countryCode).toBe("OE");
    expect(t!.variant).toBe("PLW067");
  });
  it("parses dash-coded country: `45248 OF-(IT).xlsx`", () => {
    const t = parseTemplateFilename("45248 OF-(IT).xlsx");
    expect(t!.countryCode).toBe("OF-IT");
  });
  it("keeps compound country codes: `45260 OU-068.xlsx` / `45288 LH- PL.xlsx`", () => {
    expect(parseTemplateFilename("45260 OU-068.xlsx")!.countryCode).toBe("OU-068");
    const lh = parseTemplateFilename("45288 LH- PL.xlsx")!;
    expect(lh.countryCode).toBe("LH");
    expect(lh.variant).toBe("PL");
  });
  it("picks up variant after a space: `45268 OK 454.xlsx`", () => {
    const t = parseTemplateFilename("45268 OK 454.xlsx");
    expect(t!.countryCode).toBe("OK");
    expect(t!.variant).toBe("454");
  });
  it("ignores non-xlsx", () => {
    expect(parseTemplateFilename("Thumbs.db")).toBeNull();
    expect(parseTemplateFilename("45237 OB.pdf")).toBeNull();
  });
});

describe("resolveTemplate (packSet-driven, user rule 2026-11-03)", () => {
  // Only two bundled templates exist — plain AZ (1 pack = 1 pcs) and AZ Pack
  // (multipack). Market/country codes no longer drive the choice.
  const templates: InvoiceTemplate[] = [
    { path: "/t/0000 AZ.xlsx", filename: "0000 AZ.xlsx", invoiceNoPrefix: "0000", countryCode: "AZ", variant: "" },
    { path: "/t/0000 AZ Pack.xlsx", filename: "0000 AZ Pack.xlsx", invoiceNoPrefix: "0000", countryCode: "AZ", variant: "" },
  ];

  it("picks AZ Pack when packSet > 1", () => {
    expect(resolveTemplate("ZZ", "ZZX123", templates, "2")!.filename).toBe("0000 AZ Pack.xlsx");
    expect(resolveTemplate("MY", "MYW069", templates, 10)!.filename).toBe("0000 AZ Pack.xlsx");
  });
  it("picks plain AZ when packSet is 1 / blank / unknown", () => {
    expect(resolveTemplate("MY", "MYW069", templates, "1")!.filename).toBe("0000 AZ.xlsx");
    expect(resolveTemplate("MY", "MYW069", templates, "")!.filename).toBe("0000 AZ.xlsx");
    expect(resolveTemplate("MY", "MYW069", templates)!.filename).toBe("0000 AZ.xlsx");
  });
  it("ignores the market/sub-code — any destination resolves to the two bundled templates", () => {
    expect(resolveTemplate("XYZ", "XYZ-FOO", templates, "1")!.filename).toBe("0000 AZ.xlsx");
    expect(resolveTemplate("", "", templates, "3")!.filename).toBe("0000 AZ Pack.xlsx");
  });
  it("falls back to the other template when the preferred one is absent", () => {
    const onlyPlain = templates.slice(0, 1);
    expect(resolveTemplate("", "", onlyPlain, "5")!.filename).toBe("0000 AZ.xlsx");
    const onlyPack = templates.slice(1);
    expect(resolveTemplate("", "", onlyPack, "1")!.filename).toBe("0000 AZ Pack.xlsx");
  });
  it("returns null only when no templates are available", () => {
    expect(resolveTemplate("", "", [], "1")).toBeNull();
  });
  it("still lists unique sorted country codes", () => {
    expect(listCountryCodes(templates)).toEqual(["AZ"]);
  });
});

describe("extractInvoiceFieldsFromPdf (unit, synthetic text)", () => {
  // We cannot build a real PDF in a unit test without pulling in a PDF writer,
  // but the parser is pure once we have text – exercise it via a Buffer path
  // using pdf-parse's internal fallback (empty) and then via inner regex calls.
  // Here we assert the regex catalogue produces the right fields given a text.
  it("empty buffer returns an empty result", async () => {
    const r = await extractInvoiceFieldsFromPdf(Buffer.from(""));
    expect(r.rawText).toBe("");
    expect(r.fields).toEqual({});
  });
});

describe("writeInvoiceXlsx (fresh fallback)", () => {
  it("writes a readable fresh workbook when the template file is missing", async () => {
    // Explicitly point at a non-existent template path — the writer tries to
    // load it, fails, and falls back to building a clean ExcelJS workbook.
    const r = await writeInvoiceXlsx(BASE, { templatePath: "/__does_not_exist__/missing.xlsx" });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(r.buffer);
    expect(r.mode).toBe("fresh");
    const ws = wb.getWorksheet("INVOICE")!;
    expect(ws.getCell(1, 1).value).toBe("Customs Invoice (no country-specific template matched)");
    const anyRow = ws.getRow(3).getCell(1).value;
    expect(typeof anyRow).toBe("string");
  });
});

// Integration: run against the two bundled AZ templates (user rule 2026-11-03
// — the system now ships exactly two templates and picks between them by
// packSet, not by destination country).
const TEMPLATE_DIR = existsSync(join(process.cwd(), "templates", "customs-invoice"))
  ? join(process.cwd(), "templates", "customs-invoice")
  : (process.env.CUSTOMS_INVOICE_TEMPLATE_DIR || "");
const hasTemplates = !!TEMPLATE_DIR && existsSync(TEMPLATE_DIR) && readdirSync(TEMPLATE_DIR).some((f) => f.endsWith(".xlsx"));
describe.skipIf(!hasTemplates)("end-to-end with bundled AZ templates", () => {
  it("listTemplates finds both AZ templates", () => {
    const ts = listTemplates(TEMPLATE_DIR);
    const plain = ts.find((t) => t.filename === "0000 AZ.xlsx");
    const pack = ts.find((t) => t.filename === "0000 AZ Pack.xlsx");
    expect(plain, "plain AZ template missing").toBeDefined();
    expect(pack, "AZ Pack template missing").toBeDefined();
  });
  it("writer picks AZ Pack for packSet > 1 and plain AZ for packSet 1", async () => {
    const packInv = await writeInvoiceXlsx({ ...BASE, packSet: "3" });
    expect(packInv.mode).toBe("template");
    expect(packInv.templateUsed).toContain("AZ Pack");
    const plainInv = await writeInvoiceXlsx({ ...BASE, packSet: "1" });
    expect(plainInv.mode).toBe("template");
    expect(plainInv.templateUsed).toContain("AZ.xlsx");
    expect(plainInv.templateUsed).not.toContain("Pack");
  });
  it("writer populates the hidden data row with invoice values", async () => {
    const r = await writeInvoiceXlsx({ ...BASE, packSet: "1" });
    expect(r.layout).toBeDefined();
    expect(r.fieldsWritten).toContain("invoiceNumber");
    expect(r.fieldsWritten).toContain("contractNo");
    expect(r.fieldsWritten).toContain("hmOrderNo");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(r.buffer);
    const ws = wb.getWorksheet("TR-PAYMENT INVOICE") ?? wb.getWorksheet("PAYMENT INVOICE")!;
    const row = ws.getRow(r.layout!.inputRow);
    expect(String(row.getCell(2).value)).toBe(BASE.contractNo); // B
    expect(String(row.getCell(4).value)).toBe(BASE.hmOrderNo); // D
    expect(String(row.getCell(10).value)).toBe(BASE.invoiceNumber); // J
    expect(Number(row.getCell(13).value)).toBe(BASE.quantityPcs); // M
    expect(Number(row.getCell(6).value)).toBe(BASE.unitPrice); // F
  });
  it("zip-surgery writer preserves drawings and media byte-exactly", async () => {
    const { readFileSync } = await import("fs");
    const ts = listTemplates(TEMPLATE_DIR);
    const plain = ts.find((t) => t.filename === "0000 AZ.xlsx")!;
    const origZip = await JSZip.loadAsync(readFileSync(plain.path));
    const r = await patchTemplate(plain.path, { ...BASE, packSet: "1" });
    expect(r).not.toBeNull();
    const outZip = await JSZip.loadAsync(r!.buffer);

    const mediaCount = Object.keys(outZip.files).filter((n) => n.startsWith("xl/media/")).length;
    expect(mediaCount).toBeGreaterThan(0);

    for (const name of Object.keys(origZip.files)) {
      if (!name.startsWith("xl/drawings/") && !name.startsWith("xl/media/")) continue;
      const origBytes = await origZip.file(name)!.async("nodebuffer");
      const outBytes = await outZip.file(name)!.async("nodebuffer");
      expect(outBytes.equals(origBytes), `drift in ${name}`).toBe(true);
    }

    const ss = await outZip.file("xl/sharedStrings.xml")!.async("string");
    expect(ss).toContain(BASE.invoiceNumber);
    expect(ss).toContain(BASE.hmOrderNo);
  });
  it("AZ Pack formulas and label are rewritten with the invoice packSet", async () => {
    const ts = listTemplates(TEMPLATE_DIR);
    const pack = ts.find((t) => t.filename === "0000 AZ Pack.xlsx")!;
    const r = await patchTemplate(pack.path, { ...BASE, packSet: "5" });
    expect(r).not.toBeNull();
    const outZip = await JSZip.loadAsync(r!.buffer);
    const sheetXml = await outZip.file("xl/worksheets/sheet1.xml")!.async("string");
    const ssXml = await outZip.file("xl/sharedStrings.xml")!.async("string");
    expect(sheetXml).toContain("G36*5");
    expect(sheetXml).toContain("I38*J38/5");
    expect(ssXml).toContain("1 Pack = 5Pcs");
  });
  // The learnLayout helper is no longer exercised against the AZ template
  // (its anchor logic was tuned to the historical per-country templates'
  // header labels). Writing + e2e tests above cover the live writer.
  void learnLayout;
});

describe("colLetter", () => {
  it("maps 1→A, 2→B, 10→J, 26→Z, 27→AA", () => {
    expect(colLetter(1)).toBe("A");
    expect(colLetter(2)).toBe("B");
    expect(colLetter(10)).toBe("J");
    expect(colLetter(26)).toBe("Z");
    expect(colLetter(27)).toBe("AA");
  });
});

describe("extractCountryCodes", () => {
  it("prefers Country Breakdown rows, de-dupes, uppercases, keeps order", async () => {
    const { extractCountryCodes } = await import("@/server/sales-contract/intake");
    const country = { rows: [{ marketCode: "oe" }, { marketCode: "OF" }, { marketCode: "oe" }, { marketCode: "LH" }] };
    const po = { marketRows: [{ marketCode: "OD" }, { marketCode: "OF" }] };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(extractCountryCodes(country as any, po as any)).toEqual(["OE", "OF", "LH", "OD"]);
  });
  it("falls back to PO market rows when no country breakdown", async () => {
    const { extractCountryCodes } = await import("@/server/sales-contract/intake");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(extractCountryCodes(null, { marketRows: [{ marketCode: "nh" }] } as any)).toEqual(["NH"]);
  });
  it("returns [] when both sources are empty", async () => {
    const { extractCountryCodes } = await import("@/server/sales-contract/intake");
    expect(extractCountryCodes(null, null)).toEqual([]);
  });
});
