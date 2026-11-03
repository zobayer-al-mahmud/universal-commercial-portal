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
  /** Human label of the portal form field (for logs + the preview). */
  portalLabel: string;
  /**
   * Stable Oracle APEX item id of the EDIT-form control (verified against the
   * live portal 2026-10-28), e.g. "P68_COMMODITY_CODE". Read/fill locate by this
   * id first — unlike labels it is unique and present even when the visible label
   * is blank, and it is the edit field (Pnn_X), never the search field (Pnn_X2).
   * Omitted only when no portal field could be confirmed for the column; such a
   * field is never written to a guessed control and is logged for manual review.
   */
  portalId?: string;
  control: FieldControl;
  /**
   * When true the field is always written to prepare the form (not part of the
   * match comparison) — e.g. the mandatory "Update Remarks".
   */
  alwaysFill?: boolean;
  /** When true a blank Excel value means "leave the portal field untouched". */
  skipIfBlank?: boolean;
  /**
   * The Excel column exists but its portal target could not be confirmed (or is
   * semantically different). The driver does NOT write it; it logs the value so
   * the operator can enter it by hand before submitting. Never silently dropped.
   */
  needsConfirmation?: string;
}

/* ------------------------------------------------------------------ *
 * 1) Issued EXP Correction  — sheet "BE Received (Y N)"
 *    Search key: ADSCODE + EXP Serial + EXP Year.
 * ------------------------------------------------------------------ */
export const CORRECTION_FIELDS: FieldMap[] = [
  { key: "commodityCode", excelHeaders: ["Commodity Code"], portalLabel: "Commodity Code", portalId: "P68_COMMODITY_CODE", control: "text", skipIfBlank: true },
  { key: "countryCode", excelHeaders: ["Country Code", "Country"], portalLabel: "Country Code", portalId: "P68_COUNTRY_CODE", control: "select", skipIfBlank: true },
  { key: "destinationPort", excelHeaders: ["Destination Port"], portalLabel: "Destination Port", portalId: "P68_DEST_PORT", control: "text", skipIfBlank: true },
  { key: "unit", excelHeaders: ["Unit"], portalLabel: "Unit", portalId: "P68_UNIT_CODE", control: "select", skipIfBlank: true },
  { key: "quantity", excelHeaders: ["Quantity"], portalLabel: "Quantity", portalId: "P68_QUANTITY", control: "number", skipIfBlank: true },
  { key: "currencyCode", excelHeaders: ["Currency Code", "Currency"], portalLabel: "Currency Code", portalId: "P68_CURRENCY_CODE", control: "select", skipIfBlank: true },
  { key: "incoterm", excelHeaders: ["Incoterm Used", "Incoterm"], portalLabel: "Incoterm Used", portalId: "P68_INCOTERM", control: "select", skipIfBlank: true },
  { key: "invoiceNo", excelHeaders: ["Invoice No", "Invoice No."], portalLabel: "Invoice No", portalId: "P68_INVOICE_NO", control: "text", skipIfBlank: true },
  { key: "invoiceDate", excelHeaders: ["Invoice Date"], portalLabel: "Invoice Date", portalId: "P68_INVOICE_DATE", control: "date", skipIfBlank: true },
  { key: "invoiceAmount", excelHeaders: ["Invoice Amount (Issue)", "Invoice Amount"], portalLabel: "Invoice Amount (Issue)", portalId: "P68_AMOUNT_INV", control: "number", skipIfBlank: true },
  { key: "cmtAmount", excelHeaders: ["CMT Amount (Issue)", "CMT Amount"], portalLabel: "CMT Amount (Issue)", portalId: "P68_CMT", control: "number", skipIfBlank: true },
  { key: "freightAmount", excelHeaders: ["Frieght Amount", "Freight Amount"], portalLabel: "Frieght Amount", portalId: "P68_FRIEGHT", control: "number", skipIfBlank: true },
  { key: "insuranceAmount", excelHeaders: ["Insurance Amount"], portalLabel: "Insurance Amount", portalId: "P68_INSURANCE", control: "number", skipIfBlank: true },
  { key: "otherCharges", excelHeaders: ["Other Charges"], portalLabel: "Other Charges", portalId: "P68_OTHER_CHARGES", control: "number", skipIfBlank: true },
  // "LC/Contract No." IS a real text field on the Edit/Update EXP form (confirmed
  // from the live portal screenshot). Its APEX id is not pinned, so it is filled
  // by label (edit-region-aware) rather than a guessed id.
  { key: "lcContractNo", excelHeaders: ["LC/Contract No.", "LC/Contract No"], portalLabel: "LC/Contract No.", control: "text", skipIfBlank: true },
  { key: "carrierVessel", excelHeaders: ["Name of Carrier/Vessel", "Carrier/Vessel"], portalLabel: "Name of Carrier/Vessel", portalId: "P68_CARREIR", control: "text", skipIfBlank: true },
  { key: "transportDocNo", excelHeaders: ["Transport Doc No", "Transport Doc No."], portalLabel: "Transport Doc No", portalId: "P68_BILL_LADING", control: "text", skipIfBlank: true },
  { key: "transportDocDate", excelHeaders: ["Transport Doc Date"], portalLabel: "Transport Doc Date", portalId: "P68_DATE_LADING", control: "date", skipIfBlank: true },
  { key: "shipPort", excelHeaders: ["Ship Port"], portalLabel: "Ship Port", portalId: "P68_SHIP_PORT", control: "select", skipIfBlank: true },
  { key: "signatory", excelHeaders: ["Signatory of Exporter"], portalLabel: "Signatory of Exporter", portalId: "P68_ASSIGNED_SIGNATORY", control: "select", skipIfBlank: true },
  { key: "sector", excelHeaders: ["Sector"], portalLabel: "Sector", portalId: "P68_SECTOR", control: "select", skipIfBlank: true },
  { key: "updateRemarks", excelHeaders: ["*Update Remarks", "Update Remarks"], portalLabel: "Update Remarks", portalId: "P68_REMARKS", control: "text", alwaysFill: true },
];

/* ------------------------------------------------------------------ *
 * 2) Duplicate EXP Reporting — sheet "DATA FOR DUP."
 *    Search key: ADSCODE + EXP Serial + EXP Year.
 * ------------------------------------------------------------------ */
export const DUPLICATE_FIELDS: FieldMap[] = [
  { key: "freightAmount", excelHeaders: ["Frieght Amount", "Freight Amount"], portalLabel: "Frieght Amount", portalId: "P3_FRIEGHT", control: "number", skipIfBlank: true },
  // The Export Acknowledgement form shows "CMT Amount Confirmed by Customs" as a
  // READ-ONLY label with no input (confirmed from the live screenshot); the only
  // editable customs-confirmed field is the separate "Invoice Amount Confirmed By
  // Customs", for which the workbook has no column. So this Excel value cannot be
  // written — it is logged for manual entry rather than forced into another field.
  { key: "cmtConfirmed", excelHeaders: ["CMT Amount Confirmed by Customs"], portalLabel: "CMT Amount Confirmed by Customs", control: "number", skipIfBlank: true, needsConfirmation: "'CMT Amount Confirmed by Customs' is read-only on the Export Acknowledgement form (no input). Enter it manually if the portal later exposes it." },
  { key: "insuranceAmount", excelHeaders: ["Insurance Amount"], portalLabel: "Insurance Amount", portalId: "P3_INSURANCE", control: "number", skipIfBlank: true },
  { key: "otherCharges", excelHeaders: ["Other Charges"], portalLabel: "Other Charges", portalId: "P3_OTHER_CHARGES", control: "number", skipIfBlank: true },
  { key: "customOffice", excelHeaders: ["Custom Office", "*Custom Office"], portalLabel: "Custom Office", portalId: "P3_CUSOTM_CODE", control: "select", skipIfBlank: true },
  { key: "billOfExportNo", excelHeaders: ["Bill of Export Number (Number Only)", "Bill of Export Number"], portalLabel: "Bill of Export Number (Number Only)", portalId: "P3_EXPORT_BILL_NUMBER", control: "text", skipIfBlank: true },
  { key: "billOfExportDate", excelHeaders: ["Bill of Export Date"], portalLabel: "Bill of Export Date", portalId: "P3_EXPORT_BILL_DATE", control: "date", skipIfBlank: true },
  { key: "shipmentDate", excelHeaders: ["Shipment Date"], portalLabel: "Shipment Date", portalId: "P3_SHIP_DATE", control: "date", skipIfBlank: true },
  { key: "ackDuplicateDate", excelHeaders: ["Acknowledge/Duplicate Date"], portalLabel: "Acknowledge/Duplicate Date", portalId: "P3_DUP_DATE", control: "date", skipIfBlank: true },
  { key: "transportDocType", excelHeaders: ["Transport Doc Type", "*Transport Doc Type"], portalLabel: "Transport Doc Type", portalId: "P3_TYPE_CODE", control: "select", skipIfBlank: true },
  { key: "transportDocNo", excelHeaders: ["Transport Doc No", "*Transport Doc No"], portalLabel: "Transport Doc No", portalId: "P3_BILL_LADING", control: "text", skipIfBlank: true },
  { key: "transportDocDate", excelHeaders: ["Transport Document Date", "Transport Doc Date"], portalLabel: "Transport Document Date", portalId: "P3_LADING_DATE", control: "date", skipIfBlank: true },
  { key: "invoiceNo", excelHeaders: ["Invoice No", "*Invoice No"], portalLabel: "Invoice No", portalId: "P3_INVOICE_NO", control: "text", skipIfBlank: true },
  { key: "invoiceDate", excelHeaders: ["Invoice Date", "*Invoice Date"], portalLabel: "Invoice Date", portalId: "P3_INVOICE_DATE", control: "date", skipIfBlank: true },

  // Special requirement (2026-11-03): when the Export Acknowledgement form exposes
  // "Invoice Amount" AND "Invoice Amount Confirmed By Customs" as EDITABLE inputs,
  // copy the SAME Excel invoice amount into BOTH, then verify. On records where
  // either is read-only (as in the sample screenshot), the fill simply fails and
  // is logged for manual entry — never forced. APEX ids are not pinned for these,
  // so they are located by edit-region-aware label; confirm live before relying on
  // them for a production run.
  { key: "invoiceAmount", excelHeaders: ["Invoice Amount (Issue)", "Invoice Amount"], portalLabel: "Invoice Amount (Issue)", control: "number", skipIfBlank: true },
  { key: "invoiceAmountCustoms", excelHeaders: ["Invoice Amount Confirmed By Customs", "Invoice Amount (Issue)", "Invoice Amount"], portalLabel: "Invoice Amount Confirmed By Customs", control: "number", skipIfBlank: true },

  // Other editable fields on the Export Acknowledgement form (from the live
  // screenshot). Located by label (ids not yet pinned); a field the form does not
  // expose as an editable input is logged for manual entry, never forced.
  { key: "quantity", excelHeaders: ["Quantity"], portalLabel: "Quantity", control: "number", skipIfBlank: true },
  { key: "portOfShipment", excelHeaders: ["Port of Shipment"], portalLabel: "Port of Shipment", control: "select", skipIfBlank: true },
  { key: "duplicatingBank", excelHeaders: ["Duplicating Bank"], portalLabel: "Duplicating Bank", control: "select", skipIfBlank: true },
  { key: "duplicatingBranch", excelHeaders: ["Duplicating Branch"], portalLabel: "Duplicating Branch", control: "select", skipIfBlank: true },
  { key: "sector", excelHeaders: ["Sector"], portalLabel: "Sector", control: "select", skipIfBlank: true },
  { key: "banksBillDate", excelHeaders: ["Bank's Bill Date", "Banks Bill Date"], portalLabel: "Bank's Bill Date", control: "date", skipIfBlank: true },
  { key: "banksBillNo", excelHeaders: ["Bank's Bill No.", "Bank's Bill No", "Banks Bill No"], portalLabel: "Bank's Bill No.", control: "text", skipIfBlank: true },
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
