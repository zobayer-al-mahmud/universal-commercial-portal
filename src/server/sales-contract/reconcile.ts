import { buildItemDescription } from "./normalize";
import type {
  ContractRow,
  FieldIssue,
  NormalizedPoRow,
  TodStrategy,
  UnitPriceStrategy,
  ValidatedPoRow,
} from "./types";

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Resolve the per-contract Unit Price when per-market Invoice Average Price
 * varies by cent (BR-SC-10, open question Q-SC-01).
 * Default strategy is "equal-only": differing prices raise a pending business
 * decision instead of silently picking a value.
 */
export function resolveUnitPrice(
  prices: number[],
  quantities: number[],
  strategy: UnitPriceStrategy,
): { value: number; issue?: FieldIssue } {
  const uniq = [...new Set(prices.map((p) => round2(p)))];
  if (uniq.length <= 1) return { value: uniq[0] ?? 0 };

  const issue: FieldIssue = {
    field: "unitPrice",
    code: "BUSINESS_DECISION_PENDING",
    message: `Per-market prices differ (${uniq.join(", ")}). Q-SC-01 rule unconfirmed.`,
    severity: "pending",
  };

  switch (strategy.mode) {
    case "max":
      return { value: Math.max(...uniq), issue };
    case "min":
      return { value: Math.min(...uniq), issue };
    case "weighted-average": {
      const totalQty = quantities.reduce((a, b) => a + b, 0) || 1;
      const wsum = prices.reduce((a, p, i) => a + p * (quantities[i] ?? 0), 0);
      return { value: round2(wsum / totalQty), issue };
    }
    case "equal-only":
    default:
      // Fail closed on the derived value: use max as a placeholder but flag pending.
      return { value: Math.max(...uniq), issue };
  }
}

/**
 * Resolve the per-contract Time of Delivery when markets differ
 * (BR-SC-17, open question Q-SC-02).
 */
export function resolveTod(
  tods: string[],
  strategy: TodStrategy,
): { value: string; issue?: FieldIssue } {
  const uniq = [...new Set(tods.filter(Boolean))].sort();
  if (uniq.length <= 1) return { value: uniq[0] ?? "" };
  const issue: FieldIssue = {
    field: "timeOfDelivery",
    code: "BUSINESS_DECISION_PENDING",
    message: `Markets have different TODs (${uniq.join(", ")}). Q-SC-02 rule unconfirmed.`,
    severity: "pending",
  };
  if (strategy.mode === "latest") return { value: uniq[uniq.length - 1], issue };
  // "earliest" and "review" both surface the earliest date with the pending flag.
  return { value: uniq[0], issue };
}

/**
 * Aggregate validated per-market rows for one OrderNo into a per-contract row
 * (SRS §C.2.2 / BR-SC-09..14).
 */
export function aggregateContractRow(
  orderNo: string,
  rows: NormalizedPoRow[],
  opts: { packSet?: number; unitPrice: UnitPriceStrategy; tod: TodStrategy },
): ContractRow {
  const issues: FieldIssue[] = [];
  const packSet = opts.packSet ?? 1;
  const quantities = rows.map((r) => r.quantity ?? 0);
  const orderQty = quantities.reduce((a, b) => a + b, 0);

  const up = resolveUnitPrice(
    rows.map((r) => r.invoiceAveragePrice ?? 0),
    quantities,
    opts.unitPrice,
  );
  if (up.issue) issues.push(up.issue);

  const tod = resolveTod(
    rows.map((r) => r.timeOfDelivery ?? "").filter(Boolean),
    opts.tod,
  );
  if (tod.issue) issues.push(tod.issue);

  const first = rows[0];
  const styleNo = first?.productName ?? "";
  if (!styleNo)
    issues.push({
      field: "styleNo",
      code: "MISSING_STYLE",
      message: "Style name missing for contract row",
      severity: "hard",
    });

  const description = buildItemDescription(first ?? ({} as NormalizedPoRow));
  const value = round2(orderQty * up.value);

  return {
    orderNo,
    styleNo,
    description,
    orderQty,
    totalQtyWithPackSet: orderQty * packSet,
    unitPrice: up.value,
    value,
    timeOfDelivery: tod.value,
    packSet,
    issues,
  };
}

/** Group validated rows by OrderNo. */
export function groupByOrder(rows: ValidatedPoRow[]): Map<string, ValidatedPoRow[]> {
  const map = new Map<string, ValidatedPoRow[]>();
  for (const r of rows) {
    const key = r.row.orderNo || "UNKNOWN";
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(r);
  }
  return map;
}
