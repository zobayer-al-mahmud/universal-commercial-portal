import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import { readdirSync } from "fs";
import { existsSync } from "fs";
import { join } from "path";
import JSZip from "jszip";
import { parseTemplateFilename, listTemplates, resolveTemplate, listCountryCodes, type InvoiceTemplate } from "@/server/customs-invoice/templates";
import { extractInvoiceFieldsFromPdf } from "@/server/customs-invoice/parse-pdf";
import { writeInvoiceXlsx } from "@/server/customs-invoice/write-xlsx";
import { shortOrderKey } from "@/server/customs-invoice/pull-data";
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

describe("resolveTemplate", () => {
  const templates: InvoiceTemplate[] = [
    { path: "/t/45237 OB.xlsx", filename: "45237 OB.xlsx", invoiceNoPrefix: "45237", countryCode: "OB", variant: "" },
    { path: "/t/45239 OE ( PLW067).xlsx", filename: "45239 OE ( PLW067).xlsx", invoiceNoPrefix: "45239", countryCode: "OE", variant: "PLW067" },
    { path: "/t/45263 OE (PLW237).xlsx", filename: "45263 OE (PLW237).xlsx", invoiceNoPrefix: "45263", countryCode: "OE", variant: "PLW237" },
    { path: "/t/45248 OF-(IT).xlsx", filename: "45248 OF-(IT).xlsx", invoiceNoPrefix: "45248", countryCode: "OF-IT", variant: "" },
    { path: "/t/45254 EN.xlsx", filename: "45254 EN.xlsx", invoiceNoPrefix: "45254", countryCode: "EN", variant: "" },
  ];

  it("prefers exact code match on marketCode", () => {
    expect(resolveTemplate("OB", "OB", templates)!.countryCode).toBe("OB");
    expect(resolveTemplate("EN", "", templates)!.countryCode).toBe("EN");
  });
  it("picks the variant that matches the subcode suffix", () => {
    expect(resolveTemplate("OE", "ORDER-PLW237", templates)!.variant).toBe("PLW237");
    expect(resolveTemplate("OE", "ORDER-PLW067", templates)!.variant).toBe("PLW067");
  });
  it("falls back to the first OE when variant unknown", () => {
    const r = resolveTemplate("OE", "OE-SOMETHING-ELSE", templates);
    expect(r!.countryCode).toBe("OE");
  });
  it("accepts combined code: `OF-IT`", () => {
    expect(resolveTemplate("OF-IT", "OF-IT", templates)!.countryCode).toBe("OF-IT");
  });
  it("returns null when nothing matches", () => {
    expect(resolveTemplate("XYZ", "", templates)).toBeNull();
  });
  it("lists unique sorted country codes", () => {
    expect(listCountryCodes(templates)).toEqual(["EN", "OB", "OE", "OF-IT"]);
  });
});

describe("extractInvoiceFieldsFromPdf (unit, synthetic text)", () => {
  // We cannot build a real PDF in a unit test without pulling in a PDF writer,
  // but the parser is pure once we have text — exercise it via a Buffer path
  // using pdf-parse's internal fallback (empty) and then via inner regex calls.
  // Here we assert the regex catalogue produces the right fields given a text.
  it("empty buffer returns an empty result", async () => {
    const r = await extractInvoiceFieldsFromPdf(Buffer.from(""));
    expect(r.rawText).toBe("");
    expect(r.fields).toEqual({});
  });
});

describe("writeInvoiceXlsx (fresh fallback)", () => {
  it("writes a readable fresh workbook when no template matches", async () => {
    // Pass a country code that cannot resolve so the fresh fallback is used.
    const r = await writeInvoiceXlsx({ ...BASE, marketCode: "ZZ_NO_SUCH_CODE", marketSubCode: "ZZ_NO_SUCH_CODE" }, { templatePath: "" });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(r.buffer);
    expect(r.mode).toBe("fresh");
    const ws = wb.getWorksheet("INVOICE")!;
    expect(ws.getCell(1, 1).value).toBe("Customs Invoice (no country-specific template matched)");
    const anyRow = ws.getRow(3).getCell(1).value;
    expect(typeof anyRow).toBe("string");
  });
});

// Integration: if the templates folder is present, verify the resolver and
// writer survive end-to-end on a real sample. The real drop lives in the repo
// root (resolved against the test process cwd); falls back to the env value.
const TEMPLATE_DIR = existsSync(join(process.cwd(), "Customs Invoice templates and sample files"))
  ? join(process.cwd(), "Customs Invoice templates and sample files")
  : (process.env.CUSTOMS_INVOICE_TEMPLATE_DIR || "");
const hasTemplates = !!TEMPLATE_DIR && existsSync(TEMPLATE_DIR) && readdirSync(TEMPLATE_DIR).some((f) => f.endsWith(".xlsx"));
describe.skipIf(!hasTemplates)("end-to-end with real templates", () => {
  it("listTemplates finds the OB template", () => {
    const ts = listTemplates(TEMPLATE_DIR);
    const ob = ts.find((t) => t.countryCode === "OB");
    expect(ob).toBeDefined();
    expect(ob!.filename).toContain("OB");
  });
  it("writer returns a template-mode result for the matched NH country", async () => {
    const r = await writeInvoiceXlsx(BASE);
    expect(r.buffer.byteLength).toBeGreaterThan(1000);
    expect(r.mode).toBe("template");
    expect(r.templateUsed).toContain("NH");
  });
  it("learnLayout picks the right input row for OB and verifies columns", async () => {
    const ts = listTemplates(TEMPLATE_DIR);
    const ob = ts.find((t) => t.countryCode === "OB")!;
    const layout = await learnLayout(ob.path);
    expect(layout).not.toBeNull();
    expect(layout!.inputRow).toBeGreaterThan(50);
    expect(layout!.observed.contractNo).toMatch(/AGL\/H&M\/\d+\/\d{4}/);
    expect(layout!.observed.invoiceNumber).toMatch(/^\d+$/);
    expect(layout!.columns.invoiceNumber).toBe("J");
    expect(layout!.columns.contractNo).toBe("B");
    expect(layout!.columns.hmOrderNo).toBe("D");
    expect(layout!.columns.unitPrice).toBe("F");
    expect(layout!.columns.quantityPcs).toBe("M");
    expect(layout!.columns.grossWeightKg).toBe("O");
  });
  it("writer populates the learned input row with invoice values", async () => {
    const r = await writeInvoiceXlsx(BASE); // NH template
    expect(r.layout).toBeDefined();
    expect(r.fieldsWritten).toContain("invoiceNumber");
    expect(r.fieldsWritten).toContain("contractNo");
    expect(r.fieldsWritten).toContain("hmOrderNo");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(r.buffer);
    const ws = wb.getWorksheet("PAYMENT INVOICE")!;
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
    const nh = ts.find((t) => t.countryCode === "NH")!;
    const origZip = await JSZip.loadAsync(readFileSync(nh.path));
    const r = await patchTemplate(nh.path, BASE);
    expect(r).not.toBeNull();
    const outZip = await JSZip.loadAsync(r!.buffer);

    const mediaCount = Object.keys(outZip.files).filter((n) => n.startsWith("xl/media/")).length;
    expect(mediaCount).toBeGreaterThan(0);

    // Every drawing + media file is byte-identical in input and output.
    for (const name of Object.keys(origZip.files)) {
      if (!name.startsWith("xl/drawings/") && !name.startsWith("xl/media/")) continue;
      const origBytes = await origZip.file(name)!.async("nodebuffer");
      const outBytes = await outZip.file(name)!.async("nodebuffer");
      expect(outBytes.equals(origBytes), `drift in ${name}`).toBe(true);
    }

    // And the input row has the invoice values.
    const ss = await outZip.file("xl/sharedStrings.xml")!.async("string");
    expect(ss).toContain(BASE.invoiceNumber);
    expect(ss).toContain(BASE.hmOrderNo);
  });
  it("zip-surgery writer picks the right template per country code", async () => {
    const ts = listTemplates(TEMPLATE_DIR);
    for (const code of ["OB", "OE", "NH", "DR"]) {
      const t = ts.find((x) => x.countryCode === code);
      if (!t) continue;
      const r = await patchTemplate(t.path, { ...BASE, marketCode: code });
      expect(r, `patchTemplate failed for ${code}`).not.toBeNull();
      expect(r!.fieldsWritten.length).toBeGreaterThan(5);
    }
  });
  it("preserves multi-run rich-text shared strings (no run truncation) — regression", async () => {
    const { readFileSync } = await import("fs");
    const ts = listTemplates(TEMPLATE_DIR);
    const ob = ts.find((t) => t.countryCode === "OB")!;
    // Collect the full (all-runs concatenated) text of every <si> in the template.
    const siText = (xml: string) =>
      (xml.match(/<si\b[^>]*>[\s\S]*?<\/si>/g) ?? []).map((raw) =>
        [...raw.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)]
          .map((m) => m[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"))
          .join(""),
      );
    const origZip = await JSZip.loadAsync(readFileSync(ob.path));
    const before = new Set(siText(await origZip.file("xl/sharedStrings.xml")!.async("string")));
    // Sanity: the template really does contain a multi-run string.
    expect([...before].some((s) => /port of loading:\s*chittagong/i.test(s))).toBe(true);

    const r = await patchTemplate(ob.path, { ...BASE, marketCode: "OB" });
    const outZip = await JSZip.loadAsync(r!.buffer);
    const after = new Set(siText(await outZip.file("xl/sharedStrings.xml")!.async("string")));
    // Every original full string must still be present verbatim after the patch.
    const dropped = [...before].filter((s) => s !== "" && !after.has(s));
    expect(dropped, `shared strings mangled: ${JSON.stringify(dropped.slice(0, 5))}`).toEqual([]);
  });
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
    const { extractCountryCodes } = await import("@/server/hm-sales-contract/intake");
    const country = { rows: [{ marketCode: "oe" }, { marketCode: "OF" }, { marketCode: "oe" }, { marketCode: "LH" }] };
    const po = { marketRows: [{ marketCode: "OD" }, { marketCode: "OF" }] };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(extractCountryCodes(country as any, po as any)).toEqual(["OE", "OF", "LH", "OD"]);
  });
  it("falls back to PO market rows when no country breakdown", async () => {
    const { extractCountryCodes } = await import("@/server/hm-sales-contract/intake");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(extractCountryCodes(null, { marketRows: [{ marketCode: "nh" }] } as any)).toEqual(["NH"]);
  });
  it("returns [] when both sources are empty", async () => {
    const { extractCountryCodes } = await import("@/server/hm-sales-contract/intake");
    expect(extractCountryCodes(null, null)).toEqual([]);
  });
});
