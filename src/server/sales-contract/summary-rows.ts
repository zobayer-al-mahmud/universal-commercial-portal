/**
 * Row-generation for the consolidated H&M Summary Excel (2026-10-26 spec Â§11).
 *
 * ONE PO can produce MANY summary rows – one row per distinct applicable
 * combination of (delivery date, country, unit price). Order Qty + Pack/Set
 * Qty appear only on the FIRST applicable row for the PO; later rows leave
 * those two cells blank. Country / TOD / FOB / CONTRACT VALUE are preserved
 * on every applicable row.
 *
 * The spec explicitly forbids multiplying one PO's quantity across every
 * country × TOD × price combination. The current PO extractor only exposes
 * one unit price per PO (`invoiceAveragePrice`); when the user confirms that
 * H&M POs can carry distinct per-market or per-article prices, pass them via
 * `extraPrices` so this generator preserves them without averaging.
 */
import type { SalesContractCountryBreakdownExtract, SalesContractPoExtract } from "./types";

export interface SalesContractSummaryConfig {
  contractNo: string;         // e.g. "97"
  folderLetter: string;       // e.g. "A"
  contractDate: string;       // column B – Sales-Contract-level
  folderCommercialDate: string; // column E – folder-level
  buyerCode: string;          // column C – looked up (contractNo, folderLetter)
  merchandiserName: string;   // column Q – "S-4-2026- Manik, Aslam"
  packSet: string;            // column S – manual on the Sales Contract
  marchentContNoOverride?: string; // optional override for column A
  /**
   * Extra price breakdowns the extractor exposes beyond `invoiceAveragePrice`.
   * Preserve them verbatim; never average. Each entry is `(key, price, qty)`;
   * `key` describes the applicable dimension:
   *   `"market:OE"`                 – override price for market OE only
   *   `"article:051"`               – override price for every row with article 051
   *   `"article:051:market:OE"`     – override for (article 051 × market OE)
   * Leave empty when the PO has a single unit price.
   */
  extraPrices?: { key: string; price: number; qty: number }[];
}

/**
 * Build `extraPrices` from a PO extract + country breakdown when the PO
 * carries DISTINCT per-article unit prices and the country breakdown
 * establishes per-(article × market) quantities. Preserves every distinct
 * price verbatim – never averaged, never duplicated across unrelated markets.
 *
 * Returns `[]` for a single-article PO or one where every article has the
 * same cost (no distinct prices to preserve). Returns article-level entries
 * (`article:<N>`) when the country breakdown is absent; article-×-market
 * entries (`article:<N>:market:<CODE>`) when it is present.
 */
export function buildExtraPricesFromPo(
  po: SalesContractPoExtract,
  country: SalesContractCountryBreakdownExtract | null,
): { key: string; price: number; qty: number }[] {
  if (!po || !po.articles || po.articles.length === 0) return [];
  const distinctCosts = new Set<number>();
  for (const a of po.articles) {
    if (Number.isFinite(a.cost)) distinctCosts.add(a.cost);
  }
  // Nothing to split out if every article is the same price.
  if (distinctCosts.size <= 1) return [];

  const out: { key: string; price: number; qty: number }[] = [];
  if (country && country.rows && country.rows.length > 0) {
    for (const art of po.articles) {
      for (const row of country.rows) {
        const q = row.articleQuantities?.[art.articleNo];
        if (typeof q === "number" && q > 0) {
          out.push({ key: `article:${art.articleNo}:market:${row.marketCode}`, price: art.cost, qty: q });
        }
      }
    }
  } else {
    for (const art of po.articles) {
      out.push({ key: `article:${art.articleNo}`, price: art.cost, qty: art.qtyPerArticle });
    }
  }
  return out;
}

export interface SalesContractSummaryRow {
  // Identity (every row of one PO shares these)
  orderNo: string;
  poId: string;
  // Column payload (A..U). `null` on a numeric cell means "blank" (either the
  // source does not contain it, or this is a continuation row).
  marchentContNo: string;        // A
  contractDate: string;          // B – Sales-Contract-level
  buyerCode: string;             // C
  commercialContNo: string;      // D – the numeric contract (e.g. "97")
  folderCommercialDate: string;  // E – folder-level
  orderQty: number | null;       // G – first row only
  styleNo: string;               // H – product name (BR-HM-02 resolution)
  fob: number | null;            // I
  itemDes: string;               // J
  cat: string;                   // K
  hts: string;                   // L
  contractValue: number | null;  // M – fob * qty for THIS row (never averaged)
  tod: string;                   // N
  country: string;               // O – e.g. "OE (OLCEU)"
  remarks: string;               // P – passthrough; manual-editable
  merchandiserName: string;      // Q
  packSetQty: number | null;     // R – first row only (packSet * orderQty)
  packSet: string;               // S
  withoutDiscountOldFob: string; // T – always blank; manual
  discountFobConDate: string;    // U – always blank; manual
  // Trace / validation
  marketCode: string;
  isFirstForPo: boolean;
  issues: string[];
}

export function mapToSummaryRows(
  po: SalesContractPoExtract,
  config: SalesContractSummaryConfig,
  poId: string,
): SalesContractSummaryRow[] {
  if (!po || !po.marketRows || po.marketRows.length === 0) return [];

  const styleNo = po.header.productName ?? "";
  const itemDes = [po.header.customsCustomerGroup, po.header.productDescription, po.header.typeOfConstruction]
    .filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  const fallbackPrice = Number.isFinite(po.invoiceAveragePrice) ? po.invoiceAveragePrice : null;
  const packSetN = Number(config.packSet);
  const packSetValid = Number.isFinite(packSetN) && packSetN > 0;

  // Combinations: (TOD, marketCode, article, price). The current extractor
  // exposes one price per PO (`invoiceAveragePrice`); extraPrices lets a
  // per-market / per-article / per-(article × market) breakdown override it
  // on matching rows, so distinct prices stay verbatim (spec Â§7, Â§11-2).
  type Combo = {
    tod: string;
    marketCode: string;
    marketCodeB: string;
    qty: number;
    price: number | null;
    priceKey: string;
    articleNo?: string;
  };
  const extras = config.extraPrices ?? [];
  const articleTimesMarket = extras.filter((p) => /^article:[^:]+:market:[^:]+$/.test(p.key));
  // Pre-dedup bucket: article × market expansion goes here, then we merge
  // same-(tod, country, price) rows together in `combos` below.
  const combos0: Combo[] = [];

  if (articleTimesMarket.length > 0) {
    // Expand one row per (market × article) using the country breakdown qtys.
    for (const m of po.marketRows) {
      const entries = articleTimesMarket.filter((p) => p.key.endsWith(`:market:${m.marketCode}`));
      if (entries.length === 0) {
        // No article split for this market → fall back to the market-only combo.
        combos0.push({ tod: m.tod ?? "", marketCode: m.marketCode, marketCodeB: m.marketCodeB, qty: m.quantity, price: fallbackPrice, priceKey: "fallback:avg" });
        continue;
      }
      for (const e of entries) {
        const articleNo = e.key.match(/^article:([^:]+):market:/)?.[1];
        combos0.push({ tod: m.tod ?? "", marketCode: m.marketCode, marketCodeB: m.marketCodeB, qty: e.qty, price: e.price, priceKey: e.key, articleNo });
      }
    }
  } else {
    for (const m of po.marketRows) {
      const extraForMarket = extras.find((p) => p.key === `market:${m.marketCode}`);
      const price = extraForMarket?.price ?? fallbackPrice;
      const priceKey = extraForMarket ? `extra:market:${m.marketCode}` : "fallback:avg";
      combos0.push({ tod: m.tod ?? "", marketCode: m.marketCode, marketCodeB: m.marketCodeB, qty: m.quantity, price, priceKey });
    }
  }

  // Collapse article-level duplicates: when the per-article split produces
  // several rows for the SAME (tod, marketCode, marketCodeB, price), merge
  // them into a single row by summing qty. The user forbids repeating the
  // same country × price combination across articles — one country ships at
  // one (effective) price per PO (user rule 2026-10-28), so the Summary now
  // lists exactly one row per distinct (TOD, country, price). The article
  // identity is dropped at merge time (`[art N]` suffix never shows up).
  const combos: Combo[] = [];
  {
    const key = (c: Combo) =>
      `${c.tod}|${c.marketCode}|${c.marketCodeB}|${c.price ?? ""}`;
    const grouped = new Map<string, Combo>();
    for (const c of combos0) {
      const k = key(c);
      const existing = grouped.get(k);
      if (existing) {
        existing.qty = (Number.isFinite(existing.qty) ? existing.qty : 0) +
          (Number.isFinite(c.qty) ? c.qty : 0);
        // Lose the article identity when merging — the merged row is no
        // longer about one specific article, it's the full country combo.
        existing.articleNo = undefined;
      } else {
        grouped.set(k, { ...c });
      }
    }
    for (const v of grouped.values()) combos.push(v);
  }

  // Deterministic sort: TOD ascending (lexicographic – PO already carries real
  // dates), then market code, then price key. Keeps regeneration idempotent.
  combos.sort((a, b) =>
    a.tod.localeCompare(b.tod) ||
    a.marketCode.localeCompare(b.marketCode) ||
    a.priceKey.localeCompare(b.priceKey),
  );

  // 2026-10-27 rule change: Column G (Order Qty) now carries the
  // per-country quantity from the Country Breakdown PDF (c.qty) on EVERY
  // row — no "total on first row only". FOB (I) stays per-market (via
  // extraPrices when the breakdown exposes distinct prices, else the PO
  // invoice-average price). CONTRACT VALUE (M) = row qty × row price.
  const rows: SalesContractSummaryRow[] = [];
  combos.forEach((c, i) => {
    const first = i === 0;
    const issues: string[] = [];
    if (c.price === null) issues.push("UNIT_PRICE_MISSING");
    const perRowQty = Number.isFinite(c.qty) ? c.qty : null;
    const contractValueForRow = c.price !== null && perRowQty !== null ? c.price * perRowQty : null;
    const packSetQtyForRow = packSetValid && perRowQty !== null ? packSetN * perRowQty : null;

    rows.push({
      orderNo: po.header.orderNo,
      poId,
      marchentContNo: config.marchentContNoOverride ?? "",
      contractDate: config.contractDate,
      buyerCode: config.buyerCode,
      commercialContNo: config.contractNo,
      folderCommercialDate: config.folderCommercialDate,
      orderQty: perRowQty,
      styleNo,
      fob: c.price,
      itemDes,
      cat: "",
      hts: "",
      contractValue: contractValueForRow,
      tod: c.tod,
      // Country column: "<marketCode> (<marketCodeB>)" only. The article
      // identity is deliberately dropped — one row per distinct (TOD,
      // country, price) is the user's rule, articles collapse into that row.
      country: `${c.marketCode}${c.marketCodeB ? ` (${c.marketCodeB})` : ""}`,
      remarks: "",
      merchandiserName: config.merchandiserName,
      packSetQty: packSetQtyForRow,
      packSet: config.packSet,
      withoutDiscountOldFob: "",
      discountFobConDate: "",
      marketCode: c.marketCode,
      isFirstForPo: first,
      issues,
    });
  });

  // Reconciliation: sum of per-row quantities must equal the PO total.
  const perRowQtySum = combos.reduce((n, c) => n + (Number.isFinite(c.qty) ? c.qty : 0), 0);
  const poTotal = Number.isFinite(po.totalQty) ? po.totalQty : null;
  if (poTotal !== null && perRowQtySum !== poTotal) {
    for (const r of rows) r.issues.push("QTY_RECONCILIATION_FAILED");
  }
  return rows;
}
