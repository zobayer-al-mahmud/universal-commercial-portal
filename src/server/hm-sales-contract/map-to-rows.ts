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
 * Row-generation convention (see docs/modules/hm-sales-contract.md §2):
 *   - FIRST market row is the "anchor": G = total PO qty, M = `=G*I`, R = `=S*G`.
 *   - Subsequent market rows for the same PO leave G/M/R blank; the per-market
 *     quantity is encoded in column O as free text to match the live template.
 *
 * No field is auto-filled from an unrelated source. Blanks are returned as
 * explicit empty strings so the UI can show "source does not contain this
 * field" distinctly from a value the user cleared (user spec §6).
 */
export function mapToTemplateRows(
  po: HmPoExtract,
  _size: HmSizeBreakdownExtract | null,
  _country: HmCountryBreakdownExtract | null,
  recon: HmReconciliation,
): HmTemplateRow[] {
  const rows: HmTemplateRow[] = [];
  if (!po.marketRows.length) return rows;

  const orderNo = po.header.orderNo;
  const itemDes = buildItemDes(po);
  // Spec rule 3-H forbids substituting Product Name for Style No. — leave blank.
  const styleNo = "";
  const fobPrice = po.invoiceAveragePrice || 0;
  const fobCurrency = po.invoiceCurrency || null;

  po.marketRows.forEach((m, i) => {
    const isAnchor = i === 0;
    const pctLabel = m.pct === "<1" ? "<1%" : `${m.pct}%`;
    const countryText = `${m.tod} ${m.marketCode} (${m.marketCodeB}) ${formatQtySpaced(m.quantity)} ${pctLabel}`;

    const issues: string[] = [];
    const marketCheck = recon.checks.find((c) => c.name === `country_vs_po_market_${m.marketCode}`);
    if (marketCheck && !marketCheck.ok) issues.push("QTY_MISMATCH");
    const sizeCheck = recon.checks.find((c) => c.name === `size_page_vs_po_market_${m.marketCode}`);
    if (sizeCheck && !sizeCheck.ok) issues.push("SIZE_MISMATCH");

    rows.push({
      isAnchor,
      orderNo,                                  // F
      orderQty: isAnchor ? po.totalQty : null,  // G
      styleNo,                                   // H (blank — unresolved rule BR-HM-02)
      fob: fobPrice,                             // I (same price on every row, per template)
      fobCurrency,
      itemDes,                                   // J
      tod: m.tod,                                 // N — raw string
      country: countryText,                       // O
      marketCode: m.marketCode,
      marketQuantity: m.quantity,
      pctLabel,
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
    });
  });

  return rows;
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
