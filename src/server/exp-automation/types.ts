/**
 * EXP Automation — shared types + the Excel-column → portal-field maps for the
 * three Bangladesh Bank EXP workflows.
 *
 * Nothing here touches the network or the DB; it is pure data the parser and the
 * live driver both consume. The field maps are the single source of truth for
 * which Excel columns feed which portal form fields, so parsing, preview and
 * fill-and-verify all agree.
 */

export type ExpKind = "correction" | "duplicate" | "download";

export const EXP_KINDS: readonly ExpKind[] = ["correction", "duplicate", "download"];

export function isExpKind(v: string): v is ExpKind {
  return (EXP_KINDS as readonly string[]).includes(v);
}

/** How a portal form control is written/compared. */
export type FieldControl = "text" | "select" | "date" | "number";

/** One Excel-column → portal-field binding. */
export interface FieldMap {
  /** Canonical key used in the parsed row's `values` map. */
  key: string;
  /** Header text in the operator's workbook (matched case/space-insensitively; aliases allowed). */
  excelHeaders: string[];
  /** Human label of the portal form field (for logs + the robust label-anchored locator). */
  portalLabel: string;
  control: FieldControl;
  /**
   * When true the field is always written to prepare the form (not part of the
   * match comparison) — e.g. the mandatory "Update Remarks".
   */
  alwaysFill?: boolean;
  /** When true a blank Excel value means "leave the portal field untouched". */
  skipIfBlank?: boolean;
}

/* ------------------------------------------------------------------ *
 * 1) Issued EXP Correction  — sheet "BE Received (Y N)"
 *    Search key: ADSCODE + EXP Serial + EXP Year.
 * ------------------------------------------------------------------ */
export const CORRECTION_FIELDS: FieldMap[] = [
  { key: "commodityCode", excelHeaders: ["Commodity Code"], portalLabel: "Commodity Code", control: "text", skipIfBlank: true },
  { key: "countryCode", excelHeaders: ["Country Code", "Country"], portalLabel: "Country Code", control: "select", skipIfBlank: true },
  { key: "destinationPort", excelHeaders: ["Destination Port"], portalLabel: "Destination Port", control: "text", skipIfBlank: true },
  { key: "unit", excelHeaders: ["Unit"], portalLabel: "Unit", control: "select", skipIfBlank: true },
  { key: "quantity", excelHeaders: ["Quantity"], portalLabel: "Quantity", control: "number", skipIfBlank: true },
  { key: "currencyCode", excelHeaders: ["Currency Code", "Currency"], portalLabel: "Currency Code", control: "select", skipIfBlank: true },
  { key: "incoterm", excelHeaders: ["Incoterm Used", "Incoterm"], portalLabel: "Incoterm Used", control: "select", skipIfBlank: true },
  { key: "invoiceNo", excelHeaders: ["Invoice No", "Invoice No."], portalLabel: "Invoice No", control: "text", skipIfBlank: true },
  { key: "invoiceDate", excelHeaders: ["Invoice Date"], portalLabel: "Invoice Date", control: "date", skipIfBlank: true },
  { key: "invoiceAmount", excelHeaders: ["Invoice Amount (Issue)", "Invoice Amount"], portalLabel: "Invoice Amount (Issue)", control: "number", skipIfBlank: true },
  { key: "cmtAmount", excelHeaders: ["CMT Amount (Issue)", "CMT Amount"], portalLabel: "CMT Amount (Issue)", control: "number", skipIfBlank: true },
  { key: "freightAmount", excelHeaders: ["Frieght Amount", "Freight Amount"], portalLabel: "Freight Amount", control: "number", skipIfBlank: true },
  { key: "insuranceAmount", excelHeaders: ["Insurance Amount"], portalLabel: "Insurance Amount", control: "number", skipIfBlank: true },
  { key: "otherCharges", excelHeaders: ["Other Charges"], portalLabel: "Other Charges", control: "number", skipIfBlank: true },
  { key: "lcContractNo", excelHeaders: ["LC/Contract No.", "LC/Contract No"], portalLabel: "LC/Contract No.", control: "text", skipIfBlank: true },
  { key: "carrierVessel", excelHeaders: ["Name of Carrier/Vessel", "Carrier/Vessel"], portalLabel: "Name of Carrier/Vessel", control: "text", skipIfBlank: true },
  { key: "transportDocNo", excelHeaders: ["Transport Doc No", "Transport Doc No."], portalLabel: "Transport Doc No", control: "text", skipIfBlank: true },
  { key: "transportDocDate", excelHeaders: ["Transport Doc Date"], portalLabel: "Transport Doc Date", control: "date", skipIfBlank: true },
  { key: "shipPort", excelHeaders: ["Ship Port"], portalLabel: "Ship Port", control: "select", skipIfBlank: true },
  { key: "signatory", excelHeaders: ["Signatory of Exporter"], portalLabel: "Signatory of Exporter", control: "select", skipIfBlank: true },
  { key: "sector", excelHeaders: ["Sector"], portalLabel: "Sector", control: "select", skipIfBlank: true },
  { key: "updateRemarks", excelHeaders: ["*Update Remarks", "Update Remarks"], portalLabel: "Update Remarks", control: "text", alwaysFill: true },
];

/* ------------------------------------------------------------------ *
 * 2) Duplicate EXP Reporting — sheet "DATA FOR DUP."
 *    Search key: ADSCODE + EXP Serial + EXP Year.
 * ------------------------------------------------------------------ */
export const DUPLICATE_FIELDS: FieldMap[] = [
  { key: "freightAmount", excelHeaders: ["Frieght Amount", "Freight Amount"], portalLabel: "Freight Amount", control: "number", skipIfBlank: true },
  { key: "cmtConfirmed", excelHeaders: ["CMT Amount Confirmed by Customs"], portalLabel: "CMT Amount Confirmed by Customs", control: "number", skipIfBlank: true },
  { key: "insuranceAmount", excelHeaders: ["Insurance Amount"], portalLabel: "Insurance Amount", control: "number", skipIfBlank: true },
  { key: "otherCharges", excelHeaders: ["Other Charges"], portalLabel: "Other Charges", control: "number", skipIfBlank: true },
  { key: "customOffice", excelHeaders: ["Custom Office", "*Custom Office"], portalLabel: "Custom Office", control: "select", skipIfBlank: true },
  { key: "billOfExportNo", excelHeaders: ["Bill of Export Number (Number Only)", "Bill of Export Number"], portalLabel: "Bill of Export Number (Number Only)", control: "text", skipIfBlank: true },
  { key: "billOfExportDate", excelHeaders: ["Bill of Export Date"], portalLabel: "Bill of Export Date", control: "date", skipIfBlank: true },
  { key: "shipmentDate", excelHeaders: ["Shipment Date"], portalLabel: "Shipment Date", control: "date", skipIfBlank: true },
  { key: "ackDuplicateDate", excelHeaders: ["Acknowledge/Duplicate Date"], portalLabel: "Acknowledge/Duplicate Date", control: "date", skipIfBlank: true },
  { key: "transportDocType", excelHeaders: ["Transport Doc Type", "*Transport Doc Type"], portalLabel: "Transport Doc Type", control: "select", skipIfBlank: true },
  { key: "transportDocNo", excelHeaders: ["Transport Doc No", "*Transport Doc No"], portalLabel: "Transport Doc No", control: "text", skipIfBlank: true },
  { key: "transportDocDate", excelHeaders: ["Transport Document Date", "Transport Doc Date"], portalLabel: "Transport Document Date", control: "date", skipIfBlank: true },
  { key: "invoiceNo", excelHeaders: ["Invoice No", "*Invoice No"], portalLabel: "Invoice No", control: "text", skipIfBlank: true },
  { key: "invoiceDate", excelHeaders: ["Invoice Date", "*Invoice Date"], portalLabel: "Invoice Date", control: "date", skipIfBlank: true },
];

/** Fields the field maps don't drive but the row still carries as identifiers. */
export interface ParsedExpRow {
  /** 1-based data-row number as shown to the operator. */
  rowNo: number;
  kind: ExpKind;
  /** Shared identifiers (always strings, leading zeros preserved). */
  adscode: string;
  expSerial: string;
  expYear: string;
  expNo: string;
  invoiceNo: string;
  saveAs: string;
  /** canonical field key → display string (exactly as it will be typed/compared). */
  values: Record<string, string>;
  /** The whole row keyed by its (trimmed) header, for traceability. */
  raw: Record<string, string>;
  /** Non-fatal per-row notes (e.g. "Remarks=APPLY", "derived AD/Serial/Year from EXP No"). */
  notes: string[];
  /** True when the row is missing a required identifier and cannot be processed. */
  invalid: boolean;
  invalidReason?: string;
}

export interface ParseResult {
  kind: ExpKind;
  sheetName: string;
  rows: ParsedExpRow[];
  /** Rows that were skipped before becoming ParsedExpRow (e.g. blank identifier). */
  skipped: { rowNo: number; reason: string }[];
  /** Headers that the parser could not locate (diagnostic, non-fatal). */
  missingHeaders: string[];
}

/** The field map for a given kind (download has no form-fill map). */
export function fieldsForKind(kind: ExpKind): FieldMap[] {
  if (kind === "correction") return CORRECTION_FIELDS;
  if (kind === "duplicate") return DUPLICATE_FIELDS;
  return [];
}
