import type {
  HmPoExtract,
  HmReconciliation,
  HmSetMatch,
  HmSetResult,
  HmSizeBreakdownExtract,
  HmCountryBreakdownExtract,
  HmTemplateRow,
} from "./types";

/**
 * Build the A..U template rows for one PO's three-PDF set.
 *
 * User spec (2026-10-20 follow-up): exactly ONE row per PO is appended to the
 * master Excel. If the PO has multiple markets, every market's TOD / code /
 * qty / pct is concatenated (one line per market, newline-separated) into
 * columns N (TOD) and O (COUNTRY) — the writer sets wrapText so the cell
 * displays as a stack. G / M / R are always populated on this single row.
 *
 * No field is auto-filled from an unrelated source. Blanks are returned as
 * explicit empty strings so the UI can show "source does not contain this
 * field" distinctly from a value the user cleared.
 */
export function mapToTemplateRows(
  po: HmPoExtract,
  _size: HmSizeBreakdownExtract | null,
  _country: HmCountryBreakdownExtract | null,
  recon: HmReconciliation,
): HmTemplateRow[] {
  if (!po.marketRows.length) return [];

  const orderNo = po.header.orderNo;
  const itemDes = buildItemDes(po);
  // Spec rule 3-H forbids substituting Product Name for Style No. — leave blank.
  const styleNo = "";
  const fobPrice = po.invoiceAveragePrice || 0;
  const fobCurrency = po.invoiceCurrency || null;

  const perMarketLines: string[] = [];
  const perMarketTods: string[] = [];
  const marketCodes: string[] = [];
  const issues: string[] = [];
  let marketQtySum = 0;

  for (const m of po.marketRows) {
    const pctLabel = m.pct === "<1" ? "<1%" : `${m.pct}%`;
    perMarketLines.push(`${m.tod} ${m.marketCode} (${m.marketCodeB}) ${formatQtySpaced(m.quantity)} ${pctLabel}`);
    perMarketTods.push(m.tod);
    marketCodes.push(m.marketCode);
    marketQtySum += m.quantity;
    const marketCheck = recon.checks.find((c) => c.name === `country_vs_po_market_${m.marketCode}`);
    if (marketCheck && !marketCheck.ok && !issues.includes("QTY_MISMATCH")) issues.push("QTY_MISMATCH");
    const sizeCheck = recon.checks.find((c) => c.name === `size_page_vs_po_market_${m.marketCode}`);
    if (sizeCheck && !sizeCheck.ok && !issues.includes("SIZE_MISMATCH")) issues.push("SIZE_MISMATCH");
  }

  // Dedup identical TODs so an all-same-TOD PO renders one line in N instead of
  // "29 Jun, 2026\n29 Jun, 2026\n29 Jun, 2026".
  const todLines = Array.from(new Set(perMarketTods));

  return [{
    isAnchor: true,
    orderNo,                                   // F
    orderQty: po.totalQty,                     // G (total)
    styleNo,                                   // H (blank — unresolved rule BR-HM-02)
    fob: fobPrice,                             // I
    fobCurrency,
    itemDes,                                   // J
    tod: todLines.join("\n"),                  // N — one line per distinct TOD
    country: perMarketLines.join("\n"),        // O — one line per market
    marketCode: marketCodes.join(","),         // traceability only; not written as a cell
    marketQuantity: marketQtySum,              // traceability only; equals totalQty when markets fully allocated
    pctLabel: "",                              // not meaningful on the merged row (pct is per market, encoded in O)
    blanks: {
      marchentContNo: "",
      date: "",
      buyerCode: "",
      commercialContNo: "",
      dateCommercial: "",
      cat: "",
      hts: "",
      remarks: "",
      merchandiserName: "",
      packSet: "",
      withoutDiscount: "",
      discountFobDate: "",
    },
    issues,
  }];
}

/** Column J (Item Des.) — composed only from fields that are actually in the PO
 *  PDF: Customs Customer Group, Product Description, Type of Construction. */
export function buildItemDes(po: HmPoExtract): string {
  return [po.header.customsCustomerGroup, po.header.productDescription, po.header.typeOfConstruction]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/** `3544` → `3 544` (space-separated thousands, matching the template's convention). */
export function formatQtySpaced(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n).toString();
  // Insert a space every three digits from the right.
  const parts: string[] = [];
  for (let i = abs.length; i > 0; i -= 3) parts.unshift(abs.slice(Math.max(0, i - 3), i));
  return sign + parts.join(" ");
}

/** Compose the full HmSetResult envelope for one PO. */
export function buildSetResult(
  po: HmPoExtract | null,
  size: HmSizeBreakdownExtract | null,
  country: HmCountryBreakdownExtract | null,
  match: HmSetMatch,
  recon: HmReconciliation,
): HmSetResult {
  const reasons: string[] = [];
  const blockWrite = !match.matched;
  if (!match.matched) {
    reasons.push(
      po || size || country
        ? `Order No does not match across the three PDFs: ${[po?.header.orderNo, size?.header.orderNo, country?.header.orderNo].filter(Boolean).join(" vs ")}. No rows generated.`
        : "No PDFs supplied.",
    );
  }
  if (match.warnings.length) reasons.push(...match.warnings);
  for (const c of recon.checks) {
    if (!c.ok) reasons.push(`QTY_MISMATCH ${c.name}: expected ${c.expected}, got ${c.actual}${c.detail ? ` (${c.detail})` : ""}.`);
  }
  if (recon.warnings.length) reasons.push(...recon.warnings);

  const rows = !blockWrite && po ? mapToTemplateRows(po, size, country, recon) : [];
  return {
    orderNo: match.orderNo ?? po?.header.orderNo ?? "",
    match,
    reconciliation: recon,
    po,
    size,
    country,
    rows,
    blockWrite,
    reasons,
  };
}
