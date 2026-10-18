/**
 * Customs Invoice Generation domain types (module 3).
 *
 * Derived from the per-order customs-invoice workbooks (sample 45238 NH.xlsx):
 * an invoice keyed by Invoice Number + market code, with a fixed exporter (Ananta),
 * buyer/consignee (H&M GBC), a per-market cargo-delivery consignee, and HS-coded
 * line items. amount = quantity x unitPrice; totalValue = sum(amount).
 */

export interface InvoiceLineItemInput {
  description: string;
  hsCode: string;
  quantity: number;
  unitPrice: number;
}

export interface InvoiceLineItem extends InvoiceLineItemInput {
  amount: number;
}

export interface CustomsInvoiceInput {
  invoiceNumber: string;
  marketCode: string;
  invoiceDate: string;
  contractNo: string;
  contractDate: string;
  hmOrderNo: string;
  expNo: string;
  expDate: string;
  portOfLoading: string;
  portOfDelivery: string;
  countryOfOrigin: string;
  countryOfFinalDestination: string;
  currency?: string;
  buyerName?: string;
  consigneeName?: string;
  lineItems: InvoiceLineItemInput[];
}

export interface InvoiceIssue {
  field: string;
  code: string;
  message: string;
  severity: "hard" | "pending";
}

export interface CustomsInvoiceDoc {
  invoiceKey: string; // "<number> <market>"
  invoiceNumber: string;
  marketCode: string;
  invoiceDate: string;
  contractNo: string;
  contractDate: string;
  hmOrderNo: string;
  expNo: string;
  expDate: string;
  portOfLoading: string;
  portOfDelivery: string;
  countryOfOrigin: string;
  countryOfFinalDestination: string;
  currency: string;
  exporterName: string;
  buyerName: string;
  consigneeName: string;
  cargoDeliveryName: string;
  lineItems: InvoiceLineItem[];
  totalQty: number;
  totalValue: number;
  issues: InvoiceIssue[];
  success: boolean;
}

export interface BuildInvoiceOptions {
  /** market code -> cargo-delivery consignee name (reference data, Q-CI-01). */
  cargoDeliveryByMarket?: Record<string, string>;
  exporterName?: string;
}

// Observed fixed parties (customs-invoice workbooks).
export const DEFAULT_EXPORTER =
  "ANANTA GARMENTS LIMITED, NISCHINTAPUR, ASHULIA, DEPZ ROAD, SAVAR, DHAKA-1341, BANGLADESH";
export const DEFAULT_BUYER =
  "H&M Hennes & Mauritz GBC AB, Master Samuelsgatan 46A, 106 38 Stockholm, Sweden";
