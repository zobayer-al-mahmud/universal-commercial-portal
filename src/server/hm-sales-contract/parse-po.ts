import type { HmPdfHeader, HmPoArticle, HmPoExtract, HmPoMarketRow } from "./types";

/**
 * Deterministic parser for the H&M Purchase Order PDF text produced by
 * pdf-parse. The real supplier PDF uses a two-column labels-then-values layout,
 * which pdf-parse flattens as: all seven top-row labels, then all seven values,
 * then the next six labels, then the next six values, etc.
 *
 * The market table is emitted as concatenated lines of the form
 *   `<dd Mon, yyyy><PM-A> (<PM-B>)<qty with space separators><pct>%`
 * e.g. `29 Jun, 2026OE (OLCEU)3 54487%`. The qty/pct boundary is ambiguous
 * on small-qty rows (e.g. `2506%` → qty=250, pct=6 OR qty=25, pct=06); the
 * caller resolves it by cross-checking against the Country Breakdown PDF.
 *
 * This parser is pure. It never contacts UCP, never invents values, and never
 * silently alters an extracted source string (SRS §E-04, user spec rule 3).
 */

const TOP_LABELS = [
  "Order No:",
  "PT Prod No:",
  "Date of Order:",
  "Supplier Code:",
  "Supplier Name:",
  "Option No:",
  "Development No:",
] as const;

const MID_LABELS = [
  "Product No:",
  "Product Name:",
  "Product Description:",
  "Season:",
  "Customs Customer Group:",
  "Type of Construction:",
] as const;

const COUNTRY_LABELS = [
  "Country of Production:",
  "Country of Delivery:",
  "Country of Origin:",
  "Terms of Payment:",
] as const;

export function parsePurchaseOrderText(text: string): HmPoExtract {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  const header = extractHeader(lines);
  const countryBlock = extractOrderedValues(lines, [...COUNTRY_LABELS]);
  const salesMode = findValueAfter(lines, "Sales Mode:") ?? null;
  const noOfPiecesRaw = findValueAfter(lines, "No of Pieces:");
  const marketsHeaderList = findValueAfterKey(lines, "Terms of Delivery");
  const termsOfDeliveryText = findLongLineContaining(lines, "FCA according");

  const marketRows = extractMarketRows(lines);
  const total = extractTotalRow(lines);
  const articles = extractArticles(lines);
  const invoice = extractInvoice(lines);

  return {
    kind: "PurchaseOrder",
    header,
    countryOfProduction: countryBlock["Country of Production:"] ?? null,
    countryOfDelivery: countryBlock["Country of Delivery:"] ?? null,
    countryOfOrigin: countryBlock["Country of Origin:"] ?? null,
    termsOfPayment: countryBlock["Terms of Payment:"] ?? null,
    salesMode,
    noOfPieces: toInt(noOfPiecesRaw),
    marketsHeaderList,
    termsOfDeliveryText,
    marketRows,
    totalQty: total.qty,
    totalPct: total.pct,
    articles,
    invoiceAveragePrice: invoice.price,
    invoiceCurrency: invoice.currency,
    invoiceCountries: invoice.countries,
  };
}

/** Extracted shared header; also exposed so parse-size-breakdown and
 *  parse-country-breakdown can reuse the same label/value pairing logic. */
export function extractHeader(lines: string[]): HmPdfHeader {
  const top = extractOrderedValues(lines, [...TOP_LABELS]);
  const mid = extractOrderedValues(lines, [...MID_LABELS]);
  return {
    orderNo: (top["Order No:"] ?? "").trim(),
    ptProdNo: top["PT Prod No:"] ?? null,
    dateOfOrder: top["Date of Order:"] ?? null,
    supplierCode: top["Supplier Code:"] ?? null,   // leading zeros preserved as string
    supplierName: top["Supplier Name:"] ?? null,
    optionNo: top["Option No:"] ?? null,
    developmentNo: top["Development No:"] ?? null, // "0001732C" preserved
    productNo: mid["Product No:"] ?? null,         // "0803160" preserved
    productName: mid["Product Name:"] ?? null,
    productDescription: mid["Product Description:"] ?? null,
    season: mid["Season:"] ?? null,
    customsCustomerGroup: mid["Customs Customer Group:"] ?? null,
    typeOfConstruction: mid["Type of Construction:"] ?? null,
  };
}

/**
 * Find the first run of `labels` (in order) in `lines`, then read the next
 * `labels.length` non-label lines as values in the same order. If any label is
 * missing, the matching value is null.
 *
 * The H&M PDFs happen to repeat the header block on every page; we always use
 * the FIRST occurrence (page 1).
 */
function extractOrderedValues(lines: string[], labels: string[]): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const l of labels) out[l] = null;
  if (labels.length === 0) return out;

  // Locate the first line that equals `labels[0]`, with the next (labels.length-1)
  // non-empty lines being labels[1..n-1] in order.
  let labelStart = -1;
  outer: for (let i = 0; i < lines.length; i++) {
    if (lines[i] !== labels[0]) continue;
    for (let k = 1; k < labels.length; k++) {
      if (lines[i + k] !== labels[k]) continue outer;
    }
    labelStart = i;
    break;
  }
  if (labelStart < 0) return out;

  // Values immediately follow the label block.
  const valueStart = labelStart + labels.length;
  for (let k = 0; k < labels.length; k++) {
    const v = lines[valueStart + k];
    if (v === undefined) break;
    // A new label-looking line means the value is missing for this slot and we
    // bail; this is defensive — in real PDFs the block is always complete.
    if (/^[A-Z][A-Za-z /]+:$/.test(v) && !/^Terms /i.test(v)) break;
    out[labels[k]] = v;
  }
  return out;
}

function findValueAfter(lines: string[], label: string): string | null {
  const i = lines.indexOf(label);
  if (i < 0) return null;
  const v = lines[i + 1];
  return v ?? null;
}

/** For label lines that are not followed immediately by their value (e.g. the
 *  "Terms of Delivery" / "OE, OF, LH, OD" block). Finds the next short-ish line
 *  that is not another label. */
function findValueAfterKey(lines: string[], labelPrefix: string): string | null {
  const i = lines.findIndex((l) => l === labelPrefix || l.startsWith(labelPrefix));
  if (i < 0) return null;
  for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
    const v = lines[j];
    if (/^[A-Z][A-Za-z /]+:$/.test(v)) continue;
    if (/^Transport by/i.test(v)) continue;
    return v;
  }
  return null;
}

function findLongLineContaining(lines: string[], needle: string): string | null {
  const l = lines.find((x) => x.toLowerCase().includes(needle.toLowerCase()));
  return l ?? null;
}

/**
 * `29 Jun, 2026OE (OLCEU)3 54487%` → one HmPoMarketRow.
 *
 * The qty/pct boundary is ambiguous for small qtys (`2506%` → qty=25/pct=06
 * vs qty=250/pct=6). We first capture the prefix (date, market codes) and the
 * raw tail, then enumerate possible (qty, pct) splits per row and pick the
 * combination whose quantity sum equals the PO `Total:` row (which is itself
 * unambiguous: `Total:4 078100%` → 4078). This never silently alters an
 * extracted value — unresolved sets fall back to the first valid split and
 * emit a QTY_MISMATCH warning via the reconciler.
 */
const MARKET_LINE_PREFIX_RE =
  /^(\d{1,2}\s+[A-Za-z]{3,9},?\s+\d{4})([A-Z]{2})\s*\(([A-Z0-9-]+)\)(.+)%$/;

interface SplitCandidate {
  quantity: number;
  quantityRaw: string;
  pct: number | "<1";
}

function enumerateSplits(tail: string): SplitCandidate[] {
  // Tail is "<qty><pct>" where pct is "<1" or 1-2 digits. Try each pct option
  // and emit the candidates whose remaining qty parses as a positive integer.
  const options: SplitCandidate[] = [];

  // Option A: pct = "<1"
  if (tail.endsWith("<1")) {
    const qtyRaw = tail.slice(0, -2);
    const qty = parseIntSpaced(qtyRaw);
    if (qty > 0) options.push({ quantity: qty, quantityRaw: qtyRaw.trim(), pct: "<1" });
  }

  // Option B/C: pct is 1-2 digits.
  for (const w of [2, 1]) {
    if (tail.length < w + 1) continue;
    const pctStr = tail.slice(-w);
    if (!/^\d{1,2}$/.test(pctStr)) continue;
    const qtyRaw = tail.slice(0, -w);
    const qty = parseIntSpaced(qtyRaw);
    if (qty > 0) options.push({ quantity: qty, quantityRaw: qtyRaw.trim(), pct: Number(pctStr) });
  }

  return options;
}

export function extractMarketRows(lines: string[]): HmPoMarketRow[] {
  const rawRows: { tod: string; code: string; codeB: string; tail: string }[] = [];
  for (const line of lines) {
    const m = line.match(MARKET_LINE_PREFIX_RE);
    if (!m) continue;
    rawRows.push({ tod: m[1], code: m[2], codeB: m[3], tail: m[4] });
  }

  const total = extractTotalRow(lines);
  const splitsPerRow = rawRows.map((r) => enumerateSplits(r.tail));

  // Search for a combination whose qty sum equals totalQty AND pct sum is
  // within ±1 of totalPct (allowing for `<1` → treated as 0 or 1).
  const picked = pickCombination(splitsPerRow, total);

  return rawRows.map((r, i) => {
    const choice = picked[i] ?? splitsPerRow[i][0];
    return {
      tod: r.tod,
      marketCode: r.code,
      marketCodeB: r.codeB,
      quantity: choice.quantity,
      quantityRaw: choice.quantityRaw,
      pct: choice.pct,
    };
  });
}

function pickCombination(options: SplitCandidate[][], total: { qty: number; pct: number | null }): SplitCandidate[] | SplitCandidate[] {
  if (options.length === 0) return [];
  const target = total.qty;
  const totalPct = total.pct ?? 100;
  const result: SplitCandidate[] = new Array(options.length);
  const best: { score: number; combo: SplitCandidate[] | null } = { score: Infinity, combo: null };

  const recurse = (i: number, qtySum: number, pctSum: number) => {
    if (i === options.length) {
      const qtyDiff = Math.abs(qtySum - target);
      const pctDiff = Math.abs(pctSum - totalPct);
      // Prefer exact qty match; break ties by pct closeness.
      const score = qtyDiff * 1000 + pctDiff;
      if (score < best.score) {
        best.score = score;
        best.combo = [...result];
      }
      return;
    }
    for (const opt of options[i]) {
      result[i] = opt;
      const pctVal = opt.pct === "<1" ? 0 : opt.pct;
      recurse(i + 1, qtySum + opt.quantity, pctSum + pctVal);
    }
  };
  recurse(0, 0, 0);
  return best.combo ?? options.map((o) => o[0]);
}

/** Extract `Total:4 078100%` → { qty: 4078, pct: 100 }. */
export function extractTotalRow(lines: string[]): { qty: number; pct: number | null } {
  const m = lines.find((l) => /^Total:\s*[\d\s,]+\d+%$/.test(l));
  if (!m) return { qty: 0, pct: null };
  const parts = m.match(/^Total:\s*(.+?)(\d{1,3})%$/);
  if (!parts) return { qty: 0, pct: null };
  return { qty: parseIntSpaced(parts[1]), pct: Number(parts[2]) };
}

/**
 * Qty-per-Article row:
 *   `05175-90103Denim Blue LightSQ0174829 (V1)6.15 USD4 078`
 * We anchor on the `(V1)` / `(Vn)` option-version marker and the trailing
 * currency token, then split outward.
 */
const ARTICLE_LINE_RE =
  /^(\d{3})(\d{2}-\d{3})(\d{2})(.+?)\s*(SQ\d+\s*\(V\d+\))(\d+(?:\.\d+)?)\s*([A-Z]{3})([\d\s,]+)$/;

export function extractArticles(lines: string[]): HmPoArticle[] {
  const out: HmPoArticle[] = [];
  for (const line of lines) {
    const m = line.match(ARTICLE_LINE_RE);
    if (!m) continue;
    out.push({
      articleNo: m[1],
      hmColourCode: m[2],
      ptArticleNumber: m[3],
      colourName: m[4].trim(),
      optionNoWithVersion: m[5].replace(/\s+/g, " "),
      cost: Number(m[6]),
      costCurrency: m[7],
      qtyPerArticle: parseIntSpaced(m[8]),
    });
  }
  return out;
}

/**
 * Invoice Average Price block:
 *   `Invoice Average Price`
 *   `Country`
 *   `6.18 USDOE, OF, LH, OD`
 * Returns `{ price, currency, countries }` from the single joined value line.
 */
export function extractInvoice(lines: string[]): { price: number; currency: string; countries: string | null } {
  // pdf-parse concatenates the "Invoice Average Price" label with the adjacent
  // "Country" column header into one line, so a strict equality lookup misses
  // it. The following line holds the value: `6.18 USDOE, OF, LH, OD`.
  const i = lines.findIndex((l) => l.startsWith("Invoice Average Price"));
  if (i < 0) return { price: 0, currency: "", countries: null };
  const value = lines[i + 1];
  if (!value) return { price: 0, currency: "", countries: null };
  const m = value.match(/^(\d+(?:\.\d+)?)\s*([A-Z]{3})(.+)?$/);
  if (!m) return { price: 0, currency: "", countries: null };
  return {
    price: Number(m[1]),
    currency: m[2],
    countries: m[3] ? m[3].trim() : null,
  };
}

function parseIntSpaced(raw: string): number {
  const n = parseInt(raw.replace(/[^\d]/g, ""), 10);
  return Number.isFinite(n) ? n : 0;
}
function toInt(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const n = parseInt(String(raw).replace(/[^\d-]/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}
