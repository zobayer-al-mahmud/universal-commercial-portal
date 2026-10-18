import type { FieldIssue, NormalizedPoRow, ValidatedPoRow } from "./types";

export const ORDER_NO_RE = /^\d{6,7}-\d{3,4}$/;
export const SEASON_RE = /^[1-4]-\d{4}$/;
export const PM_B_RE = /^\([A-Z]{2}-?[A-Z0-9]{2,3}\)$/;
export const BLOCK_REF_RE = /^AGL\/H&M\/\d{2,3}\/\d{4}$/;
export const COMMERCIAL_REF_RE = /^AGL\/H&M\/\d{2,3}-[A-Z]\/\d{4}$/;

/**
 * Deterministic validation of one normalised PO row against SRS §C.3 + §D.
 * Hard issues block any destination write (BR-SC-24..27); pending issues allow a
 * draft but require a business decision before a live submission.
 */
export function validatePoRow(row: NormalizedPoRow): ValidatedPoRow {
  const issues: FieldIssue[] = [];
  const hard = (field: string, code: string, message: string) =>
    issues.push({ field, code, message, severity: "hard" });

  if (!row.orderNo) hard("orderNo", "MISSING_ORDER_NO", "OrderNo is missing");
  else if (!ORDER_NO_RE.test(row.orderNo))
    hard("orderNo", "INVALID_PO_NUMBER", `OrderNo '${row.orderNo}' fails ^\\d{6,7}-\\d{3,4}$`);

  if (row.season && !SEASON_RE.test(row.season))
    hard("season", "INVALID_SEASON", `Season '${row.season}' fails ^[1-4]-\\d{4}$`);

  if (row.planningMarketB && !PM_B_RE.test(row.planningMarketB))
    hard("planningMarketB", "INVALID_PM_B", `Planning Market B '${row.planningMarketB}' invalid`);

  if (row.quantity == null || row.quantity < 1)
    hard("quantity", "INVALID_QTY", "Quantity must be an integer >= 1");

  if (row.invoiceAveragePrice == null || row.invoiceAveragePrice <= 0)
    hard("invoiceAveragePrice", "INVALID_PRICE", "Invoice Average Price must be > 0");

  if (!row.timeOfDelivery)
    hard("timeOfDelivery", "INVALID_TOD", "Time of Delivery missing or unparsable");

  // Currency: USD only; anything else triggers review (BR-SC-13).
  if (row.currency && row.currency !== "USD")
    issues.push({
      field: "currency",
      code: "NON_USD_CURRENCY",
      message: `Currency '${row.currency}' is not USD`,
      severity: "pending",
    });

  if (!row.planningMarketA)
    hard("planningMarketA", "MISSING_PM_A", "Planning Market A missing");

  return { row, issues, success: !issues.some((i) => i.severity === "hard") };
}
