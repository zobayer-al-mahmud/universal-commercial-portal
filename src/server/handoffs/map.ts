import type { ScheduleOrderInput } from "@/server/shipment-schedule/types";
import type { CustomsInvoiceInput } from "@/server/customs-invoice/types";

/**
 * Cross-module mapping functions (Milestone E). Pure: no DB, no I/O.
 *
 * Handoff 1: a confirmed Sales Contract row (+ its PO-extraction markets) becomes a
 * Shipment Schedule order.
 * Handoff 2: a Shipment Schedule line (with its allocated invoice number) becomes a
 * Customs Invoice input.
 */

export interface ContractRowLike {
  orderNo: string;
  styleNo: string;
  description: string;
  orderQty: number;
  unitPrice: number;
  blockContractRef: string;
  timeOfDelivery: string;
}

/** Handoff 1: contract row + distinct markets -> schedule order. */
export function contractRowToOrder(
  row: ContractRowLike,
  markets: string[],
  opts: { contractDate?: string; buyerCode?: string } = {},
): ScheduleOrderInput {
  return {
    buyerCode: opts.buyerCode ?? "", // per-sub-section buyer code is unresolved (Q-SC-03)
    contractNo: row.blockContractRef,
    contractDate: opts.contractDate ?? "",
    orderNo: row.orderNo,
    pcs: row.orderQty,
    style: row.styleNo,
    fob: row.unitPrice,
    composition: row.description,
    incoterm: "FCA",
    transport: "Sea",
    // Fall back to a single synthetic market when the PO carried none, so the
    // order still schedules (flagged downstream rather than silently dropped).
    markets: markets.length ? markets : ["NA"],
  };
}

export interface ScheduleLineLike {
  invoiceNo: string;
  marketCode: string;
  contractNo: string;
  contractDate: string;
  orderNo: string;
  style: string;
  composition: string;
  pcs: number;
  fob: number;
}

/** Handoff 2: schedule line -> customs invoice input (single line item). */
export function scheduleLineToInvoice(line: ScheduleLineLike): CustomsInvoiceInput {
  return {
    invoiceNumber: line.invoiceNo,
    marketCode: line.marketCode,
    invoiceDate: "",
    contractNo: line.contractNo,
    contractDate: line.contractDate,
    hmOrderNo: line.orderNo,
    expNo: "",
    expDate: "",
    portOfLoading: "CHITTAGONG",
    portOfDelivery: "",
    countryOfOrigin: "Bangladesh",
    countryOfFinalDestination: "",
    lineItems: [
      {
        description: line.composition || line.style,
        hsCode: "", // HS code is not carried on the schedule line; filled later
        quantity: line.pcs,
        unitPrice: line.fob,
      },
    ],
  };
}
