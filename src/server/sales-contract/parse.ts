import type { RawPoMarketRow } from "./types";

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
 * Parse a Purchase Order PDF's extracted text into raw per-market rows.
 *
 * The parser recognises a labelled "key: value" block for the order-level fields
 * and a per-market table where each line is:
 *   <PM-A> (<PM-B>) <qty> <price> <dd Mon, yyyy>
 * e.g.  OW (OL-MX) 2000 12.64 09 Jun, 2026
 *
 * This layout is the normalised pdftotext output described in SRS §C.3.
 * Real H&M PDFs were not present in the source set (only .msg containers), so
 * the regexes are documented and covered by sanitized fixtures in tests/.
 */
export function parsePoText(text: string): RawPoMarketRow[] {
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
