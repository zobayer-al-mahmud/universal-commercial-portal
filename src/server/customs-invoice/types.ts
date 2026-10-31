/**
 * Customs Invoice Generation (module 3) — editable per-order invoice.
 * One invoice per unique H&M Order No; country/market code resolves which of
 * the per-country templates provides the final .xlsx layout.
 */

export interface InvoicePrefill {
  orderNo: string;
  // Resolved per-country template key (market+sub).
  countryCode: string;
  marketCode: string;
  marketSubCode: string;

  // From Sales Contract PO.
  contractNo: string;
  contractDate: string;
  hmOrderNo: string;
  buyerCode: string;
  styleNo: string;
  descriptionOfGoods: string;
  unitPrice?: number;
  quantityPcs?: number;

  // From Shipment Schedule row.
  portOfLoading: string;
  portOfDischarge: string;
  placeOfDelivery: string;
  transportMode: string;
  bookingRef: string;
  grossWeightKg?: number;
  totalCartons?: number;
  measurementCbm?: number;
  // Invoice No. allocated on the shipment-schedule row for this Order No.
  // Unique across every week (shipment-schedule enforces it). Blank until the
  // user assigns a number on the schedule row.
  invoiceNo: string;
  // "Expected Delivery" date read off the booking PDF. Used as the invoice
  // date prefill for the Customs Invoice header.
  expectedDelivery: string;

  // Convenience: whether EITHER a sales-contract row OR a shipment row backs this order.
  foundInSalesContract: boolean;
  foundInShipmentSchedule: boolean;
}

/**
 * Flat view of every editable column on the CustomsInvoice table — used by the
 * form, server actions, write-xlsx and the PDF extractor.
 */
export interface InvoiceFields {
  invoiceNumber: string;
  invoiceDate: string;
  contractNo: string;
  contractDate: string;
  hmOrderNo: string;
  marketCode: string;
  marketSubCode: string;
  countryCode: string;
  expNo: string;
  expDate: string;
  portOfLoading: string;
  portOfDischarge: string;
  placeOfDelivery: string;
  countryOfOrigin: string;
  countryOfFinalDestination: string;
  transportMode: string;
  termsOfDelivery: string;
  termsOfPayment: string;
  vesselName: string;
  voyageNo: string;
  sailingDate: string;
  currency: string;
  exporterName: string;
  buyerName: string;
  consigneeName: string;
  cargoDeliveryName: string;
  issuingBank: string;
  descriptionOfGoods: string;
  styleNo: string;
  buyerCode: string;
  hsCode: string;
  category: string;
  quantityPcs: number | null;
  unitPrice: number | null;
  totalCartons: number | null;
  grossWeightKg: number | null;
  netWeightKg: number | null;
  measurementCbm: number | null;
  dimension: string;
  packSet: string;
}

export const INVOICE_FIELD_LABELS: Record<keyof InvoiceFields, string> = {
  invoiceNumber: "Invoice No.",
  invoiceDate: "Invoice date",
  contractNo: "Contract No.",
  contractDate: "Contract date",
  hmOrderNo: "H&M Order No.",
  marketCode: "Country code",
  marketSubCode: "Sub-code (style/article)",
  countryCode: "Resolved template code",
  expNo: "EXP No.",
  expDate: "EXP date",
  portOfLoading: "Port of loading",
  portOfDischarge: "Port of discharge",
  placeOfDelivery: "Place of delivery",
  countryOfOrigin: "Country of origin",
  countryOfFinalDestination: "Country of final destination",
  transportMode: "Transport mode",
  termsOfDelivery: "Terms of delivery",
  termsOfPayment: "Terms of payment",
  vesselName: "Vessel name",
  voyageNo: "Voyage No.",
  sailingDate: "Sailing date",
  currency: "Currency",
  exporterName: "Exporter",
  buyerName: "Buyer",
  consigneeName: "Consignee",
  cargoDeliveryName: "Cargo delivery to",
  issuingBank: "Issuing bank",
  descriptionOfGoods: "Description of goods",
  styleNo: "Style No.",
  buyerCode: "Buyer code",
  hsCode: "HS code",
  category: "Category",
  quantityPcs: "Quantity (PCS)",
  unitPrice: "Unit price",
  totalCartons: "Total cartons",
  grossWeightKg: "Gross weight (kg)",
  netWeightKg: "Net weight (kg)",
  measurementCbm: "Measurement (cbm)",
  dimension: "Dimension",
  packSet: "Pack / set",
};

export const INVOICE_STRING_FIELDS: (keyof InvoiceFields)[] = [
  "invoiceNumber", "invoiceDate", "contractNo", "contractDate", "hmOrderNo",
  "marketCode", "marketSubCode", "countryCode", "expNo", "expDate",
  "portOfLoading", "portOfDischarge", "placeOfDelivery", "countryOfOrigin",
  "countryOfFinalDestination", "transportMode", "termsOfDelivery",
  "termsOfPayment", "vesselName", "voyageNo", "sailingDate", "currency",
  "exporterName", "buyerName", "consigneeName", "cargoDeliveryName",
  "issuingBank", "descriptionOfGoods", "styleNo", "buyerCode", "hsCode",
  "category", "dimension", "packSet",
];
export const INVOICE_INT_FIELDS: (keyof InvoiceFields)[] = ["quantityPcs", "totalCartons"];
export const INVOICE_FLOAT_FIELDS: (keyof InvoiceFields)[] = ["unitPrice", "grossWeightKg", "netWeightKg", "measurementCbm"];

export const DEFAULT_EXPORTER =
  "ANANTA GARMENTS LIMITED, NISCHINTAPUR, ASHULIA, DEPZ ROAD, SAVAR, DHAKA-1341, BANGLADESH";
export const DEFAULT_BUYER =
  "H&M Hennes & Mauritz GBC AB, Master Samuelsgatan 46A, 106 38 Stockholm, Sweden";
