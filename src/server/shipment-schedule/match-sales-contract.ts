import type { SalesContractLookup, SalesContractHydrated, MatchResult } from "./types";

interface HmTemplateRowLike {
  orderNo: string;
  orderQty: number | null;
  styleNo: string;
  fob: number | null;
  itemDes: string;
  isAnchor: boolean;
  marketCode?: string;
  country?: string;
}

/** A row from SalesContractBuyerCode — the modern per-(contract × folder)
 *  buyer-code source. `active` defaults to true when the field is omitted,
 *  matching the Prisma schema default. */
export interface BuyerCodeLookup {
  contractNo: string;      // numeric "99" (not the full AGL/H&M/99/2026 ref)
  folderLetter: string;    // "A" / "B" / "C"
  buyerCode: string;       // "AGL 349 A"
  active?: boolean;
}

/** Keep only the digits so "AGL/H&M/99/2026" / "99/2026" / "99" all resolve
 *  to the same lookup key the buyer-code table stores ("99"). */
function numericContractKey(raw: string): string {
  const m = (raw || "").match(/(\d+)/);
  return m ? m[1] : "";
}

/**
 * Match a PDF's order-no prefix (e.g. "569959") against a candidate list of
 * `SalesContractPo` rows. The match is on the OrderNo prefix because the
 * filename only carries the first segment (e.g. "569959 AUW118.pdf"), while
 * the sales contract's orderNo is the full H&M order number ("569959-8404").
 *
 * Pure: no I/O. Caller supplies the already-fetched candidates (usually all
 * READY POs on contracts the user owns, filtered by the prefix).
 *
 * Rules:
 *  - If zero candidates match the prefix → `no_sales_contract_po`.
 *  - If more than one unique full orderNo matches → `ambiguous` (hydrated
 *    with the first candidate anyway, so the UI can show something; the
 *    reviewer resolves it).
 *  - If exactly one matches → `matched`, hydrated from its anchor row.
 *  - If the matching PO is not in READY state → `not_ready`.
 */
export function matchByOrderNoPrefix(
  orderNoPrefix: string,
  candidates: SalesContractLookup[],
  opts: { buyerCodes?: BuyerCodeLookup[] } = {},
): MatchResult {
  const candidateOrderNos = candidates.map((c) => c.orderNo);
  const prefix = orderNoPrefix.trim();
  if (!prefix) return { matched: false, reason: "no_sales_contract_po", candidates: candidateOrderNos };

  const matches = candidates.filter((c) => {
    const headSeg = (c.orderNo || "").split(/[-\/]/)[0];
    return headSeg === prefix;
  });

  if (matches.length === 0) return { matched: false, reason: "no_sales_contract_po", candidates: candidateOrderNos };

  // Dedup on exact orderNo in case the same PO appears twice.
  const uniq = Array.from(new Map(matches.map((m) => [m.orderNo, m])).values());

  const first = uniq[0];
  const hydrated = hydrateFromSalesContract(first, opts.buyerCodes);

  if (uniq.length > 1) {
    return {
      matched: false,
      reason: "ambiguous",
      hydrated,
      candidates: uniq.map((u) => u.orderNo),
    };
  }

  if (first.state !== "READY") {
    return { matched: false, reason: "not_ready", hydrated, candidates: candidateOrderNos };
  }

  return { matched: true, reason: "matched", hydrated, candidates: candidateOrderNos };
}

function hydrateFromSalesContract(
  po: SalesContractLookup,
  buyerCodes?: BuyerCodeLookup[],
): SalesContractHydrated {
  const rows: HmTemplateRowLike[] = safeJsonArray(po.rowsJson);
  // The anchor row carries orderQty / styleNo / fob / itemDes. If there's no
  // anchor flag (older data), fall back to the first row.
  const anchor = rows.find((r) => r.isAnchor) ?? rows[0];
  const marketCode = anchor?.marketCode ?? "";
  // The `country` field is formatted "<tod> <marketCode> (<marketCodeB>) <qty> <pct>%"
  // – pull marketCodeB out of the parentheses to build the Market+Sub combo.
  const sub = anchor?.country ? /\(([^)]+)\)/.exec(anchor.country)?.[1] ?? "" : "";
  const marketSubCode = marketCode && sub ? `${marketCode}${sub}` : marketCode;

  // Buyer Code resolution (bug fix 2026-11-12): the modern source is the
  // per-(contract × folder) SalesContractBuyerCode table; the legacy
  // SalesContract.buyerCode single-value field is the fallback. Before this
  // fix the booking-PDF intake wrote "" into every row whose contract had
  // migrated to the lookup table.
  const numeric = numericContractKey(po.contract.contractNo || po.contract.marchentContNo);
  let buyerCode = "";
  if (numeric && po.folderLetter && Array.isArray(buyerCodes)) {
    const row = buyerCodes.find(
      (b) => b.active !== false && b.contractNo === numeric && b.folderLetter === po.folderLetter,
    );
    if (row && row.buyerCode) buyerCode = row.buyerCode;
  }
  if (!buyerCode) buyerCode = po.contract.buyerCode || "";

  return {
    buyerCode,
    contractNo: po.contract.marchentContNo || "",
    contractDate: po.contract.contractDate || "",
    orderNo: po.orderNo,
    pcs: anchor?.orderQty ?? null,
    style: anchor?.styleNo ?? "",
    fob: anchor?.fob ?? null,
    composition: anchor?.itemDes ?? "",
    cat: "",
    hts: "",
    marketCode,
    marketSubCode,
  };
}

function safeJsonArray<T>(s: string): T[] {
  try {
    const v = JSON.parse(s || "[]");
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}
