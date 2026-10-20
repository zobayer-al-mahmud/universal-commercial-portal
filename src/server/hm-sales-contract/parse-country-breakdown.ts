import { extractHeader } from "./parse-po";
import type { HmCountryBreakdownExtract, HmCountryBreakdownRow } from "./types";

/**
 * Parser for the Total Country Breakdown PDF.
 *
 * Real pdf-parse output of the 643159 breakdown PDF contains:
 *   `Colour / Country Breakdown`
 *   `CountryTotalArticle:051`
 *   `75-901`
 *   `OEOLCEU3 544`
 *   `3 544`
 *   `OFOLSEU274`
 *   `274`
 *   ...
 *   `Total:`
 *   `4 0784 078`
 *
 * The per-country rows concatenate `<market-code A><market-code B><article qty>`.
 * This parser is the AUTHORITATIVE source for per-market quantities — the PO
 * market table's qty-vs-pct split is resolved against these values.
 */
export function parseCountryBreakdownText(text: string): HmCountryBreakdownExtract {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const header = extractHeader(lines);

  const articles = extractArticles(lines);
  const rows = extractCountryRows(lines, articles);
  const articleTotals: Record<string, number> = {};
  for (const a of articles) articleTotals[a] = 0;
  let grand = 0;
  for (const r of rows) {
    grand += r.rowTotal;
    for (const a of articles) articleTotals[a] = (articleTotals[a] ?? 0) + (r.articleQuantities[a] ?? 0);
  }
  const totalRowGrand = extractGrandTotal(lines, articles.length);
  if (totalRowGrand > 0) grand = totalRowGrand; // prefer the explicit "Total:" line

  const sizeTotals = extractSizeTotals(lines);
  return { kind: "TotalCountryBreakdown", header, articles, rows, grandTotal: grand, articleTotals, sizeTotals };
}

/** Line looks like `CountryTotalArticle:051` or just `Article:051`. Multiple
 *  articles come as one concatenated string of 3-digit article numbers. */
function extractArticles(lines: string[]): string[] {
  const headerLine = lines.find((l) => /^(?:CountryTotal)?Article:\d{3}(?:\d{3})*$/.test(l));
  if (!headerLine) return [];
  const digits = headerLine.replace(/^.*Article:/, "");
  const out: string[] = [];
  for (let i = 0; i + 3 <= digits.length; i += 3) out.push(digits.slice(i, i + 3));
  return out;
}

/**
 * Rows look like:
 *   `OEOLCEU3 544`     (country + article qty for article 0)
 *   `3 544`            (row total — matches article qty when single-article)
 * For N articles, each row block is 1 line of `<code A><code B><qty1><qty2>...`
 * followed by the row total on the next line. For the sample 643159 PDF N=1 so
 * the article qty equals the row total.
 *
 * We locate rows by the known shape of `<2-upper><upper/digit mix>` prefix.
 */
// codeB (inside the H&M market codes) is always letters + optional dash — never
// digits. If we allowed digits, the regex would greedily absorb the first qty
// digit into the market code and we'd lose the leading digit (e.g. 3544 → 544).
const COUNTRY_ROW_RE = /^([A-Z]{2})([A-Z-]{2,10})([\d\s,]+)$/;

function extractCountryRows(lines: string[], articles: string[]): HmCountryBreakdownRow[] {
  const rows: HmCountryBreakdownRow[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === "Total:" || line.startsWith("Total:")) break;
    const m = line.match(COUNTRY_ROW_RE);
    if (!m) continue;
    // Avoid false positives on the header/other lines by requiring that the
    // next line is a pure-number row (the per-row total).
    const next = lines[i + 1];
    if (!next || !/^[\d\s,]+$/.test(next)) continue;
    const [, codeA, codeB, qtyBlob] = m;
    // For single-article, qtyBlob is the one qty; multi-article: concat of qtys.
    const qty = parseIntSpaced(qtyBlob);
    const rowTotal = parseIntSpaced(next);
    const articleQuantities: Record<string, number> = {};
    if (articles.length === 1) {
      articleQuantities[articles[0]] = qty;
    } else {
      // Split qtyBlob proportionally is unsafe; without more structure we
      // simply attribute the whole blob to the first article and warn via total.
      articleQuantities[articles[0] ?? "UNKNOWN"] = qty;
    }
    rows.push({ marketCode: codeA, marketCodeB: codeB, articleQuantities, rowTotal });
  }
  return rows;
}

/** The explicit grand total line, `Total:` then `4 0784 078` (one per article + overall). */
function extractGrandTotal(lines: string[], articleCount: number): number {
  const idx = lines.findIndex((l) => l === "Total:");
  if (idx < 0 || idx + 1 >= lines.length) return 0;
  const totalsLine = lines[idx + 1];
  // Pattern: `<article1Total><article2Total>...<grandTotal>` concatenated with
  // space-separated thousands. For single-article `4 0784 078` splits as 4 078 + 4 078.
  const digits = totalsLine.replace(/\s+/g, "");
  if (articleCount <= 1) {
    // Just split in half.
    const half = Math.floor(digits.length / 2);
    return parseInt(digits.slice(half), 10) || 0;
  }
  // Multi-article: naive split assuming equal-length totals; a stricter rule
  // would need the article qty widths from upstream.
  const chunk = Math.floor(digits.length / (articleCount + 1));
  return parseInt(digits.slice(-chunk), 10) || 0;
}

/**
 * `Article134*140*146*152*158*164*170*`
 * `051 75-901316634919736549502422`
 * followed by `Total:` / per-size concat on the next line.
 */
function extractSizeTotals(lines: string[]): HmCountryBreakdownExtract["sizeTotals"] {
  const idx = lines.findIndex((l) => /^Article(\d{3,}\*)+$/.test(l));
  if (idx < 0) return [];
  const header = lines[idx];
  const sizes = (header.match(/\d{3,}\*/g) ?? []).map((s) => s.replace(/\*$/, ""));
  const result: HmCountryBreakdownExtract["sizeTotals"] = [];
  for (let i = idx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l === "Total:" || l.startsWith("Total:")) break;
    const m = l.match(/^(\d{3})\s(\d{2}-\d{3})(\d+)$/);
    if (!m) continue;
    const quantities = splitEqual(m[3], sizes.length);
    result.push({
      article: m[1],
      hmColourCode: m[2],
      sizes,
      quantities,
      total: quantities.reduce((a, b) => a + b, 0),
    });
  }
  return result;
}

/** Equal-width split of concatenated numbers. For 643159: 7 sizes, "316634919736549502422"
 *  → length 21 → chunks of 3 → [316, 634, 919, 736, 549, 502, 422]. */
function splitEqual(digits: string, n: number): number[] {
  if (n <= 0) return [];
  if (digits.length % n !== 0) {
    // Fall back: attribute entire string to first slot. Caller sees mismatch via totals.
    const first = parseInt(digits, 10);
    return [Number.isFinite(first) ? first : 0, ...Array(n - 1).fill(0)];
  }
  const w = digits.length / n;
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(parseInt(digits.slice(i * w, i * w + w), 10) || 0);
  return out;
}

function parseIntSpaced(raw: string): number {
  const n = parseInt(raw.replace(/[^\d]/g, ""), 10);
  return Number.isFinite(n) ? n : 0;
}
