import type { SalesContractLookup, SalesContractHydrated, MatchResult } from "./types";

interface HmTemplateRowLike {
  orderNo: string;
  orderQty: number | null;
  styleNo: string;
  fob: number | null;
  itemDes: string;
  isAnchor: boolean;
}

/**
 * Match a PDF's order-no prefix (e.g. "569959") against a candidate list of
 * `HmSalesContractPo` rows. The match is on the OrderNo prefix because the
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
  const hydrated = hydrateFromSalesContract(first);

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

function hydrateFromSalesContract(po: SalesContractLookup): SalesContractHydrated {
  const rows: HmTemplateRowLike[] = safeJsonArray(po.rowsJson);
  // The anchor row carries orderQty / styleNo / fob / itemDes. If there's no
  // anchor flag (older data), fall back to the first row.
  const anchor = rows.find((r) => r.isAnchor) ?? rows[0];
  return {
    buyerCode: po.contract.buyerCode || "",
    contractNo: po.contract.marchentContNo || "",
    contractDate: po.contract.contractDate || "",
    orderNo: po.orderNo,
    pcs: anchor?.orderQty ?? null,
    style: anchor?.styleNo ?? "",
    fob: anchor?.fob ?? null,
    composition: anchor?.itemDes ?? "",
    cat: "",
    hts: "",
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
