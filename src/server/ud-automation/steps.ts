/**
 * UD Automation — the 12-step workflow catalogue (pure config, no I/O).
 *
 * This is the single source of truth that drives the stepper UI, the manual-entry
 * forms, the import-preview mapping, and progress tracking. It encodes the
 * SRS + workflow data-source rules:
 *
 *   - Automatic population from documents is restricted to uploaded Sales Contract + PI (SRS §4).
 *   - The BGMEA Excel auto-fill path is an ADDITIONAL, SEPARATE source (brief);
 *     which sections it supports is `excelSupport: "unconfirmed"` until the real
 *     factory workbook template is provided — we never invent a workbook format.
 *   - A BGMEA portal FETCH ("bgmea-portal") reads the selected UD's existing data
 *     from BGMEA. It is staged as a review-before-apply preview like every import;
 *     it never overwrites a user-edited value without an explicit choice.
 *
 * Field lists mirror the BGMEA "Digital UD Automation" forms, mapped from the live
 * portal on 2026-11-16 (see portal-map.ts for the portal-key → field-key map).
 * Nothing here is auto-submitted.
 */

export type UdSource = "manual" | "sales-contract" | "pi" | "export-invoice" | "bgmea-excel" | "bgmea-portal";

export interface UdFieldDef {
  key: string;
  label: string;
  type: "text" | "number" | "date" | "textarea";
  required?: boolean;
  /** Sources permitted to AUTO-FILL this field. [] ⇒ manual only (SRS-mandated). */
  autoSources: UdSource[];
  note?: string;
}

export interface UdGroupDef {
  label: string;
  defaultCount: number;
  min: number;
  max: number;
}

export interface UdStepDef {
  key: string;
  no: number; // 1..12
  title: string;
  dataSource: string; // human description from the SRS/workflow table
  /** Repeating group (lien banks ×3, garments, size rows, fabric/accessory rows, …). */
  group?: UdGroupDef;
  /** Does the BGMEA Excel auto-fill path apply here? Pending template confirmation. */
  excelSupport: "unconfirmed" | "yes" | "no";
  /** Can Sales Contract / PI PDF extraction populate any field in this step? */
  pdfExtract: boolean;
  /** SRS requires the whole step to be manual (BGMEA fetch may still read existing values). */
  manualOnly: boolean;
  /** Special renderer: ud-select (step 1), btb (step 5), documents (step 12). */
  special?: "ud-select" | "btb" | "documents";
  fields: UdFieldDef[];
  pendingDecision?: string;
}

const SC: UdSource[] = ["sales-contract"];
const MANUAL: UdSource[] = [];
/** Read from the BGMEA portal (fetch) — still reviewed before it is applied. */
const BGMEA: UdSource[] = ["bgmea-portal"];
const SC_BG: UdSource[] = ["sales-contract", "bgmea-portal"];
const PI_BG: UdSource[] = ["pi", "bgmea-portal"];

export const UD_STEPS: readonly UdStepDef[] = [
  {
    key: "ud-select",
    no: 1,
    title: "Open UD",
    dataSource: "Select an existing UD from the factory catalog or start a new UD. BGMEA fetch reads the UD Information page.",
    excelSupport: "no",
    pdfExtract: false,
    manualOnly: true,
    special: "ud-select",
    fields: [
      { key: "trackingNo", label: "UD tracking no", type: "text", autoSources: BGMEA },
      { key: "udNo", label: "UD no", type: "text", autoSources: BGMEA },
      { key: "udDate", label: "UD date", type: "date", autoSources: BGMEA },
      { key: "applicationNo", label: "Application no", type: "text", autoSources: BGMEA },
      { key: "applicationDate", label: "Application date", type: "date", autoSources: BGMEA },
      { key: "factoryType", label: "Factory type", type: "text", autoSources: BGMEA },
      { key: "membershipNo", label: "Membership no", type: "text", autoSources: BGMEA },
      { key: "factoryName", label: "Factory name", type: "text", autoSources: BGMEA },
      { key: "factoryAddress", label: "Factory address", type: "textarea", autoSources: BGMEA },
      { key: "factoryPhone", label: "Factory phone", type: "text", autoSources: BGMEA },
      { key: "headOfficeAddress", label: "Head office address", type: "textarea", autoSources: BGMEA },
      { key: "headOfficePhone", label: "Head office phone", type: "text", autoSources: BGMEA },
      { key: "bondLicenseNo", label: "Bond license no", type: "text", autoSources: BGMEA },
      { key: "bondLicenseDate", label: "Bond license date", type: "date", autoSources: BGMEA },
      { key: "vatRegNo", label: "VAT reg. no", type: "text", autoSources: BGMEA },
      { key: "vatRegDate", label: "VAT reg. date", type: "date", autoSources: BGMEA },
      { key: "videLetterNo", label: "Vide letter no", type: "text", autoSources: BGMEA },
      { key: "videLetterDate", label: "Vide letter date", type: "date", autoSources: BGMEA },
      { key: "shipmentDate", label: "UD shipment date", type: "date", autoSources: BGMEA },
      { key: "reviewStatus", label: "BGMEA review status", type: "text", autoSources: BGMEA, note: "Read from BGMEA. BGMEA allows saving pages only while the UD is NEW, DISCREPANCY or CORRECTION." },
      { key: "reviewRemarks", label: "BGMEA review remarks", type: "textarea", autoSources: BGMEA },
      { key: "paymentStatus", label: "BGMEA payment status", type: "text", autoSources: BGMEA },
    ],
    pendingDecision: "Q-UD-03", // new-vs-existing UD criteria / amendment / approval
  },
  {
    key: "lien-bank",
    no: 2,
    title: "Lien Bank Information",
    dataSource: "Sales Contract — details of all 3 lien banks.",
    group: { label: "Lien bank", defaultCount: 1, min: 1, max: 3 },
    excelSupport: "unconfirmed",
    pdfExtract: true,
    manualOnly: false,
    fields: [
      { key: "bankId", label: "BGMEA bank id", type: "text", autoSources: BGMEA, note: "The bank id BGMEA lists for this member (branch-specific code)." },
      { key: "bankName", label: "Bank name", type: "text", required: true, autoSources: SC_BG },
      { key: "branch", label: "Branch", type: "text", autoSources: SC },
      { key: "address", label: "Address", type: "textarea", autoSources: SC_BG },
      { key: "phone", label: "Phone", type: "text", autoSources: BGMEA },
      { key: "fax", label: "Fax", type: "text", autoSources: BGMEA },
      { key: "lienAmount", label: "Lien amount", type: "text", autoSources: SC },
      { key: "lienDate", label: "Lien date", type: "date", autoSources: SC },
      { key: "reference", label: "Reference / remarks", type: "text", autoSources: SC },
    ],
  },
  {
    key: "buyer",
    no: 3,
    title: "Buyer Information",
    dataSource: "Sales Contract (not all fields).",
    group: { label: "Buyer", defaultCount: 1, min: 1, max: 10 },
    excelSupport: "unconfirmed",
    pdfExtract: true,
    manualOnly: false,
    fields: [
      { key: "buyerId", label: "BGMEA buyer id", type: "text", autoSources: BGMEA },
      { key: "buyerName", label: "Buyer name", type: "text", required: true, autoSources: SC_BG },
      { key: "buyerAddress", label: "Buyer address", type: "textarea", autoSources: SC_BG },
      { key: "address1", label: "Address 1", type: "text", autoSources: BGMEA },
      { key: "address2", label: "Address 2", type: "text", autoSources: BGMEA },
      { key: "city", label: "City", type: "text", autoSources: BGMEA },
      { key: "state", label: "State", type: "text", autoSources: BGMEA },
      { key: "zipCode", label: "Zip code", type: "text", autoSources: BGMEA },
      { key: "buyerCountry", label: "Buyer country", type: "text", autoSources: SC_BG },
      { key: "phone", label: "Phone", type: "text", autoSources: BGMEA },
      { key: "fax", label: "Fax", type: "text", autoSources: BGMEA },
      { key: "email", label: "Email", type: "text", autoSources: BGMEA },
      { key: "contactPerson", label: "Contact person", type: "text", autoSources: MANUAL, note: "Usually not in the Sales Contract — manual." },
    ],
  },
  {
    key: "export-lc",
    no: 4,
    title: "Export LC",
    dataSource: "Sales Contract (not all fields).",
    group: { label: "Export LC", defaultCount: 1, min: 1, max: 10 },
    excelSupport: "unconfirmed",
    pdfExtract: true,
    manualOnly: false,
    fields: [
      { key: "lcType", label: "Type", type: "text", autoSources: BGMEA, note: "BGMEA options include Master Export L/C, Contract, Purchase Order, TT." },
      { key: "lcNumber", label: "Export LC number", type: "text", required: true, autoSources: SC_BG },
      { key: "lcDate", label: "LC date", type: "date", autoSources: SC_BG },
      { key: "issuingBank", label: "Bank", type: "text", autoSources: SC_BG },
      { key: "lcValue", label: "LC value", type: "text", autoSources: SC_BG },
      { key: "usedValue", label: "Used LC value", type: "text", autoSources: BGMEA },
      { key: "tolerance", label: "Tolerance (%)", type: "text", autoSources: BGMEA },
      { key: "currency", label: "Currency", type: "text", autoSources: SC_BG },
      { key: "shipmentDate", label: "Shipment date", type: "date", autoSources: BGMEA },
      { key: "expiryDate", label: "Expiry date", type: "date", autoSources: BGMEA },
      { key: "remarks", label: "Remarks", type: "textarea", autoSources: BGMEA },
      { key: "tenor", label: "Tenor", type: "text", autoSources: MANUAL },
    ],
  },
  {
    key: "btb-lc",
    no: 5,
    title: "BTB LC",
    dataSource: "BTB / import L/Cs linked to the selected UD (BGMEA \"Import L/C\" page), or record a new BTB LC.",
    group: { label: "BTB / import LC", defaultCount: 1, min: 1, max: 100 },
    excelSupport: "no",
    pdfExtract: false,
    manualOnly: false,
    special: "btb",
    fields: [
      { key: "lcType", label: "Type", type: "text", autoSources: BGMEA, note: "e.g. Back to Back L/C (B2B), B.B Ref No, Sight L/C, Usance L/C." },
      { key: "origin", label: "Origin", type: "text", autoSources: BGMEA, note: "Foreign / Local" },
      { key: "bank", label: "Bank", type: "text", autoSources: BGMEA },
      { key: "lcNumber", label: "LC number", type: "text", autoSources: BGMEA },
      { key: "lcDate", label: "LC date", type: "date", autoSources: BGMEA },
      { key: "lcValue", label: "LC value", type: "text", autoSources: BGMEA },
      { key: "usedValue", label: "Used LC value", type: "text", autoSources: BGMEA },
      { key: "tolerance", label: "Tolerance", type: "text", autoSources: BGMEA },
      { key: "currency", label: "Currency", type: "text", autoSources: BGMEA },
      { key: "exportLcNo", label: "Linked export LC", type: "text", autoSources: BGMEA },
      { key: "remarks", label: "Remarks", type: "text", autoSources: BGMEA },
    ],
    pendingDecision: "Q-UD-04", // BTB-LC↔UD linking / ERP sourcing / amendment mapping
  },
  {
    key: "notify-party",
    no: 6,
    title: "Notify Party",
    dataSource: "Sales Contract; verify against the Export Invoice when inconsistent.",
    group: { label: "Notify party", defaultCount: 1, min: 1, max: 10 },
    excelSupport: "unconfirmed",
    pdfExtract: true,
    manualOnly: false,
    fields: [
      { key: "notifyName", label: "Notify party name", type: "text", required: true, autoSources: SC_BG },
      { key: "notifyAddress", label: "Notify party address", type: "textarea", autoSources: SC_BG },
      { key: "notifyCountry", label: "Country", type: "text", autoSources: SC_BG },
      { key: "fax", label: "Fax", type: "text", autoSources: BGMEA },
      { key: "email", label: "Email", type: "text", autoSources: BGMEA },
    ],
    pendingDecision: "Q-UD-06", // Export Invoice use for notify-party verification (SRS source restriction)
  },
  {
    key: "port",
    no: 7,
    title: "Port",
    dataSource: "Sales Contract, if available; otherwise manual entry.",
    group: { label: "Port", defaultCount: 1, min: 1, max: 10 },
    excelSupport: "unconfirmed",
    pdfExtract: true,
    manualOnly: false,
    fields: [
      { key: "portOfLoading", label: "Port of loading", type: "text", autoSources: SC },
      { key: "portOfDischarge", label: "Port of discharge (BGMEA port name)", type: "text", autoSources: SC_BG },
      { key: "portCode", label: "Port code", type: "text", autoSources: BGMEA },
      { key: "portCountry", label: "Port country", type: "text", autoSources: BGMEA },
      { key: "placeOfDelivery", label: "Place of delivery", type: "text", autoSources: SC },
      { key: "finalDestination", label: "Ultimate destination", type: "text", autoSources: SC_BG },
    ],
  },
  {
    key: "garments",
    no: 8,
    title: "Garments",
    dataSource: "Quantity from the Sales Contract; remaining details manual or read from BGMEA.",
    group: { label: "Garment", defaultCount: 1, min: 1, max: 300 },
    excelSupport: "unconfirmed",
    pdfExtract: true,
    manualOnly: false,
    fields: [
      { key: "exportLcNo", label: "Export L/C / Contract / P.O", type: "text", autoSources: BGMEA },
      { key: "styleNo", label: "Style no", type: "text", autoSources: BGMEA },
      { key: "hsCode", label: "HS code", type: "text", autoSources: BGMEA },
      { key: "itemDescription", label: "Description", type: "text", autoSources: BGMEA },
      { key: "category", label: "Category", type: "text", autoSources: MANUAL },
      { key: "gender", label: "Gender / group", type: "text", autoSources: MANUAL },
      { key: "quantityPcs", label: "Quantity", type: "number", required: true, autoSources: SC_BG, note: "From a Sales Contract only the eligible quantity is auto-filled (SRS)." },
      { key: "usedQuantity", label: "Used quantity", type: "number", autoSources: BGMEA },
      { key: "balance", label: "Balance", type: "number", autoSources: BGMEA },
      { key: "unit", label: "Unit", type: "text", autoSources: BGMEA },
      { key: "unitPrice", label: "Unit price", type: "number", autoSources: BGMEA },
      { key: "totalPrice", label: "Total price", type: "number", autoSources: BGMEA },
      { key: "averageUnitPrice", label: "Average unit price", type: "number", autoSources: BGMEA },
      { key: "currency", label: "Currency", type: "text", autoSources: BGMEA },
    ],
  },
  {
    key: "size-chart",
    no: 9,
    title: "Size Chart",
    dataSource: "Manual entry, or read from the BGMEA measurement chart (one row per measurement line).",
    group: { label: "Size row", defaultCount: 1, min: 1, max: 300 },
    excelSupport: "unconfirmed",
    pdfExtract: false,
    manualOnly: true,
    fields: [
      { key: "chartNo", label: "Chart no", type: "text", autoSources: BGMEA },
      { key: "styleNos", label: "Style no(s)", type: "text", autoSources: BGMEA },
      { key: "measurement", label: "Measurement / description", type: "text", autoSources: BGMEA },
      { key: "sizeValues", label: "Values by size", type: "textarea", autoSources: BGMEA, note: "Size header → value, in BGMEA column order." },
      { key: "size", label: "Size", type: "text", autoSources: MANUAL },
      { key: "colour", label: "Colour", type: "text", autoSources: MANUAL },
      { key: "quantity", label: "Quantity", type: "number", autoSources: MANUAL },
    ],
  },
  {
    key: "fabric-accessories",
    no: 10,
    title: "Fabric & Accessories",
    dataSource: "PI fields only; remaining information manual or read from BGMEA (Fabric, Accessories, Other Material).",
    group: { label: "Item", defaultCount: 1, min: 1, max: 500 },
    excelSupport: "unconfirmed",
    pdfExtract: true,
    manualOnly: false,
    fields: [
      { key: "itemType", label: "Type (fabric / accessory / other)", type: "text", autoSources: PI_BG },
      { key: "origin", label: "Origin", type: "text", autoSources: BGMEA },
      { key: "importLcNo", label: "Import (BTB) L/C no", type: "text", autoSources: BGMEA },
      { key: "hsCode", label: "HS code", type: "text", autoSources: BGMEA },
      { key: "description", label: "Description", type: "text", autoSources: PI_BG },
      { key: "composition", label: "Construction / trade name", type: "text", autoSources: PI_BG },
      { key: "quantity", label: "Quantity", type: "number", autoSources: PI_BG },
      { key: "usedQuantity", label: "Used quantity", type: "number", autoSources: BGMEA },
      { key: "balance", label: "Balance", type: "number", autoSources: BGMEA },
      { key: "unit", label: "Unit", type: "text", autoSources: PI_BG },
      { key: "unitPrice", label: "Unit price", type: "number", autoSources: PI_BG },
      { key: "currency", label: "Currency", type: "text", autoSources: BGMEA },
      { key: "netWeight", label: "Net weight (kg)", type: "number", autoSources: BGMEA },
      { key: "supplierName", label: "Supplier name", type: "text", autoSources: BGMEA },
      { key: "supplierAddress", label: "Supplier address", type: "textarea", autoSources: BGMEA },
      { key: "supplierCountry", label: "Supplier country", type: "text", autoSources: BGMEA },
      { key: "phone", label: "Phone", type: "text", autoSources: BGMEA },
      { key: "remarks", label: "Remarks", type: "text", autoSources: BGMEA },
    ],
  },
  {
    key: "consumption",
    no: 11,
    title: "Consumption",
    dataSource: "Manual entry, or read from BGMEA (one row per consumption fabric line, linked to its styles).",
    group: { label: "Consumption row", defaultCount: 1, min: 1, max: 300 },
    excelSupport: "unconfirmed",
    pdfExtract: false,
    manualOnly: true,
    fields: [
      { key: "consumptionNo", label: "Consumption no", type: "text", autoSources: BGMEA },
      { key: "styleNos", label: "Style(s) and quantity", type: "textarea", autoSources: BGMEA },
      { key: "component", label: "Component (fabric HS code)", type: "text", required: true, autoSources: BGMEA },
      { key: "description", label: "Fabric description", type: "text", autoSources: BGMEA },
      { key: "tradeName", label: "Construction / trade name", type: "text", autoSources: BGMEA },
      { key: "fabricSource", label: "Fabric source", type: "text", autoSources: BGMEA },
      { key: "consumptionPerUnit", label: "Consumption / unit", type: "text", autoSources: MANUAL },
      { key: "unit", label: "Unit", type: "text", autoSources: BGMEA },
      { key: "totalConsumption", label: "Fabric quantity used", type: "text", autoSources: BGMEA },
      { key: "baseQuantity", label: "Fabric base quantity", type: "text", autoSources: BGMEA },
      { key: "fabricBalance", label: "Fabric balance", type: "text", autoSources: BGMEA },
    ],
    pendingDecision: "Q-UD-11", // ERP LC break-up as a source (~30% incorrect per workflow doc)
  },
  {
    key: "documents",
    no: 12,
    title: "Document Upload",
    dataSource: "Upload the required supporting documents. BGMEA fetch lists the documents already uploaded to the UD.",
    group: { label: "BGMEA document", defaultCount: 1, min: 1, max: 50 },
    excelSupport: "no",
    pdfExtract: false,
    manualOnly: true,
    special: "documents",
    fields: [
      { key: "docType", label: "BGMEA document type", type: "text", autoSources: BGMEA },
      { key: "uploadedAt", label: "Uploaded at (BGMEA)", type: "text", autoSources: BGMEA },
      { key: "fileRef", label: "BGMEA file", type: "text", autoSources: BGMEA },
    ],
    pendingDecision: "Q-UD-07", // authoritative list of the 8 supporting docs + file constraints
  },
] as const;

const STEP_BY_KEY = new Map(UD_STEPS.map((s) => [s.key, s]));

export function stepByKey(key: string): UdStepDef | undefined {
  return STEP_BY_KEY.get(key);
}

export function fieldDef(stepKey: string, fieldKey: string): UdFieldDef | undefined {
  return STEP_BY_KEY.get(stepKey)?.fields.find((f) => f.key === fieldKey);
}

/** The ordered step keys, for progress + navigation. */
export const UD_STEP_KEYS: readonly string[] = UD_STEPS.map((s) => s.key);
