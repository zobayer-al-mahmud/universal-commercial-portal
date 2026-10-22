import type { InvoiceFields } from "./types";

// Mirror booking-correction's serialised pdf-parse pattern: pdf-parse's embedded
// pdf.js keeps module-level state and can corrupt under concurrency, so chain
// every parse through one promise and retry once on failure.
let pdfParseChain: Promise<unknown> = Promise.resolve();

async function parsePdf(buffer: Buffer): Promise<{ text: string; numpages: number }> {
  const run = async () => {
    const pdfParse = (await import("pdf-parse/lib/pdf-parse.js")).default;
    try {
      const d = await pdfParse(buffer);
      return { text: d.text ?? "", numpages: d.numpages ?? 1 };
    } catch {
      const d = await pdfParse(buffer);
      return { text: d.text ?? "", numpages: d.numpages ?? 1 };
    }
  };
  const result = pdfParseChain.then(run, run);
  pdfParseChain = result.then(() => undefined, () => undefined);
  return result;
}

export interface InvoicePdfExtract {
  rawText: string;
  numPages: number;
  fields: Partial<InvoiceFields>;
  foundLabels: string[]; // human-readable list of what matched
}

/** Trim pdf-parse's typical runs of whitespace and NBSPs. */
function tidy(s: string): string {
  return s.replace(/ /g, " ").replace(/[ \t]+/g, " ").replace(/\s+\n/g, "\n").trim();
}

/** Find the first value for any of the supplied regexes. Returns `""` on miss. */
function pick(text: string, patterns: RegExp[]): string {
  for (const re of patterns) {
    const m = text.match(re);
    if (m && m[1]) return m[1].trim();
  }
  return "";
}

function pickNum(text: string, patterns: RegExp[]): number | null {
  const s = pick(text, patterns);
  if (!s) return null;
  const n = Number.parseFloat(s.replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function pickInt(text: string, patterns: RegExp[]): number | null {
  const s = pick(text, patterns);
  if (!s) return null;
  const n = Number.parseInt(s.replace(/[^\d-]/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Extract invoice fields from an uploaded invoice-style PDF.
 *
 * The extractor is intentionally pattern-based + conservative: a field only
 * populates when a labelled source line is found. Nothing is invented; a user
 * can always correct afterwards in the form.
 */
export async function extractInvoiceFieldsFromPdf(buffer: Buffer): Promise<InvoicePdfExtract> {
  let rawText = "";
  let numPages = 1;
  try {
    const parsed = await parsePdf(buffer);
    rawText = parsed.text;
    numPages = parsed.numpages;
  } catch {
    return { rawText: "", numPages: 0, fields: {}, foundLabels: [] };
  }

  const text = tidy(rawText);
  const fields: Partial<InvoiceFields> = {};
  const foundLabels: string[] = [];
  const set = <K extends keyof InvoiceFields>(key: K, value: InvoiceFields[K], label: string) => {
    if (value === "" || value === null || value === undefined) return;
    fields[key] = value;
    foundLabels.push(label);
  };

  // --- Simple labelled strings ---
  set("invoiceNumber", pick(text, [
    /Invoice\s*(?:No|Number)\.?\s*[:\-]?\s*([A-Z0-9]+)/i,
    /Number\s*[:\-]?\s*(\d{4,})/i,
  ]), "Invoice No.");

  set("invoiceDate", pick(text, [
    /Invoice\s*Date\s*[:\-]?\s*([0-3]?\d[.\-\/][01]?\d[.\-\/]\d{2,4})/i,
    /Date\s*[:\-]?\s*([0-3]?\d[.\-\/][01]?\d[.\-\/]\d{2,4})/,
  ]), "Invoice date");

  set("contractNo", pick(text, [
    /Contract\s*(?:Ref|No|Number)\.?\s*[:\-]?\s*(AGL\s*\/?\s*H\s*&?\s*M\s*\/?\s*\d{1,4}\s*\/?\s*\d{2,4})/i,
    /(AGL\/H&M\/\d+\/\d{4})/,
  ]).replace(/\s+/g, ""), "Contract No.");

  set("contractDate", pick(text, [
    /Contract(?:\s*Date|.*?Date)\s*[:\-]?\s*([0-3]?\d[.\-\/][01]?\d[.\-\/]\d{2,4})/i,
  ]), "Contract date");

  set("hmOrderNo", pick(text, [
    /H\s*&?\s*M\s*Order\s*No\.?\s*[:\-]?\s*(\d{5,}[\/\-]\d{3,})/i,
    /Order\s*No\.?\s*[:\-]?\s*(\d{5,}[\/\-]\d{3,})/i,
    /(\d{6}\/\d{4})/,
  ]), "H&M Order No.");

  set("expNo", pick(text, [
    /EXP\s*(?:No|Number)\.?\s*[:\-]?\s*(\d{3,})/i,
    /Exp\.?\s*no\.?\s*[:\-]?\s*(\d{3,})/i,
  ]), "EXP No.");

  set("expDate", pick(text, [
    /EXP\s*Date\s*[:\-]?\s*([0-3]?\d[.\-\/][01]?\d[.\-\/]\d{2,4})/i,
  ]), "EXP date");

  set("portOfLoading", pick(text, [
    /Port\s*of\s*Loading\s*[:\-]?\s*([A-Z][A-Za-z ,]{2,40})/i,
  ]), "Port of loading");

  set("portOfDischarge", pick(text, [
    /Port\s*of\s*(?:Discharge|Delivery)\s*[:\-]?\s*([A-Z][A-Za-z ,]{2,40})/i,
  ]), "Port of discharge");

  set("placeOfDelivery", pick(text, [
    /Place\s*of\s*Delivery\s*[:\-]?\s*([A-Z][A-Za-z ,]{2,40})/i,
  ]), "Place of delivery");

  set("countryOfFinalDestination", pick(text, [
    /Country\s*of\s*(?:Final\s*)?Destination\s*[:\-]?\s*([A-Z][A-Z ]{1,40})/i,
    /Final\s*Destination\s*[:\-]?\s*([A-Z][A-Z ]{1,40})/i,
  ]), "Country of final destination");

  set("vesselName", pick(text, [
    /Vessel\s*(?:Name|\/\s*flight\s*no)?\s*[:\-]?\s*([A-Z0-9][A-Z0-9 \-\/]{2,30})/i,
  ]), "Vessel name");

  set("voyageNo", pick(text, [
    /Voyage\s*No\.?\s*[:\-]?\s*([A-Z0-9\-]{2,20})/i,
  ]), "Voyage No.");

  set("sailingDate", pick(text, [
    /Sailing\s*Date\s*[:\-]?\s*([0-3]?\d[.\-\/][01]?\d[.\-\/]\d{2,4})/i,
  ]), "Sailing date");

  set("termsOfDelivery", pick(text, [
    /Terms?\s*of\s*Delivery\s*[:\-]?\s*(FCA[^\n]{0,30}|FOB[^\n]{0,30}|CFR[^\n]{0,30}|CIF[^\n]{0,30})/i,
  ]), "Terms of delivery");

  set("termsOfPayment", pick(text, [
    /Terms?\s*of\s*Payment\s*[:\-]?\s*([^\n]{3,60})/i,
  ]), "Terms of payment");

  set("buyerCode", pick(text, [
    /Buyer\s*Code\s*[:\-]?\s*(AGL\s*\d{2,4}\s*[A-Z]?)/i,
  ]).replace(/\s+/g, " "), "Buyer code");

  set("styleNo", pick(text, [
    /Style\s*No\.?\s*[:\-]?\s*([A-Za-z0-9 \-]{2,60})/i,
  ]), "Style No.");

  set("hsCode", pick(text, [
    /(?:Tariff|Teriff|HS)\s*Code\s*[:\-]?\s*(\d[\d.]{3,20})/i,
  ]), "HS code");

  set("category", pick(text, [
    /Category\s*[:\-]?\s*(\d{1,4})/i,
    /Cat\s*[:\-]?\s*(\d{1,4})/i,
  ]), "Category");

  set("quantityPcs", pickInt(text, [
    /(?:Total\s*)?Quantity\s*[:\-]?\s*(\d[\d,]*)\s*(?:PCS|pcs)?/i,
    /(\d[\d,]*)\s*PCS\b/i,
  ]), "Quantity");

  set("unitPrice", pickNum(text, [
    /Unit\s*Price\s*[:\-]?\s*(?:USD\s*)?(\d+\.\d+)/i,
    /Rate\s*[:\-]?\s*(?:USD\s*)?(\d+\.\d+)/i,
    /FCA\s*\/\s*PCS\s*[:\-]?\s*(\d+\.\d+)/i,
  ]), "Unit price");

  set("totalCartons", pickInt(text, [
    /(?:Total\s*)?Cartons?\s*[:\-]?\s*(\d{1,6})/i,
    /No\.?\s*of\s*Ctns?\s*[:\-]?\s*(\d{1,6})/i,
  ]), "Total cartons");

  set("grossWeightKg", pickNum(text, [
    /Gross\s*Weight\s*(?:\/?\s*Kgs?)?\s*[:\-]?\s*(\d+\.?\d*)/i,
    /Gross\s*Wt\.?\s*[:\-]?\s*(\d+\.?\d*)/i,
  ]), "Gross weight");

  set("netWeightKg", pickNum(text, [
    /Net\s*Weight\s*(?:\/?\s*Kgs?)?\s*[:\-]?\s*(\d+\.?\d*)/i,
    /Net\s*Wt\.?\s*[:\-]?\s*(\d+\.?\d*)/i,
  ]), "Net weight");

  set("measurementCbm", pickNum(text, [
    /Measurement\s*(?:\(?CBM\)?)?\s*[:\-]?\s*(\d+\.?\d*)/i,
    /CBM\s*[:\-]?\s*(\d+\.?\d*)/i,
  ]), "Measurement");

  set("dimension", pick(text, [
    /Dimension\s*[:\-]?\s*([\d]{1,4}\s*[*xX]\s*[\d]{1,4}\s*[*xX]\s*[\d]{1,4}(?:\s*CM)?)/i,
  ]), "Dimension");

  return { rawText, numPages, fields, foundLabels };
}
