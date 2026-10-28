import { extractHeader } from "./parse-po";
import type { SalesContractPdfHeader, SalesContractSizeBreakdownExtract, SalesContractSizeBreakdownPage } from "./types";

/**
 * Parser for the Size/Colour Breakdown PDF.
 *
 * Each page covers ONE planning market. pdf-parse flattens each page as:
 *
 *   `Size / Colour breakdown`
 *   `<country name> <PM-A>  (<PM-B>)`          â† market heading
 *   `Article No:` / `H&M Colour Code:` / ... labels (6)
 *   values (6)
 *   `Solid` | `Asst`
 *   `134 (134)*284`                            â† size-label concat qty
 *   ...
 *   `Quantity:`
 *   `3 544`                                    â† per-market quantity
 *   `Total` section repeats same structure (we ignore it; it's redundant on
 *   single-article pages).
 *
 * The parser emits one page per market and preserves original size labels so
 * the UI can show "134 (134)*" verbatim.
 */

const MARKET_HEAD_RE = /^(.*?)\s([A-Z]{2})\s*\(([A-Z0-9-]+)\)$/;

export function parseSizeBreakdownText(text: string): SalesContractSizeBreakdownExtract {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const header = extractHeader(lines);
  const pages = extractPages(lines, header);
  return { kind: "SizePerColourBreakdown", header, pages };
}

function extractPages(lines: string[], _header: SalesContractPdfHeader): SalesContractSizeBreakdownPage[] {
  const pages: SalesContractSizeBreakdownPage[] = [];
  // Each page starts with the string "Size / Colour breakdown".
  const starts: number[] = [];
  for (let i = 0; i < lines.length; i++) if (lines[i] === "Size / Colour breakdown") starts.push(i);
  starts.push(lines.length); // sentinel

  for (let p = 0; p < starts.length - 1; p++) {
    const start = starts[p];
    const end = starts[p + 1];
    const slice = lines.slice(start, end);
    const page = parsePage(slice);
    if (page) pages.push(page);
  }
  return pages;
}

function parsePage(lines: string[]): SalesContractSizeBreakdownPage | null {
  if (lines.length === 0) return null;
  // Market heading is the first non-section line that matches "<words> PM-A (PM-B)".
  let marketLine = "";
  for (let i = 1; i < lines.length; i++) {
    const m = lines[i].match(MARKET_HEAD_RE);
    if (m) { marketLine = lines[i]; break; }
  }
  const headMatch = marketLine.match(MARKET_HEAD_RE);
  if (!headMatch) return null;
  const [, countryHeading, marketCode, marketCodeB] = headMatch;

  // Article metadata: 6 labels then 6 values, same technique as parse-po.
  const labels = ["Article No:", "H&M Colour Code:", "Colour Name:", "Description:", "PT Article Number:", "Option No:"];
  const li = findLabelBlockStart(lines, labels);
  const vStart = li >= 0 ? li + labels.length : -1;
  const articleNo = vStart >= 0 ? lines[vStart] : "";
  const hmColourCode = vStart >= 0 ? lines[vStart + 1] : "";
  const colourName = vStart >= 0 ? lines[vStart + 2] : "";
  const description = vStart >= 0 ? lines[vStart + 3] : "";
  const ptArticleNumber = vStart >= 0 ? lines[vStart + 4] : "";
  const optionNo = vStart >= 0 ? lines[vStart + 5] : "";

  // Variant marker "Solid" or "Asst" on its own line.
  const variantIdx = lines.findIndex((l) => l === "Solid" || l === "Asst");
  const variant = variantIdx >= 0 ? lines[variantIdx] : null;

  // Size lines up to the first `Quantity:` marker.
  const quantityIdx = lines.indexOf("Quantity:");
  const sizes: Record<string, number> = {};
  if (variantIdx >= 0 && quantityIdx > variantIdx) {
    for (let i = variantIdx + 1; i < quantityIdx; i++) {
      const sm = lines[i].match(/^(\d{1,2}-\d{1,2}Y[+]?\s*\([^)]+\)\*|[A-Za-z0-9+-]+\s*\([^)]+\)\*)\s*(\d+)$/);
      if (sm) {
        sizes[sm[1].trim()] = Number(sm[2]);
      }
    }
  }

  const marketQuantity = parseIntSpaced(lines[quantityIdx + 1] ?? "");

  return {
    marketHeading: `${countryHeading.trim()} ${marketCode} (${marketCodeB})`,
    marketCode,
    marketCodeB,
    articleNo,
    hmColourCode,
    colourName,
    description,
    ptArticleNumber,
    optionNo,
    variant,
    sizes,
    marketQuantity,
  };
}

function findLabelBlockStart(lines: string[], labels: string[]): number {
  outer: for (let i = 0; i < lines.length; i++) {
    if (lines[i] !== labels[0]) continue;
    for (let k = 1; k < labels.length; k++) if (lines[i + k] !== labels[k]) continue outer;
    return i;
  }
  return -1;
}

function parseIntSpaced(raw: string): number {
  const n = parseInt(String(raw).replace(/[^\d]/g, ""), 10);
  return Number.isFinite(n) ? n : 0;
}
