import type { RawPoMarketRow } from "./types";
import {
  parsePurchaseOrderText as parseHmPurchaseOrderText,
  parseSizeBreakdownText,
  parseCountryBreakdownText,
} from "@/server/hm-sales-contract";

/**
 * Parsing helpers for the Sales Contract intake.
 *
 * These are text-first, deterministic parsers (SRS §E-04, SC-FR-004). They never
 * perform side effects and never contact UCP. An LLM is never used as an
 * authoritative source for contract data (SRS §E-12).
 */

export const ORDER_NO_RE = /\b(\d{6,7}-\d{3,4})\b/g;

/**
 * Extract OrderNo(s) from an Order Package subject line (BR-SC-19).
 * One email may carry several OrderNos, e.g. "589538-875, 589537-8756".
 */
export function extractOrderNumbers(subject: string): string[] {
  const found = new Set<string>();
  for (const m of subject.matchAll(ORDER_NO_RE)) found.add(m[1]);
  // Also accept bare order numbers joined by "_" in filenames: 645670_645669-7878
  const compound = subject.match(/\b(\d{6,7})_(\d{6,7})-(\d{3,4})\b/g);
  if (compound) {
    for (const c of compound) {
      const mm = c.match(/(\d{6,7})_(\d{6,7})-(\d{3,4})/);
      if (mm) {
        found.add(`${mm[1]}-${mm[3]}`);
        found.add(`${mm[2]}-${mm[3]}`);
      }
    }
  }
  return [...found];
}

export const EXPECTED_PDF_KINDS = [
  { key: "PurchaseOrder", re: /purchaseorder|_p\.pdf$/i },
  { key: "SizePerColourBreakdown", re: /sizepercolour|_s\.pdf$/i },
  { key: "TotalCountryBreakdown", re: /totalcountry|_t\.pdf$/i },
] as const;

/** Enforce the "three expected PDFs per Order" rule (SC-FR-003). */
export function checkAttachments(attachments: string[]): {
  expected: string[];
  present: string[];
  missing: string[];
  ok: boolean;
} {
  const expected = EXPECTED_PDF_KINDS.map((k) => k.key);
  const present: string[] = [];
  for (const kind of EXPECTED_PDF_KINDS) {
    if (attachments.some((a) => kind.re.test(a))) present.push(kind.key);
  }
  const missing = expected.filter((e) => !present.includes(e));
  return { expected, present, missing, ok: missing.length === 0 };
}

/**
 * Classify the kind of H&M-generated PDF a block of extracted text represents.
 * Used by the batch pipeline to avoid pushing a Size / Country breakdown through
 * the Purchase-Order parser (which would legitimately find no PO rows and emit
 * a misleading SCHEMA_DRIFT). Falls back to `"Unknown"` when no header matches.
 */
export type HmDocKind = "PurchaseOrder" | "SizePerColourBreakdown" | "TotalCountryBreakdown" | "Unknown";

export function classifyHmDoc(text: string, filename?: string): HmDocKind {
  const t = text ?? "";
  // Match on the HEADER banner each H&M document prints (pdf-parse flattens
  // the banner on its own line). We check the text first since filenames are
  // user-renamable; the filename is a secondary hint.
  if (/Purchase Order\s*[–-]\s*Online/i.test(t)) return "PurchaseOrder";
  if (/Size\s*\/\s*Colour Breakdown\s*[–-]\s*Online/i.test(t) || /Size\s*\/\s*Colour breakdown/i.test(t)) return "SizePerColourBreakdown";
  if (/Total Country Breakdown\s*[–-]\s*Online/i.test(t) || /Colour\s*\/\s*Country Breakdown/i.test(t)) return "TotalCountryBreakdown";
  if (filename) {
    const n = filename.toLowerCase();
    if (n.includes("purchaseorder")) return "PurchaseOrder";
    if (n.includes("sizepercolourbreakdown") || n.includes("sizepercolor")) return "SizePerColourBreakdown";
    if (n.includes("totalcountrybreakdown")) return "TotalCountryBreakdown";
  }
  return "Unknown";
}

/**
 * Rich per-file extraction summary used by the batch UI so the user can see
 * every field the pipeline read from the PDF — not just the final decision.
 */
export interface PoExtractionSummary {
  kind: HmDocKind;
  // Flat label → value map in deterministic order; blank-source stays "".
  fields: { label: string; value: string }[];
  // Each generated PO row, as it will reach the pipeline.
  rows: RawPoMarketRow[];
  // Totals / cross-document anchors (empty when the PDF does not expose them).
  totals: { label: string; value: string }[];
  // Why this PDF cannot by itself drive the Sales Contract write (e.g.
  // "This PDF is a Size/Colour Breakdown, not a Purchase Order").
  notes: string[];
}

/**
 * Parse a Purchase Order PDF's extracted text into raw per-market rows.
 *
 * The parser supports two Purchase Order layouts:
 *   (a) The NORMALISED pdftotext layout documented in SRS §C.3 where each
 *       market row is a single line:  `<PM-A> (<PM-B>) <qty> <price> <date>`
 *       e.g. `OW (OL-MX) 2000 12.64 09 Jun, 2026`.
 *   (b) The REAL H&M supplier PDF layout observed from pdf-parse output,
 *       where labels and values flatten into two separate ordered blocks and
 *       the per-market table concatenates `<date><PM-A> (<PM-B>)<qty><pct>%`
 *       with no separators (e.g. `29 Jun, 2026OE (OLCEU)3 54487%`). The qty
 *       in this layout carries no price — the Invoice Average Price is read
 *       from a different section. See `src/server/hm-sales-contract/parse-po.ts`
 *       for the full H&M parser; this function delegates to it when the H&M
 *       header banner is present in the text.
 */
export function parsePoText(text: string): RawPoMarketRow[] {
  // Prefer the H&M parser when the text came from a real H&M Purchase Order
  // supplier PDF — the normalised regex below never matches that layout.
  if (/Purchase Order\s*[–-]\s*Online/i.test(text ?? "")) {
    return parseHmPurchaseOrderToRawRows(text);
  }
  return parseNormalisedPoText(text);
}

/** Produce a rich extraction summary from a text payload for the batch UI. */
export function summariseExtraction(text: string, filename?: string): PoExtractionSummary {
  const kind = classifyHmDoc(text, filename);
  if (kind === "PurchaseOrder") return summarisePurchaseOrder(text);
  if (kind === "SizePerColourBreakdown") return summariseSizeBreakdown(text);
  if (kind === "TotalCountryBreakdown") return summariseCountryBreakdown(text);
  return {
    kind: "Unknown",
    fields: [],
    rows: parseNormalisedPoText(text),
    totals: [],
    notes: text.replace(/\s+/g, "").length < 40
      ? ["No text could be read from the PDF (likely scanned)."]
      : ["Document kind not recognised. If this is an H&M document, confirm the header banner wording."],
  };
}

function summarisePurchaseOrder(text: string): PoExtractionSummary {
  const po = parseHmPurchaseOrderText(text);
  const rows = parseHmPurchaseOrderToRawRows(text);
  const fields: PoExtractionSummary["fields"] = [
    ["Order No", po.header.orderNo],
    ["PT Prod No", po.header.ptProdNo ?? ""],
    ["Date of Order", po.header.dateOfOrder ?? ""],
    ["Supplier Code", po.header.supplierCode ?? ""],
    ["Supplier Name", po.header.supplierName ?? ""],
    ["Option No", po.header.optionNo ?? ""],
    ["Development No", po.header.developmentNo ?? ""],
    ["Product No", po.header.productNo ?? ""],
    ["Product Name", po.header.productName ?? ""],
    ["Product Description", po.header.productDescription ?? ""],
    ["Season", po.header.season ?? ""],
    ["Customs Customer Group", po.header.customsCustomerGroup ?? ""],
    ["Type of Construction", po.header.typeOfConstruction ?? ""],
    ["Country of Production", po.countryOfProduction ?? ""],
    ["Country of Delivery", po.countryOfDelivery ?? ""],
    ["Country of Origin", po.countryOfOrigin ?? ""],
    ["Terms of Payment", po.termsOfPayment ?? ""],
    ["Sales Mode", po.salesMode ?? ""],
    ["No of Pieces", po.noOfPieces == null ? "" : String(po.noOfPieces)],
    ["Planning Markets (header)", po.marketsHeaderList ?? ""],
    ["Terms of Delivery (text)", po.termsOfDeliveryText ?? ""],
    ["Invoice Average Price", po.invoiceAveragePrice ? `${po.invoiceAveragePrice} ${po.invoiceCurrency || ""}`.trim() : ""],
    ["Invoice Countries", po.invoiceCountries ?? ""],
  ].map(([label, value]) => ({ label, value: value ?? "" }));
  for (const a of po.articles) {
    fields.push({ label: `Article ${a.articleNo} · H&M Colour Code`, value: a.hmColourCode });
    fields.push({ label: `Article ${a.articleNo} · PT Article Number`, value: a.ptArticleNumber });
    fields.push({ label: `Article ${a.articleNo} · Colour Name`, value: a.colourName });
    fields.push({ label: `Article ${a.articleNo} · Option No (with version)`, value: a.optionNoWithVersion });
    fields.push({ label: `Article ${a.articleNo} · Cost`, value: `${a.cost} ${a.costCurrency}` });
    fields.push({ label: `Article ${a.articleNo} · Qty per Article`, value: String(a.qtyPerArticle) });
  }
  return {
    kind: "PurchaseOrder",
    fields,
    rows,
    totals: [
      { label: "PO Total Quantity", value: String(po.totalQty) },
      { label: "PO Total %", value: po.totalPct == null ? "" : `${po.totalPct}%` },
    ],
    notes: [],
  };
}

function summariseSizeBreakdown(text: string): PoExtractionSummary {
  const size = parseSizeBreakdownText(text);
  const fields: PoExtractionSummary["fields"] = [
    ["Order No", size.header.orderNo],
    ["Product No", size.header.productNo ?? ""],
    ["Product Name", size.header.productName ?? ""],
    ["Supplier Code", size.header.supplierCode ?? ""],
    ["Supplier Name", size.header.supplierName ?? ""],
    ["Option No", size.header.optionNo ?? ""],
    ["Development No", size.header.developmentNo ?? ""],
    ["Season", size.header.season ?? ""],
  ].map(([label, value]) => ({ label, value: value ?? "" }));
  for (const p of size.pages) {
    fields.push({ label: `${p.marketCode} (${p.marketCodeB}) · heading`, value: p.marketHeading });
    fields.push({ label: `${p.marketCode} · Article No`, value: p.articleNo });
    fields.push({ label: `${p.marketCode} · H&M Colour Code`, value: p.hmColourCode });
    fields.push({ label: `${p.marketCode} · Colour Name`, value: p.colourName });
    fields.push({ label: `${p.marketCode} · Variant`, value: p.variant ?? "" });
    for (const [sizeLabel, qty] of Object.entries(p.sizes)) {
      fields.push({ label: `${p.marketCode} · size ${sizeLabel}`, value: String(qty) });
    }
    fields.push({ label: `${p.marketCode} · Market Quantity`, value: String(p.marketQuantity) });
  }
  const marketSum = size.pages.reduce((a, p) => a + p.marketQuantity, 0);
  return {
    kind: "SizePerColourBreakdown",
    fields,
    rows: [],
    totals: [{ label: "Sum of market quantities", value: String(marketSum) }],
    notes: ["This PDF is a Size/Colour Breakdown, not a Purchase Order — a Sales Contract row cannot be drafted from it alone. Upload it alongside the Purchase Order and the Country Breakdown via the H&M Sales Contract workflow at /hm-sales-contract."],
  };
}

function summariseCountryBreakdown(text: string): PoExtractionSummary {
  const country = parseCountryBreakdownText(text);
  const fields: PoExtractionSummary["fields"] = [
    ["Order No", country.header.orderNo],
    ["Product No", country.header.productNo ?? ""],
    ["Product Name", country.header.productName ?? ""],
    ["Supplier Code", country.header.supplierCode ?? ""],
    ["Supplier Name", country.header.supplierName ?? ""],
    ["Option No", country.header.optionNo ?? ""],
    ["Development No", country.header.developmentNo ?? ""],
    ["Season", country.header.season ?? ""],
    ["Articles", country.articles.join(", ")],
  ].map(([label, value]) => ({ label, value: value ?? "" }));
  for (const row of country.rows) {
    for (const [article, qty] of Object.entries(row.articleQuantities)) {
      fields.push({ label: `${row.marketCode} (${row.marketCodeB}) · article ${article}`, value: String(qty) });
    }
    fields.push({ label: `${row.marketCode} · row total`, value: String(row.rowTotal) });
  }
  for (const s of country.sizeTotals) {
    for (let i = 0; i < s.sizes.length; i++) {
      fields.push({ label: `Article ${s.article} · size ${s.sizes[i]} total`, value: String(s.quantities[i]) });
    }
  }
  return {
    kind: "TotalCountryBreakdown",
    fields,
    rows: [],
    totals: [{ label: "Grand total", value: String(country.grandTotal) }],
    notes: ["This PDF is a Total Country Breakdown, not a Purchase Order — a Sales Contract row cannot be drafted from it alone. Upload it alongside the Purchase Order and the Size/Colour Breakdown via the H&M Sales Contract workflow at /hm-sales-contract."],
  };
}

/** Convert the H&M PO extract into the generic RawPoMarketRow shape so the
 *  existing normalize → validate → reconcile pipeline accepts it unchanged. */
function parseHmPurchaseOrderToRawRows(text: string): RawPoMarketRow[] {
  const po = parseHmPurchaseOrderText(text);
  if (!po.header.orderNo || po.marketRows.length === 0) return [];
  const base = {
    orderNo: po.header.orderNo,
    productNo: po.header.productNo ?? undefined,
    productName: po.header.productName ?? undefined,
    productDescription: po.header.productDescription ?? undefined,
    season: po.header.season ?? undefined,
    customsCustomerGroup: po.header.customsCustomerGroup ?? undefined,
    typeOfConstruction: po.header.typeOfConstruction ?? undefined,
    termsOfDelivery: po.termsOfDeliveryText ?? undefined,
    transportBy: po.termsOfDeliveryText ?? undefined,
    dateOfOrder: po.header.dateOfOrder ?? undefined,
    currency: po.invoiceCurrency || "USD",
    noOfPieces: po.noOfPieces == null ? undefined : String(po.noOfPieces),
    invoiceAveragePrice: po.invoiceAveragePrice ? String(po.invoiceAveragePrice) : undefined,
  };
  return po.marketRows.map((m) => ({
    ...base,
    planningMarketA: m.marketCode,
    planningMarketB: `(${m.marketCodeB})`,
    quantity: String(m.quantity),
    timeOfDelivery: m.tod,
  }));
}

function parseNormalisedPoText(text: string): RawPoMarketRow[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const header: Record<string, string> = {};
  const labelRe = /^([A-Za-z /]+?)\s*[:\-]\s*(.+)$/;
  for (const line of lines) {
    const m = line.match(labelRe);
    if (m) {
      const key = m[1].trim().toLowerCase();
      header[key] = m[2].trim();
    }
  }

  // Preserve the raw PO number even when it fails the regex (SRS §H), so the
  // validator can flag INVALID_PO_NUMBER rather than silently dropping the row.
  const rawPo = (header["po number"] || header["order no"] || header["order number"] || "").trim();
  const orderNo = rawPo.match(/\d{6,7}-\d{3,4}/)?.[0] ?? rawPo;

  const base = {
    orderNo,
    productNo: header["article"] || header["product no"],
    productName: header["style name"] || header["style"] || header["product name"],
    productDescription: header["category"] || header["product description"],
    season: header["season"],
    customsCustomerGroup: header["customer group"],
    typeOfConstruction: header["construction"] || header["type of construction"],
    termsOfDelivery: header["terms of delivery"] || header["incoterm"],
    transportBy: header["transport by"] || header["transport"],
    dateOfOrder: header["order date"] || header["date of order"],
    currency: header["currency"],
  };

  // Per-market lines: PM-A (PM-B) qty price date
  const marketRe =
    /^([A-Z]{2})\s*(\([A-Z]{2}-?[A-Z0-9]{2,3}\))\s+(\d[\d,]*)\s+(\d+(?:\.\d+)?)\s+(\d{1,2}\s+[A-Za-z]{3},?\s+\d{4})/;

  const rows: RawPoMarketRow[] = [];
  for (const line of lines) {
    const m = line.match(marketRe);
    if (m) {
      rows.push({
        ...base,
        planningMarketA: m[1],
        planningMarketB: m[2],
        quantity: m[3].replace(/,/g, ""),
        invoiceAveragePrice: m[4],
        timeOfDelivery: m[5],
        noOfPieces: header["no of pieces"] || header["pieces"],
      });
    }
  }
  return rows;
}
