/**
 * Week Wise Shipment Schedule domain types (module 2).
 *
 * Derived from the Week workbook "Summary" layout:
 *   Buyer Code | Cont.No. | Date | OrderNo | PCS | STYLE | FOB | COMPOSITION |
 *   CAT(incoterm) | HTS(transport) | value | INVOICE | <market allocations...>
 *
 * Each order expands to one line per market allocation. Observed: value = PCS x FOB,
 * and invoice numbers run sequentially across the week's market lines. The cut-off
 * assignment (1st vs 2nd) and invoice allocation rule are open (Q-SS-01).
 */

export interface WeekDefinition {
  weekNo: number;
  firstCutOff: string; // ISO yyyy-mm-dd
  secondCutOff: string; // ISO yyyy-mm-dd
}

export interface ScheduleOrderInput {
  buyerCode: string;
  contractNo: string;
  contractDate: string;
  orderNo: string;
  pcs: number;
  style: string;
  fob: number;
  composition: string;
  incoterm: string;
  transport: string;
  markets: string[]; // e.g. ["OW-NLW195", "OW-PLW532"]
  cutOff?: "1st" | "2nd";
}

export interface ScheduleLine {
  weekNo: number;
  firstCutOff: string;
  secondCutOff: string;
  buyerCode: string;
  contractNo: string;
  contractDate: string;
  orderNo: string;
  style: string;
  composition: string;
  incoterm: string;
  transport: string;
  pcs: number;
  fob: number;
  value: number;
  marketCode: string;
  invoiceNo: string;
  cutOff: "1st" | "2nd";
  issues: { field: string; code: string; message: string; severity: "hard" | "pending" }[];
  success: boolean;
}

export interface ScheduleResult {
  week: WeekDefinition;
  lines: ScheduleLine[];
  summary: {
    orders: number;
    lines: number;
    totalPcs: number;
    totalValue: number;
    invoiceFrom: string | null;
    invoiceTo: string | null;
  };
  reviewReasons: { code: string; reason: string; severity: "hard" | "pending" }[];
  outcome: "draft" | "queued";
}

export interface ScheduleOptions {
  invoiceStart?: number; // first invoice number to allocate (default 1)
  defaultCutOff?: "1st" | "2nd";
}
