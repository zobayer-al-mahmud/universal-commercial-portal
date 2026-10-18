import { normalizeDate } from "@/server/sales-contract/normalize";
import { ORDER_NO_RE, BLOCK_REF_RE } from "@/server/sales-contract/validate";
import type {
  ScheduleLine,
  ScheduleOptions,
  ScheduleOrderInput,
  ScheduleResult,
  WeekDefinition,
} from "./types";

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Parse a Week workbook title, e.g.
 *   "Week 43 1st cut off 19.10.2026 2nd 23.10.2026"
 * into a WeekDefinition. Returns null if it doesn't match.
 */
export function parseWeekTitle(title: string): WeekDefinition | null {
  const wk = title.match(/week\s*(\d{1,2})/i);
  const dates = [...title.matchAll(/(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})/g)];
  if (!wk || dates.length < 2) return null;
  const toIso = (m: RegExpMatchArray) => `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return {
    weekNo: parseInt(wk[1], 10),
    firstCutOff: toIso(dates[0]),
    secondCutOff: toIso(dates[1]),
  };
}

/**
 * Build a weekly shipment schedule by expanding each order into one line per
 * market allocation. Pure: no DB, no network.
 *
 * Rules:
 *  - value = PCS x FOB, rounded to 2dp (observed).
 *  - invoice numbers allocated sequentially from `invoiceStart` across market lines
 *    (INFERENCE, Q-SS-01: exact allocation rule unconfirmed).
 *  - cut-off defaults to "1st" unless specified per order (Q-SS-01).
 *  - hard validation failures (bad OrderNo / Contract Ref / PCS / FOB / no markets)
 *    flag the line and route the batch to review; no silent write.
 */
export function buildSchedule(
  week: WeekDefinition,
  orders: ScheduleOrderInput[],
  opts: ScheduleOptions = {},
): ScheduleResult {
  const defaultCutOff = opts.defaultCutOff ?? "1st";
  let invoiceSeq = opts.invoiceStart ?? 1;

  const lines: ScheduleLine[] = [];
  const reviewReasons: ScheduleResult["reviewReasons"] = [];

  for (const order of orders) {
    const issues: ScheduleLine["issues"] = [];
    const hard = (field: string, code: string, message: string) =>
      issues.push({ field, code, message, severity: "hard" });

    if (!ORDER_NO_RE.test(order.orderNo))
      hard("orderNo", "INVALID_PO_NUMBER", `OrderNo '${order.orderNo}' invalid`);
    if (!BLOCK_REF_RE.test(order.contractNo))
      hard("contractNo", "INVALID_CONTRACT_REF", `Contract '${order.contractNo}' invalid`);
    if (!(order.pcs > 0)) hard("pcs", "INVALID_QTY", "PCS must be > 0");
    if (!(order.fob > 0)) hard("fob", "INVALID_PRICE", "FOB must be > 0");
    if (!order.markets || order.markets.length === 0)
      hard("markets", "NO_MARKETS", "No market allocation for the order");

    const value = round2(order.pcs * order.fob);
    const success = !issues.some((i) => i.severity === "hard");
    const markets = order.markets && order.markets.length ? order.markets : ["(none)"];

    for (const marketCode of markets) {
      lines.push({
        weekNo: week.weekNo,
        firstCutOff: week.firstCutOff,
        secondCutOff: week.secondCutOff,
        buyerCode: order.buyerCode,
        contractNo: order.contractNo,
        contractDate: normalizeDate(order.contractDate) ?? order.contractDate,
        orderNo: order.orderNo,
        style: order.style,
        composition: order.composition,
        incoterm: order.incoterm || "FCA",
        transport: order.transport || "Sea",
        pcs: order.pcs,
        fob: order.fob,
        value,
        marketCode: marketCode.trim().toUpperCase(),
        invoiceNo: success ? String(invoiceSeq++) : "",
        cutOff: order.cutOff ?? defaultCutOff,
        issues,
        success,
      });
    }

    for (const issue of issues) {
      reviewReasons.push({
        code: issue.code,
        reason: `${order.orderNo} ${issue.field}: ${issue.message}`,
        severity: issue.severity,
      });
    }
  }

  const invoiceNos = lines.map((l) => l.invoiceNo).filter(Boolean);
  const hasHard = reviewReasons.some((r) => r.severity === "hard");

  return {
    week,
    lines,
    summary: {
      orders: orders.length,
      lines: lines.length,
      totalPcs: orders.reduce((a, o) => a + (o.pcs || 0), 0),
      totalValue: round2(orders.reduce((a, o) => a + round2((o.pcs || 0) * (o.fob || 0)), 0)),
      invoiceFrom: invoiceNos[0] ?? null,
      invoiceTo: invoiceNos[invoiceNos.length - 1] ?? null,
    },
    reviewReasons,
    outcome: hasHard ? "queued" : "draft",
  };
}
