import type {
  HmCountryBreakdownExtract,
  HmPoExtract,
  HmReconciliation,
  HmSizeBreakdownExtract,
} from "./types";

/**
 * Cross-document reconciliation (user spec §5).
 *
 * All deterministic sums are computed on the extracted VALUES. A failure is
 * recorded as a check with ok=false and a human-readable detail; the extracted
 * source values are NEVER silently altered (user spec §5 last line, SRS §E-12).
 */
export function reconcileSet(
  po: HmPoExtract | null,
  size: HmSizeBreakdownExtract | null,
  country: HmCountryBreakdownExtract | null,
): HmReconciliation {
  const checks: HmReconciliation["checks"] = [];
  const warnings: string[] = [];

  if (po) {
    const marketSum = po.marketRows.reduce((a, r) => a + r.quantity, 0);
    checks.push({
      name: "po_market_sum_equals_po_total",
      ok: marketSum === po.totalQty,
      expected: po.totalQty,
      actual: marketSum,
    });

    const articleSum = po.articles.reduce((a, r) => a + r.qtyPerArticle, 0);
    if (po.articles.length > 0) {
      checks.push({
        name: "po_article_sum_equals_po_total",
        ok: articleSum === po.totalQty,
        expected: po.totalQty,
        actual: articleSum,
      });
    }
  }

  if (po && country) {
    checks.push({
      name: "country_grand_total_equals_po_total",
      ok: country.grandTotal === po.totalQty,
      expected: po.totalQty,
      actual: country.grandTotal,
    });

    // Per-market totals.
    for (const row of po.marketRows) {
      const match = country.rows.find((r) => r.marketCode === row.marketCode);
      if (!match) {
        warnings.push(`Country breakdown has no row for market ${row.marketCode}.`);
        continue;
      }
      checks.push({
        name: `country_vs_po_market_${row.marketCode}`,
        ok: match.rowTotal === row.quantity,
        expected: row.quantity,
        actual: match.rowTotal,
        detail: `market ${row.marketCode}`,
      });
    }
  }

  if (po && size) {
    for (const row of po.marketRows) {
      const page = size.pages.find((p) => p.marketCode === row.marketCode);
      if (!page) {
        warnings.push(`Size breakdown has no page for market ${row.marketCode}.`);
        continue;
      }
      checks.push({
        name: `size_page_vs_po_market_${row.marketCode}`,
        ok: page.marketQuantity === row.quantity,
        expected: row.quantity,
        actual: page.marketQuantity,
        detail: `market ${row.marketCode}`,
      });

      // Scope-restricted size-sum identity (single-article pages only).
      const sizeSum = Object.values(page.sizes).reduce((a, b) => a + b, 0);
      checks.push({
        name: `size_sum_vs_market_${row.marketCode}`,
        ok: sizeSum === page.marketQuantity,
        expected: page.marketQuantity,
        actual: sizeSum,
        detail: `sum of sizes on page ${row.marketCode}`,
      });
    }
  }

  const ok = checks.every((c) => c.ok);
  return { ok, checks, warnings };
}
