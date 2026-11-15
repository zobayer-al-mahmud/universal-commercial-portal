/**
 * UD Automation — the 12-step workflow catalogue (pure config, no I/O).
 *
 * This is the single source of truth that drives the stepper UI, the manual-entry
 * forms, the import-preview mapping, and progress tracking. It encodes the
 * SRS + workflow data-source rules:
 *
 *   - Automatic population is restricted to uploaded Sales Contract + PI (SRS §4).
 *   - The BGMEA Excel auto-fill path is an ADDITIONAL, SEPARATE source (brief);
 *     which sections it supports is `excelSupport: "unconfirmed"` until the real
 *     factory workbook template is provided — we never invent a workbook format.
 *   - Steps/fields the SRS keeps manual (size chart, non-qty garment details,
 *     non-PI fabric/accessory fields, consumption) carry `autoSources: []`.
 *
 * The FIELD LISTS here are indicative commercial fields so the manual-entry forms
 * are usable today; the AUTHORITATIVE per-factory BGMEA field list, dropdowns and
 * validation messages are an open decision (Q-UD-09) and are pinned against the
 * confirmed portal form before any live use. Nothing here is auto-submitted.
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
  /** Repeating group (lien banks ×3, size rows, fabric/accessory rows, consumption rows). */
  group?: UdGroupDef;
  /** Does the BGMEA Excel auto-fill path apply here? Pending template confirmation. */
  excelSupport: "unconfirmed" | "yes" | "no";
  /** Can Sales Contract / PI PDF extraction populate any field in this step? */
  pdfExtract: boolean;
  /** SRS requires the whole step to be manual. */
  manualOnly: boolean;
  /** Special renderer: ud-select (step 1), btb (step 5), documents (step 12). */
  special?: "ud-select" | "btb" | "documents";
  fields: UdFieldDef[];
  pendingDecision?: string;
}

const SC: UdSource[] = ["sales-contract"];
const PI: UdSource[] = ["pi"];
const MANUAL: UdSource[] = [];

export const UD_STEPS: readonly UdStepDef[] = [
  {
    key: "ud-select",
    no: 1,
    title: "Open UD",
    dataSource: "Select an existing UD or start a new UD.",
    excelSupport: "no",
    pdfExtract: false,
    manualOnly: true,
    special: "ud-select",
    fields: [],
    pendingDecision: "Q-UD-03", // new-vs-existing UD criteria / amendment / approval
  },
  {
    key: "lien-bank",
    no: 2,
    title: "Lien Bank Information",
    dataSource: "Sales Contract — details of all 3 lien banks.",
    group: { label: "Lien bank", defaultCount: 3, min: 1, max: 3 },
    excelSupport: "unconfirmed",
    pdfExtract: true,
    manualOnly: false,
    fields: [
      { key: "bankName", label: "Bank name", type: "text", required: true, autoSources: SC },
      { key: "branch", label: "Branch", type: "text", autoSources: SC },
      { key: "address", label: "Address", type: "textarea", autoSources: SC },
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
    excelSupport: "unconfirmed",
    pdfExtract: true,
    manualOnly: false,
    fields: [
      { key: "buyerName", label: "Buyer name", type: "text", required: true, autoSources: SC },
      { key: "buyerAddress", label: "Buyer address", type: "textarea", autoSources: SC },
      { key: "buyerCountry", label: "Buyer country", type: "text", autoSources: SC },
      { key: "contactPerson", label: "Contact person", type: "text", autoSources: MANUAL, note: "Usually not in the Sales Contract — manual." },
    ],
  },
  {
    key: "export-lc",
    no: 4,
    title: "Export LC",
    dataSource: "Sales Contract (not all fields).",
    excelSupport: "unconfirmed",
    pdfExtract: true,
    manualOnly: false,
    fields: [
      { key: "lcNumber", label: "Export LC number", type: "text", required: true, autoSources: SC },
      { key: "lcDate", label: "LC date", type: "date", autoSources: SC },
      { key: "lcValue", label: "LC value", type: "text", autoSources: SC },
      { key: "currency", label: "Currency", type: "text", autoSources: SC },
      { key: "issuingBank", label: "Issuing bank", type: "text", autoSources: SC },
      { key: "expiryDate", label: "Expiry date", type: "date", autoSources: MANUAL },
      { key: "tenor", label: "Tenor", type: "text", autoSources: MANUAL },
    ],
  },
  {
    key: "btb-lc",
    no: 5,
    title: "BTB LC",
    dataSource: "Select a BTB LC linked to the selected UD, or create a new BTB LC.",
    excelSupport: "no",
    pdfExtract: false,
    manualOnly: true,
    special: "btb",
    fields: [],
    pendingDecision: "Q-UD-04", // BTB-LC↔UD linking / ERP sourcing / amendment mapping
  },
  {
    key: "notify-party",
    no: 6,
    title: "Notify Party",
    dataSource: "Sales Contract; verify against the Export Invoice when inconsistent.",
    excelSupport: "unconfirmed",
    pdfExtract: true,
    manualOnly: false,
    fields: [
      { key: "notifyName", label: "Notify party name", type: "text", required: true, autoSources: SC },
      { key: "notifyAddress", label: "Notify party address", type: "textarea", autoSources: SC },
      { key: "notifyCountry", label: "Country", type: "text", autoSources: SC },
    ],
    pendingDecision: "Q-UD-06", // Export Invoice use for notify-party verification (SRS source restriction)
  },
  {
    key: "port",
    no: 7,
    title: "Port",
    dataSource: "Sales Contract, if available; otherwise manual entry.",
    excelSupport: "unconfirmed",
    pdfExtract: true,
    manualOnly: false,
    fields: [
      { key: "portOfLoading", label: "Port of loading", type: "text", autoSources: SC },
      { key: "portOfDischarge", label: "Port of discharge", type: "text", autoSources: SC },
      { key: "placeOfDelivery", label: "Place of delivery", type: "text", autoSources: SC },
      { key: "finalDestination", label: "Final destination", type: "text", autoSources: SC },
    ],
  },
  {
    key: "garments",
    no: 8,
    title: "Garments",
    dataSource: "Quantity from the Sales Contract; remaining details manual.",
    excelSupport: "unconfirmed",
    pdfExtract: true,
    manualOnly: false,
    fields: [
      { key: "itemDescription", label: "Item description", type: "text", autoSources: MANUAL },
      { key: "category", label: "Category", type: "text", autoSources: MANUAL },
      { key: "gender", label: "Gender / group", type: "text", autoSources: MANUAL },
      { key: "hsCode", label: "HS code", type: "text", autoSources: MANUAL },
      { key: "quantityPcs", label: "Quantity (pcs)", type: "number", required: true, autoSources: SC, note: "Only eligible Sales Contract quantity is auto-filled (SRS)." },
      { key: "unitPrice", label: "Unit price", type: "number", autoSources: MANUAL },
    ],
  },
  {
    key: "size-chart",
    no: 9,
    title: "Size Chart",
    dataSource: "Manual entry.",
    group: { label: "Size row", defaultCount: 1, min: 1, max: 60 },
    excelSupport: "unconfirmed",
    pdfExtract: false,
    manualOnly: true,
    fields: [
      { key: "size", label: "Size", type: "text", required: true, autoSources: MANUAL },
      { key: "colour", label: "Colour", type: "text", autoSources: MANUAL },
      { key: "quantity", label: "Quantity", type: "number", autoSources: MANUAL },
    ],
  },
  {
    key: "fabric-accessories",
    no: 10,
    title: "Fabric & Accessories",
    dataSource: "PI fields only; remaining information manual.",
    group: { label: "Item", defaultCount: 1, min: 1, max: 100 },
    excelSupport: "unconfirmed",
    pdfExtract: true,
    manualOnly: false,
    fields: [
      { key: "itemType", label: "Type (fabric / accessory)", type: "text", autoSources: PI },
      { key: "description", label: "Description", type: "text", autoSources: PI },
      { key: "composition", label: "Composition", type: "text", autoSources: PI },
      { key: "quantity", label: "Quantity", type: "number", autoSources: PI },
      { key: "unit", label: "Unit", type: "text", autoSources: PI },
      { key: "unitPrice", label: "Unit price", type: "number", autoSources: PI },
    ],
  },
  {
    key: "consumption",
    no: 11,
    title: "Consumption",
    dataSource: "Manual entry; the ERP LC break-up may be used by the user as a reference.",
    group: { label: "Consumption row", defaultCount: 1, min: 1, max: 100 },
    excelSupport: "unconfirmed",
    pdfExtract: false,
    manualOnly: true,
    fields: [
      { key: "component", label: "Component", type: "text", required: true, autoSources: MANUAL },
      { key: "description", label: "Description", type: "text", autoSources: MANUAL },
      { key: "consumptionPerUnit", label: "Consumption / unit", type: "text", autoSources: MANUAL },
      { key: "unit", label: "Unit", type: "text", autoSources: MANUAL },
      { key: "totalConsumption", label: "Total consumption", type: "text", autoSources: MANUAL },
    ],
    pendingDecision: "Q-UD-11", // ERP LC break-up as a source (~30% incorrect per workflow doc)
  },
  {
    key: "documents",
    no: 12,
    title: "Document Upload",
    dataSource: "Upload the required supporting documents.",
    excelSupport: "no",
    pdfExtract: false,
    manualOnly: true,
    special: "documents",
    fields: [],
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
