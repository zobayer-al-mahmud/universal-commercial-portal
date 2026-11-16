/**
 * BGMEA "Digital UD Automation" portal map — PURE (no I/O), unit-testable.
 *
 * Mapped from the live portal (bgmea.org) on 2026-11-16 by inspecting, read-only,
 * every UD sub-page for UD10952026004 (factory 1095) and the portal's public JS
 * bundle. Evidence summary (see docs/modules/ud-automation.md §BGMEA portal map):
 *
 *   - The portal is a Vue 2 app. Each UD sub-page mounts ONE page component (e.g.
 *     `garments-info`) whose `$data.list` holds every row of the selected UD with
 *     ALL its fields (ids, codes and names) — more complete than the visible table,
 *     and every row carries `UDTrackingNo`, so rows can be verified against the UD.
 *   - The selected UD lives in the server session; the `nav-menu` component exposes
 *     it as `udTrackingNo`. Selecting a UD = clicking its row on `/UD`.
 *   - Shared form actions (bundle "FormActions"): `.form-style__btn-new` ("New"),
 *     `.form-style__btn-save` (label "Update" when a row is selected, else "Save"),
 *     `.form-style__btn-delete`. Save/Delete render only when `canEdit` — i.e. the UD
 *     ReviewStatusId is empty / NEW(0) / DISCRIPENCY(45) / CORRECTION(50).
 *   - Save opens a confirm box (OK titled "Save"/"Update"); a failure shows a
 *     message box (okVariant "danger") with the server message; success re-reads.
 *
 * This file holds:
 *   1. READ map — per portal page: route, component, which data to read, how each
 *      portal key maps to a UCP field (with code→label resolution via the page's own
 *      dropdowns), and which keys are system/audit keys (ignored). Anything else with
 *      a value is reported as UNMAPPED — never guessed.
 *   2. WRITE map — per writable page: the form label for each UCP field and how a
 *      UCP row is matched to an existing portal row.
 *   3. Pure helpers: value normalisation, row → DetectedValue mapping, write diffing.
 */

import type { DetectedValue } from "./types";

// ---------------------------------------------------------------------------
// Review status (bundle constant `Y`)
// ---------------------------------------------------------------------------

export const BGMEA_REVIEW_STATUS = {
  NEW: 0,
  SUBMITTED: 5,
  DISCREPANCY: 45,
  CORRECTION: 50,
  PASSED_DISPATCHED: 55,
} as const;

/** Mirrors the portal's own `canEdit`: editable when status is empty/NEW/DISCREPANCY/CORRECTION. */
export function isUdEditable(reviewStatusId: number | null | undefined): boolean {
  if (reviewStatusId === null || reviewStatusId === undefined) return true;
  return (
    reviewStatusId === BGMEA_REVIEW_STATUS.NEW ||
    reviewStatusId === BGMEA_REVIEW_STATUS.DISCREPANCY ||
    reviewStatusId === BGMEA_REVIEW_STATUS.CORRECTION
  );
}

/** A UD tracking number must belong to the factory: `UD` + factory id + digits. */
export function udBelongsToFactory(udNumber: string, factoryId: string): boolean {
  const ud = (udNumber || "").trim().toUpperCase();
  return /^\d{3,5}$/.test(factoryId) && new RegExp(`^UD${factoryId}\\d{4,}$`).test(ud);
}

// ---------------------------------------------------------------------------
// Value helpers
// ---------------------------------------------------------------------------

export type PortalRow = Record<string, unknown>;

/** Portal values arrive as strings, numbers, null or the literal "null". */
export function cleanValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return "";
  const s = String(v)
    .replace(/&nbsp;/gi, " ")
    .replace(/ /g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (s === "null" || s === "undefined") return "";
  return s;
}

/** Normalise a portal date (ISO, ISO datetime, or dd/mm/yyyy) to yyyy-mm-dd; "" if not a date. */
export function cleanDate(v: unknown): string {
  const s = cleanValue(v);
  if (!s) return "";
  if (s.startsWith("0001-01-01")) return ""; // .NET default/empty date
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dmy = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
  return "";
}

export function normLabel(s: string): string {
  return (s || "").replace(/\*/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** Options of one portal dropdown, keyed by option value → display label. */
export interface PortalDropdown {
  label: string;
  options: { value: string; label: string }[];
}

/** Resolve a coded value (e.g. CurrencyID 201201) via the first dropdown whose label matches. */
export function resolveCode(code: string, dropdownLabel: string, dropdowns: PortalDropdown[]): string {
  if (!code) return "";
  const want = normLabel(dropdownLabel);
  for (const d of dropdowns) {
    if (!normLabel(d.label).includes(want)) continue;
    const hit = d.options.find((o) => o.value === code);
    if (hit && hit.label) return hit.label;
  }
  return "";
}

// ---------------------------------------------------------------------------
// READ map
// ---------------------------------------------------------------------------

export interface ReadContext {
  udNumber: string;
  dropdowns: PortalDropdown[];
  /** Extra arrays read from the component (e.g. `portlist`), by prop name. */
  extra: Record<string, PortalRow[]>;
}

export interface FieldRead {
  /** UCP field key in the section's step. */
  field: string;
  /** Portal key read from the row (also recorded in the sourceRef). */
  key: string;
  /** Treat as a date (normalised to yyyy-mm-dd). */
  date?: boolean;
  /** If the row value is empty, resolve `codeKey` through the dropdown whose label contains `via`. */
  fallback?: { codeKey: string; via: string };
  /** Custom derivation (pure). */
  derive?: (row: PortalRow, ctx: ReadContext) => string;
}

export interface PortalSectionRead {
  /** Stable id of the portal page in this map. */
  id: string;
  /** UCP step this page fills. */
  stepKey: string;
  /** Display title (UCP section · portal page). */
  title: string;
  /** Portal route (relative to the portal origin). */
  path: string;
  /** Vue page component name. */
  component: string;
  /** Where the rows live on the component: `$data[prop]` (or `$props[prop]`). `single` = an object, not an array. */
  source: { prop: string; single?: boolean };
  /** Extra component arrays the mapping needs (copied into ctx.extra). */
  extraProps?: string[];
  /** Row id key (for traceability + write matching). */
  rowIdKey?: string;
  /** Row-level UD key; rows whose value differs from the selected UD are rejected + flagged. */
  udKey?: string;
  /** Expand one portal row into several UCP group rows (size-chart lines, consumption fabric lines). */
  expand?: (row: PortalRow, ctx: ReadContext) => { ref: string; values: Record<string, string>; keysUsed: string[] }[];
  /** Constant values for every row (e.g. itemType = Fabric). */
  constants?: Record<string, string>;
  fields: FieldRead[];
  /** System/audit/code keys intentionally not mapped (not reported as unmapped). */
  ignore: string[];
  /** When true, rows are reported but NOT mapped (no confirmed sample yet). */
  unconfirmedRows?: boolean;
}

const AUDIT = ["Entryby", "EntryDate", "UpdatedBy", "UpdatedDate", "EntryBy"];

const ORIGIN_LABEL: Record<string, string> = { N: "Foreign", Y: "Local" };

export const PORTAL_SECTIONS: readonly PortalSectionRead[] = [
  {
    id: "ud-info",
    stepKey: "ud-select",
    title: "Open UD · UD Information",
    path: "/UD",
    component: "new-ud",
    source: { prop: "model", single: true },
    rowIdKey: "UDTrackingNo",
    udKey: "UDTrackingNo",
    fields: [
      { field: "trackingNo", key: "UDTrackingNo" },
      { field: "udNo", key: "UDNo" },
      { field: "udDate", key: "UDDate", date: true },
      { field: "applicationNo", key: "ApplicationNo" },
      { field: "applicationDate", key: "ApplicationDate", date: true },
      { field: "factoryType", key: "FactoryType" },
      { field: "membershipNo", key: "MembershipID" },
      { field: "factoryName", key: "FactoryName" },
      { field: "factoryAddress", key: "FactoryAddress" },
      { field: "factoryPhone", key: "FactoryPhoneNo" },
      { field: "headOfficeAddress", key: "HeadOfficeAddress" },
      { field: "headOfficePhone", key: "HeadOfficePhone" },
      { field: "bondLicenseNo", key: "BLNo" },
      { field: "bondLicenseDate", key: "BLDate", date: true },
      { field: "vatRegNo", key: "VatRegNo" },
      { field: "vatRegDate", key: "VatRegDate", date: true },
      { field: "videLetterNo", key: "VideLetterNo" },
      { field: "videLetterDate", key: "VideLetterDate", date: true },
      { field: "shipmentDate", key: "ShipmentDate", date: true },
      { field: "reviewStatus", key: "ReviewStatusName" },
      { field: "reviewRemarks", key: "ReviewRemarks" },
      { field: "paymentStatus", key: "PaymentStatus" },
    ],
    ignore: [...AUDIT, "UDNoPrefix", "UDNoPostfix", "UDRefFactoryPrefix", "UDRefSLNo", "UDRefDate", "IsFinalized", "MembershipYear", "ReviewStatusId", "ReviewHistory", "GovtStatus"],
  },
  {
    id: "lien-bank",
    stepKey: "lien-bank",
    title: "Lien Bank",
    path: "/UDLienBank",
    component: "ud-lien-bank-info",
    source: { prop: "list" },
    rowIdKey: "BankId",
    fields: [
      { field: "bankId", key: "BranchSpecificCode" },
      { field: "bankName", key: "BankName" },
    ],
    ignore: [...AUDIT, "BankId"],
  },
  {
    id: "buyer",
    stepKey: "buyer",
    title: "Buyer",
    path: "/UDBuyer",
    component: "ud-buyer",
    source: { prop: "list" },
    rowIdKey: "BuyerID",
    fields: [
      { field: "buyerId", key: "BuyerID" },
      { field: "buyerName", key: "BuyerName" },
      { field: "buyerAddress", key: "BuyerAddress" },
      { field: "address1", key: "Address1" },
      { field: "address2", key: "Address2" },
      { field: "city", key: "City" },
      { field: "state", key: "State" },
      { field: "zipCode", key: "ZipCode" },
      { field: "buyerCountry", key: "CountryName" },
      { field: "phone", key: "PhoneNo" },
      { field: "fax", key: "FaxNo" },
      { field: "email", key: "EmailNo" },
    ],
    ignore: [...AUDIT, "FraudFlag", "BGMEABuyerID", "CountryCode", "RId"],
  },
  {
    id: "export-lc",
    stepKey: "export-lc",
    title: "Export L/C",
    path: "/ExportLC",
    component: "export-lc",
    source: { prop: "list" },
    rowIdKey: "ExportLCID",
    udKey: "UDTrackingNo",
    fields: [
      { field: "lcType", key: "ExportLCTypeText", fallback: { codeKey: "ExportLCTypeID", via: "type" } },
      { field: "lcNumber", key: "ExportLCNo" },
      { field: "lcDate", key: "LCDate", date: true },
      { field: "issuingBank", key: "BankName", fallback: { codeKey: "BankID", via: "bank" } },
      { field: "lcValue", key: "LCValue" },
      { field: "usedValue", key: "LCUseValue" },
      { field: "tolerance", key: "Tolerance" },
      { field: "currency", key: "CurrencyName", fallback: { codeKey: "CurrencyID", via: "currency" } },
      { field: "shipmentDate", key: "ShipmentDate", date: true },
      { field: "expiryDate", key: "ExpiryDate", date: true },
      { field: "remarks", key: "Remarks" },
    ],
    ignore: [...AUDIT, "UDTrackingNo", "ExportLCID", "ExportLCTypeID", "BankID", "CurrencyID", "LCDateStr", "ShipmentDateStr", "ExpiryDateStr", "LCValueStr", "LCUseValueStr"],
  },
  {
    id: "import-lc",
    stepKey: "btb-lc",
    title: "BTB LC · Import L/C",
    path: "/ImportLC",
    component: "import-lc",
    source: { prop: "list" },
    rowIdKey: "ImportLCID",
    udKey: "UDTrackingNo",
    fields: [
      { field: "lcType", key: "ImportLCTypeName", fallback: { codeKey: "ImportLCTypeID", via: "type" } },
      { field: "origin", key: "Origin", derive: (r) => cleanValue(r.Origin) || ORIGIN_LABEL[cleanValue(r.IsLocal)] || "" },
      { field: "bank", key: "BankName", fallback: { codeKey: "BankID", via: "bank" } },
      { field: "lcNumber", key: "ImportLCNo" },
      { field: "lcDate", key: "LCDate", date: true },
      { field: "lcValue", key: "LCValue" },
      { field: "usedValue", key: "LCUseValue" },
      { field: "tolerance", key: "Tolerance" },
      { field: "currency", key: "CurrencyName", fallback: { codeKey: "CurrencyID", via: "currency" } },
      { field: "exportLcNo", key: "ExportLcNo" },
      { field: "remarks", key: "Remarks" },
    ],
    ignore: [...AUDIT, "UDTrackingNo", "ImportLCID", "ImportLCTypeID", "IsLocal", "OriginName", "BankID", "CurrencyID"],
  },
  {
    id: "notify-party",
    stepKey: "notify-party",
    title: "Notify Party",
    path: "/NotifyParty",
    component: "notify-party",
    source: { prop: "list" },
    rowIdKey: "NotifyID",
    udKey: "UDTrackingNo",
    fields: [
      { field: "notifyName", key: "NotifyName" },
      { field: "notifyAddress", key: "NotifyAddress" },
      { field: "notifyCountry", key: "CountryName", fallback: { codeKey: "CountryID", via: "country" } },
      { field: "fax", key: "FaxNo" },
      { field: "email", key: "EmailAddress" },
    ],
    ignore: [...AUDIT, "UDTrackingNo", "NotifyID", "CountryID"],
  },
  {
    id: "port",
    stepKey: "port",
    title: "Port",
    path: "/UDPort",
    component: "ud-port",
    source: { prop: "list" },
    extraProps: ["portlist"],
    rowIdKey: "PortID",
    udKey: "UDTrackingNo",
    fields: [
      { field: "portOfDischarge", key: "PortName" },
      {
        field: "portCode",
        key: "PortName",
        // The UD's port rows carry no code; the member's port master list (portlist) does.
        derive: (r, ctx) => {
          const name = cleanValue(r.PortName).toLowerCase();
          const hits = (ctx.extra.portlist ?? []).filter((p) => cleanValue(p.PortName).toLowerCase() === name);
          return hits.length === 1 ? cleanValue(hits[0].PortCode) : "";
        },
      },
      { field: "portCountry", key: "PortCountryName" },
      { field: "finalDestination", key: "DestinationCountryName" },
    ],
    ignore: [...AUDIT, "UDTrackingNo", "PortID"],
  },
  {
    id: "garments",
    stepKey: "garments",
    title: "Garments",
    path: "/GarmentsInfo",
    component: "garments-info",
    source: { prop: "list" },
    rowIdKey: "GarmentsID",
    udKey: "UDTrackingNo",
    fields: [
      { field: "exportLcNo", key: "ExportLCNo" },
      { field: "styleNo", key: "StyleNo" },
      { field: "hsCode", key: "HSID" },
      { field: "itemDescription", key: "HSDescription" },
      { field: "quantityPcs", key: "Qty" },
      { field: "usedQuantity", key: "UseQty" },
      { field: "balance", key: "Balance" },
      { field: "unit", key: "MUnitName", fallback: { codeKey: "MUnitID", via: "unit" } },
      { field: "unitPrice", key: "UnitPrice" },
      { field: "totalPrice", key: "TotalPriceValue" },
      { field: "averageUnitPrice", key: "AverageUnitPrice" },
      { field: "currency", key: "CurrencyName", fallback: { codeKey: "CurrencyID", via: "currency" } },
    ],
    ignore: [...AUDIT, "UDTrackingNo", "GarmentsID", "MUnitID", "CurrencyID", "MemberHsId"],
  },
  {
    id: "size-chart",
    stepKey: "size-chart",
    title: "Size Chart",
    path: "/UDMeasurementChart",
    component: "measurement-chart",
    source: { prop: "localSizeMeasurementMainInfo" },
    rowIdKey: "SizeMeasurementMainID",
    udKey: "UDTrackingNo",
    // One portal chart (a style group + a rows×columns grid, row0 = size headers)
    // becomes one UCP row per measurement line, keeping the chart no + styles.
    expand: (row) => {
      const table = (row.Table && typeof row.Table === "object" ? row.Table : {}) as Record<string, Record<string, unknown>>;
      const rowKeys = Object.keys(table).sort((a, b) => Number(a.replace(/\D/g, "")) - Number(b.replace(/\D/g, "")));
      if (rowKeys.length === 0) return [];
      const colKeys = (r: Record<string, unknown>) => Object.keys(r).sort((a, b) => Number(a.replace(/\D/g, "")) - Number(b.replace(/\D/g, "")));
      const header = table[rowKeys[0]] ?? {};
      const headerCols = colKeys(header);
      const out: { ref: string; values: Record<string, string>; keysUsed: string[] }[] = [];
      for (const rk of rowKeys.slice(1)) {
        const line = table[rk] ?? {};
        const cols = colKeys(line);
        const label = cleanValue(line[cols[0]]);
        const pairs = cols.slice(1).map((ck, i) => `${cleanValue(header[headerCols[i + 1]]) || `Col ${i + 2}`}: ${cleanValue(line[ck])}`);
        out.push({
          ref: `Table.${rk}`,
          values: {
            chartNo: cleanValue(row.SizeMeasurementMainID),
            styleNos: cleanValue(row.AllStyleNo),
            measurement: label,
            sizeValues: pairs.join(" | "),
          },
          keysUsed: ["SizeMeasurementMainID", "AllStyleNo", "Table"],
        });
      }
      return out;
    },
    fields: [],
    ignore: [...AUDIT, "UDTrackingNo", "SizeMeasurementMainID", "AllStyleNo", "AllGarmentsID", "Table", "TableRows", "TableColumns", "IsSelected"],
  },
  {
    id: "fabric",
    stepKey: "fabric-accessories",
    title: "Fabric & Accessories · Fabric",
    path: "/FabricInfo",
    component: "fabric-info",
    source: { prop: "list" },
    rowIdKey: "FabricID",
    udKey: "UDTrackingNo",
    constants: { itemType: "Fabric" },
    fields: [
      { field: "origin", key: "IsLocal", derive: (r) => ORIGIN_LABEL[cleanValue(r.IsLocal)] || "" },
      { field: "importLcNo", key: "ImportLCNo" },
      { field: "hsCode", key: "HSID" },
      { field: "description", key: "HSDescription" },
      { field: "composition", key: "TradeName" },
      { field: "quantity", key: "Qty" },
      { field: "usedQuantity", key: "UseQty" },
      { field: "balance", key: "Balance" },
      { field: "unit", key: "MUnitName", fallback: { codeKey: "MUnitID", via: "unit" } },
      { field: "unitPrice", key: "UnitPrice" },
      { field: "currency", key: "CurrencyName", fallback: { codeKey: "CurrencyID", via: "currency" } },
      { field: "netWeight", key: "NetWeight" },
      { field: "supplierName", key: "SupplierName" },
      { field: "supplierAddress", key: "SupplierAddress" },
      { field: "supplierCountry", key: "CountryName", fallback: { codeKey: "CountryID", via: "country" } },
      { field: "phone", key: "PhoneNo" },
      { field: "remarks", key: "Remarks" },
    ],
    ignore: [...AUDIT, "UDTrackingNo", "FabricID", "ImportLCTypeName", "ImportLCTypeID", "MUnitID", "CurrencyID", "CountryID", "MemberHsId"],
  },
  {
    id: "accessories",
    stepKey: "fabric-accessories",
    title: "Fabric & Accessories · Accessories",
    path: "/AccessoriesInfo",
    component: "ud-accessories-info",
    source: { prop: "list" },
    rowIdKey: "AccessoriesID",
    udKey: "UDTrackingNo",
    constants: { itemType: "Accessory" },
    fields: [
      { field: "origin", key: "Origin", derive: (r) => cleanValue(r.Origin) || ORIGIN_LABEL[cleanValue(r.IsLocal)] || "" },
      { field: "importLcNo", key: "ImportLCNo" },
      { field: "hsCode", key: "HSID" },
      { field: "description", key: "HSDescription" },
      { field: "composition", key: "TradeName" },
      { field: "quantity", key: "Qty" },
      { field: "usedQuantity", key: "UseQty" },
      { field: "unit", key: "UnitName", fallback: { codeKey: "MUnitID", via: "unit" } },
      { field: "supplierName", key: "SupplierName" },
      { field: "supplierAddress", key: "SupplierAddress" },
      { field: "supplierCountry", key: "Country", fallback: { codeKey: "CountryID", via: "country" } },
      { field: "phone", key: "PhoneNo" },
      { field: "remarks", key: "Remarks" },
    ],
    ignore: [...AUDIT, "UDTrackingNo", "AccessoriesID", "IsLocal", "MUnitID", "CountryID", "MemberHsId"],
  },
  {
    id: "other-material",
    stepKey: "fabric-accessories",
    title: "Fabric & Accessories · Other Material",
    path: "/OtherMaterial",
    component: "other-material",
    source: { prop: "list" },
    rowIdKey: "OtherRawMaterialID",
    udKey: "UDTrackingNo",
    // No populated sample was available when mapping (0 rows on the inspected UD), so
    // rows are REPORTED (unmapped) rather than mapped by guesswork.
    unconfirmedRows: true,
    fields: [],
    ignore: [...AUDIT],
  },
  {
    id: "consumption",
    stepKey: "consumption",
    title: "Consumption",
    path: "/ConsumptionInfo",
    component: "consumption-info",
    source: { prop: "list" },
    rowIdKey: "ConsumptionMainID",
    udKey: "UDTrackingNo",
    // One consumption entry links style(s) to fabric line(s). Each fabric line becomes
    // one UCP row that carries the consumption no + its styles (relationship kept).
    expand: (row, ctx) => {
      const styles = Array.isArray(row.UDConsumptionStyleInfoList) ? (row.UDConsumptionStyleInfoList as PortalRow[]) : [];
      const fabrics = Array.isArray(row.UDConsumptionFabricInfoList) ? (row.UDConsumptionFabricInfoList as PortalRow[]) : [];
      const styleText = styles
        .map((s) => {
          const qty = cleanValue(s.Qty);
          const unit = cleanValue(s.MUnitName);
          const desc = cleanValue(s.HSDescription);
          return `${cleanValue(s.StyleNo)}${desc ? ` (${desc})` : ""}${qty ? ` — ${qty}${unit ? ` ${unit}` : ""}` : ""}`;
        })
        .filter(Boolean)
        .join("; ");
      return fabrics.map((f, i) => {
        const src = cleanValue(f.FabricSource);
        return {
          ref: `UDConsumptionFabricInfoList[${i}]`,
          values: {
            consumptionNo: cleanValue(row.ConsumptionMainID),
            styleNos: styleText,
            component: cleanValue(f.HSID),
            description: cleanValue(f.HSDescription),
            tradeName: cleanValue(f.TradeName),
            fabricSource: src ? resolveCode(src, "fabric source", ctx.dropdowns) || src : "",
            unit: cleanValue(f.MUnitName),
            totalConsumption: cleanValue(f.Qty),
            baseQuantity: cleanValue(f.BaseQty),
            fabricBalance: cleanValue(f.Balance),
          },
          keysUsed: ["ConsumptionMainID", "UDConsumptionStyleInfoList", "UDConsumptionFabricInfoList"],
        };
      });
    },
    fields: [],
    ignore: [...AUDIT, "UDTrackingNo", "ConsumptionMainID", "AllStyleNos", "AllFabricIDs", "UDConsumptionStyleInfoList", "UDConsumptionFabricInfoList"],
  },
  {
    id: "documents",
    stepKey: "documents",
    title: "Document Upload",
    path: "/UDUpload",
    component: "ud-upload-doc",
    source: { prop: "list" },
    rowIdKey: "Id",
    udKey: "UDTrackingNo",
    fields: [
      { field: "docType", key: "DocumentTypeName" },
      { field: "uploadedAt", key: "EntryDate", derive: (r) => cleanValue(r.EntryDate).slice(0, 16).replace("T", " ") },
      {
        field: "fileRef",
        key: "FileDownloadPath",
        // Record only the object file name — UCP never downloads BGMEA files here.
        derive: (r) => {
          const p = cleanValue(r.FileDownloadPath);
          const m = p.match(/objectKey=([^&]+)/);
          return m ? decodeURIComponent(m[1]).split("/").pop() ?? "" : "";
        },
      },
    ],
    ignore: [...AUDIT, "UDTrackingNo", "Id", "ObjectUrl", "FileDeletePath", "DocumentTypeId", "IsCancellationDoc"],
  },
] as const;

/** Reference ("side panel") lists the portal links from the Garments/Fabric pages. */
export const PORTAL_REFERENCE_LISTS = [
  { id: "hscodes", title: "HS Code info", path: "/HsCodeInfo", component: "hscode-info", prop: "list", columns: [["HSID", "HS code"], ["HSDescription", "Description"]] },
  { id: "units", title: "Unit info", path: "/UnitInfo", component: "unit-info", prop: "list", columns: [["UnitName", "Unit"], ["UnitCode", "Code"], ["UnitDescription", "Description"]] },
] as const;

/** The portal pages to read, in UCP step order. */
export function sectionsInStepOrder(stepOrder: readonly string[]): PortalSectionRead[] {
  return [...PORTAL_SECTIONS].sort((a, b) => stepOrder.indexOf(a.stepKey) - stepOrder.indexOf(b.stepKey));
}

// ---------------------------------------------------------------------------
// Row → DetectedValue mapping (pure)
// ---------------------------------------------------------------------------

export interface SectionMapResult {
  detected: DetectedValue[];
  /** Portal keys that carried a value but have no confirmed UCP field. */
  unmapped: string[];
  /** Rows dropped because their UD did not match the selected UD. */
  rejectedRows: number;
  /** UCP group rows produced (after expansion). */
  rows: number;
  /** Portal rows read (before expansion). */
  portalRows: number;
}

function sourceRef(section: PortalSectionRead, ud: string, row: PortalRow, key: string, sub?: string): string {
  const id = section.rowIdKey ? cleanValue(row[section.rowIdKey]) : "";
  return [`BGMEA ${section.path}`, ud, id ? `${section.rowIdKey}=${id}` : "", sub ?? "", key].filter(Boolean).join(" · ");
}

/**
 * Map one portal page's rows into UCP DetectedValues. `groupOffset` lets several
 * portal pages (Fabric, Accessories, Other Material) share one UCP step's groups.
 */
export function mapSectionRows(section: PortalSectionRead, rows: PortalRow[], ctx: ReadContext, groupOffset = 0): SectionMapResult {
  const detected: DetectedValue[] = [];
  const unmapped = new Set<string>();
  let rejectedRows = 0;
  let group = groupOffset;
  const ud = ctx.udNumber.trim().toUpperCase();

  for (const row of rows) {
    if (section.udKey) {
      const rowUd = cleanValue(row[section.udKey]).toUpperCase();
      if (rowUd && rowUd !== ud) {
        rejectedRows += 1;
        continue;
      }
    }

    if (section.unconfirmedRows) {
      for (const [k, v] of Object.entries(row)) {
        if (section.ignore.includes(k) || k === section.udKey) continue;
        if (cleanValue(v)) unmapped.add(`${section.title}: ${k}`);
      }
      continue;
    }

    const usedKeys = new Set<string>(section.ignore);
    if (section.expand) {
      for (const line of section.expand(row, ctx)) {
        line.keysUsed.forEach((k) => usedKeys.add(k));
        for (const [field, value] of Object.entries(line.values)) {
          if (!value) continue;
          detected.push({ stepKey: section.stepKey, fieldKey: field, groupIndex: group, value, source: "bgmea-portal", sourceRef: sourceRef(section, ud, row, field, line.ref), confidence: 1 });
        }
        group += 1;
      }
    } else {
      let any = false;
      for (const f of section.fields) {
        usedKeys.add(f.key);
        if (f.fallback) usedKeys.add(f.fallback.codeKey);
        let value = f.derive ? f.derive(row, ctx) : f.date ? cleanDate(row[f.key]) : cleanValue(row[f.key]);
        let refKey = f.key;
        if (!value && f.fallback) {
          const code = cleanValue(row[f.fallback.codeKey]);
          value = resolveCode(code, f.fallback.via, ctx.dropdowns);
          refKey = `${f.fallback.codeKey}=${code} → "${f.fallback.via}" option`;
        }
        if (!value) continue;
        any = true;
        detected.push({ stepKey: section.stepKey, fieldKey: f.field, groupIndex: group, value, source: "bgmea-portal", sourceRef: sourceRef(section, ud, row, refKey), confidence: 1 });
      }
      if (any && section.constants) {
        for (const [field, value] of Object.entries(section.constants)) {
          detected.push({ stepKey: section.stepKey, fieldKey: field, groupIndex: group, value, source: "bgmea-portal", sourceRef: `BGMEA ${section.path} · ${ud} · page type`, confidence: 1 });
        }
      }
      if (any) group += 1;
    }

    for (const [k, v] of Object.entries(row)) {
      if (usedKeys.has(k) || k === section.udKey) continue;
      if (typeof v === "object" && v !== null) continue;
      if (cleanValue(v)) unmapped.add(`${section.title}: ${k}`);
    }
  }

  return { detected, unmapped: [...unmapped], rejectedRows, rows: group - groupOffset, portalRows: rows.length };
}

/**
 * The value BGMEA currently holds for one UCP field of a portal row, computed exactly
 * as the reader maps it (derive / date / code fallback). Used to diff before writing
 * and to verify after saving.
 */
export function readFieldValue(section: PortalSectionRead, row: PortalRow, field: string, ctx: ReadContext): string {
  const f = section.fields.find((x) => x.field === field);
  if (!f) return "";
  let value = f.derive ? f.derive(row, ctx) : f.date ? cleanDate(row[f.key]) : cleanValue(row[f.key]);
  if (!value && f.fallback) value = resolveCode(cleanValue(row[f.fallback.codeKey]), f.fallback.via, ctx.dropdowns);
  return value;
}

export function readSectionById(id: string): PortalSectionRead | undefined {
  return PORTAL_SECTIONS.find((s) => s.id === id);
}

// ---------------------------------------------------------------------------
// WRITE map
// ---------------------------------------------------------------------------

export interface WriteField {
  /** UCP field key. */
  field: string;
  /** Visible form label on the BGMEA page (without "*"). */
  label: string;
  kind: "text" | "date" | "select";
  /** Portal row key holding the current value (for diffing); omit to always write. */
  portalKey?: string;
  /** Optional: the portal stores a code; compare via the resolved label instead. */
  compareVia?: string;
}

export interface PortalSectionWrite {
  /** Matches PORTAL_SECTIONS[].id. */
  id: string;
  stepKey: string;
  /** How a new row is created. "form" = New → fill → Save; "pick" = choose from a master dropdown → Save. */
  mode: "form" | "pick";
  /** UCP field + portal key used to match a UCP row to an existing portal row. */
  match: { field: string; portalKey: string; alt?: { field: string; portalKey: string }; also?: { field: string; portalKey: string }[] };
  /** For "pick": the master dropdown label and the UCP field whose value selects the option. */
  pick?: { label: string; field: string; altField?: string };
  /** Fields written into the form. */
  fields: WriteField[];
  /** For multi-page steps, which UCP rows belong to this page. */
  rowFilter?: (values: Record<string, string>) => boolean;
}

/**
 * Pages whose BGMEA save flow is form-based and supported by the writer. Size chart
 * (grid builder), consumption (style/fabric allocation with balance checks), Other
 * Material, document upload and UD information are NOT written automatically —
 * the writer reports them as "manual" with the reason, never half-written.
 */
export const PORTAL_WRITE_SECTIONS: readonly PortalSectionWrite[] = [
  {
    id: "lien-bank",
    stepKey: "lien-bank",
    mode: "pick",
    match: { field: "bankId", portalKey: "BranchSpecificCode", alt: { field: "bankName", portalKey: "BankName" } },
    pick: { label: "Banks", field: "bankId", altField: "bankName" },
    fields: [],
  },
  {
    id: "buyer",
    stepKey: "buyer",
    mode: "pick",
    match: { field: "buyerName", portalKey: "BuyerName" },
    pick: { label: "Select Buyer", field: "buyerName" },
    fields: [],
  },
  {
    id: "export-lc",
    stepKey: "export-lc",
    mode: "form",
    match: { field: "lcNumber", portalKey: "ExportLCNo" },
    fields: [
      { field: "lcType", label: "Type", kind: "select", portalKey: "ExportLCTypeText" },
      { field: "issuingBank", label: "Bank", kind: "select", portalKey: "BankName" },
      { field: "lcNumber", label: "L/C No", kind: "text", portalKey: "ExportLCNo" },
      { field: "lcDate", label: "Date", kind: "date", portalKey: "LCDate" },
      { field: "lcValue", label: "L/C Value", kind: "text", portalKey: "LCValue" },
      { field: "usedValue", label: "Used L/C Value", kind: "text", portalKey: "LCUseValue" },
      { field: "tolerance", label: "Tolerance", kind: "text", portalKey: "Tolerance" },
      { field: "currency", label: "Currency", kind: "select", portalKey: "CurrencyName", compareVia: "currency" },
      { field: "shipmentDate", label: "Shipment Date", kind: "date", portalKey: "ShipmentDate" },
      { field: "expiryDate", label: "Expiry Date", kind: "date", portalKey: "ExpiryDate" },
      { field: "remarks", label: "Remarks", kind: "text", portalKey: "Remarks" },
    ],
  },
  {
    id: "import-lc",
    stepKey: "btb-lc",
    mode: "form",
    match: { field: "lcNumber", portalKey: "ImportLCNo" },
    fields: [
      { field: "exportLcNo", label: "Export L/C No", kind: "select", portalKey: "ExportLcNo" },
      { field: "lcType", label: "Type", kind: "select", portalKey: "ImportLCTypeName" },
      { field: "origin", label: "Origins", kind: "select", portalKey: "Origin" },
      { field: "bank", label: "Bank", kind: "select", portalKey: "BankName" },
      { field: "lcNumber", label: "L/C No", kind: "text", portalKey: "ImportLCNo" },
      { field: "lcDate", label: "Date", kind: "date", portalKey: "LCDate" },
      { field: "lcValue", label: "L/C Value", kind: "text", portalKey: "LCValue" },
      { field: "usedValue", label: "Used L/C Value", kind: "text", portalKey: "LCUseValue" },
      { field: "tolerance", label: "Tolerance", kind: "text", portalKey: "Tolerance" },
      { field: "currency", label: "Currency", kind: "select", portalKey: "CurrencyName", compareVia: "currency" },
      { field: "remarks", label: "Remarks", kind: "text", portalKey: "Remarks" },
    ],
  },
  {
    id: "notify-party",
    stepKey: "notify-party",
    mode: "form",
    match: { field: "notifyName", portalKey: "NotifyName" },
    fields: [
      { field: "notifyName", label: "Name", kind: "text", portalKey: "NotifyName" },
      { field: "notifyAddress", label: "Address", kind: "text", portalKey: "NotifyAddress" },
      { field: "notifyCountry", label: "Country", kind: "select", portalKey: "CountryName", compareVia: "country" },
      { field: "fax", label: "Fax", kind: "text", portalKey: "FaxNo" },
      { field: "email", label: "Email", kind: "text", portalKey: "EmailAddress" },
    ],
  },
  {
    id: "port",
    stepKey: "port",
    mode: "form",
    match: { field: "portOfDischarge", portalKey: "PortName" },
    fields: [
      { field: "portOfDischarge", label: "Port Name", kind: "text", portalKey: "PortName" },
      { field: "portCode", label: "Port Code", kind: "text" },
      { field: "portCountry", label: "Country", kind: "select", portalKey: "PortCountryName" },
      { field: "finalDestination", label: "Ultimate Destination", kind: "select", portalKey: "DestinationCountryName" },
    ],
  },
  {
    id: "garments",
    stepKey: "garments",
    mode: "form",
    match: { field: "styleNo", portalKey: "StyleNo", also: [{ field: "exportLcNo", portalKey: "ExportLCNo" }] },
    fields: [
      { field: "exportLcNo", label: "Export L/C/Contract/P.O", kind: "select", portalKey: "ExportLCNo" },
      { field: "styleNo", label: "Style No.", kind: "text", portalKey: "StyleNo" },
      { field: "hsCode", label: "Hs Code", kind: "text", portalKey: "HSID" },
      { field: "itemDescription", label: "Description", kind: "text", portalKey: "HSDescription" },
      { field: "quantityPcs", label: "Quantity", kind: "text", portalKey: "Qty" },
      { field: "usedQuantity", label: "Used Quantity", kind: "text", portalKey: "UseQty" },
      { field: "unit", label: "Unit Name", kind: "select", portalKey: "MUnitName", compareVia: "unit" },
      { field: "unitPrice", label: "Unit Price", kind: "text", portalKey: "UnitPrice" },
      { field: "currency", label: "Currency", kind: "select", portalKey: "CurrencyName", compareVia: "currency" },
    ],
  },
  {
    id: "fabric",
    stepKey: "fabric-accessories",
    mode: "form",
    match: { field: "hsCode", portalKey: "HSID", also: [{ field: "description", portalKey: "HSDescription" }, { field: "importLcNo", portalKey: "ImportLCNo" }] },
    rowFilter: (v) => /^fabric$/i.test((v.itemType || "").trim()),
    fields: [
      { field: "origin", label: "Origin", kind: "select" },
      { field: "importLcNo", label: "L/C No", kind: "select", portalKey: "ImportLCNo" },
      { field: "hsCode", label: "H.S. Code", kind: "text", portalKey: "HSID" },
      { field: "description", label: "Description", kind: "text", portalKey: "HSDescription" },
      { field: "composition", label: "Construction", kind: "text", portalKey: "TradeName" },
      { field: "quantity", label: "Quantity", kind: "text", portalKey: "Qty" },
      { field: "usedQuantity", label: "Used Quantity", kind: "text", portalKey: "UseQty" },
      { field: "unit", label: "Unit Name", kind: "select", portalKey: "MUnitName", compareVia: "unit" },
      { field: "unitPrice", label: "Unit Price", kind: "text", portalKey: "UnitPrice" },
      { field: "currency", label: "Currency", kind: "select", portalKey: "CurrencyName", compareVia: "currency" },
      { field: "netWeight", label: "Net Weight (KGS)", kind: "text", portalKey: "NetWeight" },
      { field: "supplierName", label: "Supplier Name", kind: "text", portalKey: "SupplierName" },
      { field: "supplierAddress", label: "Address", kind: "text", portalKey: "SupplierAddress" },
      { field: "supplierCountry", label: "Country", kind: "select", portalKey: "CountryName", compareVia: "country" },
      { field: "phone", label: "Phone No", kind: "text", portalKey: "PhoneNo" },
      { field: "remarks", label: "Remarks", kind: "text", portalKey: "Remarks" },
    ],
  },
  {
    id: "accessories",
    stepKey: "fabric-accessories",
    mode: "form",
    match: { field: "hsCode", portalKey: "HSID", also: [{ field: "description", portalKey: "HSDescription" }, { field: "importLcNo", portalKey: "ImportLCNo" }] },
    rowFilter: (v) => /^accessor/i.test((v.itemType || "").trim()),
    fields: [
      { field: "origin", label: "Origin", kind: "select", portalKey: "Origin" },
      { field: "importLcNo", label: "L/C No", kind: "select", portalKey: "ImportLCNo" },
      { field: "hsCode", label: "H.S. Code", kind: "text", portalKey: "HSID" },
      { field: "description", label: "Description", kind: "text", portalKey: "HSDescription" },
      { field: "quantity", label: "Quantity", kind: "text", portalKey: "Qty" },
      { field: "usedQuantity", label: "Used Quantity", kind: "text", portalKey: "UseQty" },
      { field: "unit", label: "Unit Name", kind: "select", portalKey: "UnitName", compareVia: "unit" },
      { field: "supplierName", label: "Supplier Name", kind: "text", portalKey: "SupplierName" },
      { field: "supplierAddress", label: "Supplier Address", kind: "text", portalKey: "SupplierAddress" },
      { field: "supplierCountry", label: "Country", kind: "select", portalKey: "Country", compareVia: "country" },
      { field: "phone", label: "Phone No", kind: "text", portalKey: "PhoneNo" },
      { field: "remarks", label: "Remarks", kind: "text", portalKey: "Remarks" },
    ],
  },
] as const;

/** Steps the writer does not automate, with the reason shown per page. */
export const MANUAL_WRITE_STEPS: Record<string, string> = {
  "ud-select": "UD information is the factory's registration data; UCP does not change it.",
  "size-chart": "The BGMEA measurement-chart grid builder is not automated — complete it in BGMEA.",
  consumption: "BGMEA consumption allocation (style ↔ fabric with balance checks) is not automated — complete it in BGMEA.",
  documents: "Document upload to BGMEA is not automated — upload the files in BGMEA.",
};

// ---------------------------------------------------------------------------
// Write diffing (pure)
// ---------------------------------------------------------------------------

/** Compare two values as BGMEA would store them (numbers numerically, dates by day, text case/space-insensitively). */
export function sameValue(a: string, b: string): boolean {
  const x = cleanValue(a);
  const y = cleanValue(b);
  if (x === y) return true;
  const nx = Number(x.replace(/,/g, ""));
  const ny = Number(y.replace(/,/g, ""));
  if (x !== "" && y !== "" && Number.isFinite(nx) && Number.isFinite(ny)) return nx === ny;
  const dx = cleanDate(x);
  const dy = cleanDate(y);
  if (dx && dy) return dx === dy;
  return x.toLowerCase() === y.toLowerCase();
}

/**
 * Pick the single dropdown option matching a UCP value: exact label (normalised), or
 * the unique option whose label starts with "<value> -" / "<value> (" / contains
 * "(<value>)" / starts with "<value> " (e.g. "PCS" → "PCS - (PCE)", "2859" →
 * "2859 (THE HONGKONG …)"). Returns null when none or several match — never guesses.
 */
export function matchOption(value: string, options: { value: string; label: string }[]): { value: string; label: string } | null {
  const v = normLabel(value);
  if (!v) return null;
  const real = options.filter((o) => o.label.trim() !== "");
  const exact = real.filter((o) => normLabel(o.label) === v || o.value === value.trim());
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  const loose = real.filter((o) => {
    const l = normLabel(o.label);
    return l.startsWith(`${v} -`) || l.startsWith(`${v} (`) || l.includes(`(${v})`) || l.startsWith(`${v} `);
  });
  return loose.length === 1 ? loose[0] : null;
}

/** One UCP group row, as field → value. */
export type UcpRow = Record<string, string>;

export interface RowPlan {
  action: "unchanged" | "update" | "create";
  /** The UCP group index this row came from. */
  groupIndex: number;
  matchValue: string;
  /** Portal row matched (for update/unchanged). */
  portalRow?: PortalRow;
  /** Fields to write (update: only the differing ones; create: all non-empty). */
  changes: { field: string; label: string; kind: WriteField["kind"]; value: string }[];
}

/**
 * Plan the writes for one page: match each UCP row to a portal row by the page's
 * match key, then list the differing fields. Portal rows with no UCP counterpart are
 * returned separately and LEFT UNCHANGED (UCP never deletes BGMEA rows).
 */
export function planPageWrites(
  section: PortalSectionWrite,
  ucpRows: { groupIndex: number; values: UcpRow }[],
  portalRows: PortalRow[],
  resolvePortal: (row: PortalRow, f: WriteField) => string,
): { plans: RowPlan[]; portalOnly: PortalRow[]; skipped: { groupIndex: number; reason: string }[] } {
  const plans: RowPlan[] = [];
  const skipped: { groupIndex: number; reason: string }[] = [];
  const used = new Set<PortalRow>();
  for (const r of ucpRows) {
    if (section.rowFilter && !section.rowFilter(r.values)) continue;
    const hasAny = Object.values(r.values).some((v) => cleanValue(v) !== "");
    if (!hasAny) continue;
    const primary = cleanValue(r.values[section.match.field]);
    const key = primary ? section.match : section.match.alt && cleanValue(r.values[section.match.alt.field]) ? section.match.alt : null;
    const matchValue = key ? cleanValue(r.values[key.field]) : "";
    if (!key || !matchValue) {
      skipped.push({ groupIndex: r.groupIndex, reason: `No ${section.match.field} — cannot match this row to BGMEA.` });
      continue;
    }
    const hits = portalRows.filter(
      (p) =>
        !used.has(p) &&
        sameValue(cleanValue(p[key.portalKey]), matchValue) &&
        (section.match.also ?? []).every((a) => !cleanValue(r.values[a.field]) || sameValue(cleanValue(p[a.portalKey]), r.values[a.field])),
    );
    if (hits.length > 1) {
      skipped.push({ groupIndex: r.groupIndex, reason: `${hits.length} BGMEA rows share ${section.match.field} "${matchValue}" — ambiguous, left unchanged.` });
      continue;
    }
    const hit = hits[0];
    if (section.mode === "pick") {
      if (hit) {
        used.add(hit);
        plans.push({ action: "unchanged", groupIndex: r.groupIndex, matchValue, portalRow: hit, changes: [] });
      } else {
        plans.push({ action: "create", groupIndex: r.groupIndex, matchValue, changes: [] });
      }
      continue;
    }
    if (hit) {
      used.add(hit);
      const changes = section.fields
        .filter((f) => cleanValue(r.values[f.field]) !== "")
        .filter((f) => !f.portalKey || !sameValue(resolvePortal(hit, f), r.values[f.field]))
        .map((f) => ({ field: f.field, label: f.label, kind: f.kind, value: cleanValue(r.values[f.field]) }));
      plans.push({ action: changes.length ? "update" : "unchanged", groupIndex: r.groupIndex, matchValue, portalRow: hit, changes });
    } else {
      const changes = section.fields
        .filter((f) => cleanValue(r.values[f.field]) !== "")
        .map((f) => ({ field: f.field, label: f.label, kind: f.kind, value: cleanValue(r.values[f.field]) }));
      plans.push({ action: "create", groupIndex: r.groupIndex, matchValue, changes });
    }
  }
  const portalOnly = portalRows.filter((p) => !used.has(p));
  return { plans, portalOnly, skipped };
}
