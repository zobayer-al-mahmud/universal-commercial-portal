import { describe, it, expect } from "vitest";
import { PORTAL_SECTIONS, cleanDate, cleanValue, mapSectionRows, readSectionById, resolveCode, udBelongsToFactory } from "@/server/ud-automation/portal-map";
import { UD_STEPS, fieldDef } from "@/server/ud-automation/steps";

// Synthetic rows shaped like the BGMEA page components (no real business data).
const UD = "UD99992026001";
const ctx = (extra: Record<string, Record<string, unknown>[]> = {}) => ({
  udNumber: UD,
  dropdowns: [
    { label: "Currency", options: [{ value: "201201", label: "USD" }] },
    { label: "Country", options: [{ value: "65", label: "Denmark" }] },
    { label: "Unit Name", options: [{ value: "109501", label: "YDS - (YRD)" }] },
    { label: "Fabric Source", options: [{ value: "FabricInfo", label: "From Import" }] },
  ],
  extra,
});

describe("portal map integrity", () => {
  it("maps every portal field to a real UCP field of its step", () => {
    for (const s of PORTAL_SECTIONS) {
      expect(UD_STEPS.some((st) => st.key === s.stepKey)).toBe(true);
      for (const f of s.fields) expect(fieldDef(s.stepKey, f.field), `${s.id}.${f.field}`).toBeTruthy();
      for (const k of Object.keys(s.constants ?? {})) expect(fieldDef(s.stepKey, k)).toBeTruthy();
    }
  });

  it("covers all 14 UCP sections, one BGMEA page each for Fabric / Accessories / Other Material", () => {
    for (const [id, step] of [["fabric", "fabric"], ["accessories", "accessories"], ["other-material", "other-material"]]) {
      expect(readSectionById(id)!.stepKey).toBe(step);
    }
    const steps = new Set(PORTAL_SECTIONS.map((s) => s.stepKey));
    for (const st of UD_STEPS) expect(steps.has(st.key), st.key).toBe(true);
  });
});

describe("UD ↔ factory guard", () => {
  it("accepts only the factory's own UD numbers", () => {
    expect(udBelongsToFactory("UD41482025004", "4148")).toBe(true);
    expect(udBelongsToFactory("ud41482025004", "4148")).toBe(true);
    expect(udBelongsToFactory("UD41492023005", "4148")).toBe(false);
    expect(udBelongsToFactory("UD4148", "4148")).toBe(false);
    expect(udBelongsToFactory("", "4148")).toBe(false);
  });
});

describe("value normalisation", () => {
  it("treats null / 'null' / .NET empty dates as blank and normalises dates", () => {
    expect(cleanValue(null)).toBe("");
    expect(cleanValue("null")).toBe("");
    expect(cleanValue("TEX&nbsp;ZIPPERS")).toBe("TEX ZIPPERS");
    expect(cleanDate("2026-08-23T00:00:00")).toBe("2026-08-23");
    expect(cleanDate("02/09/2026")).toBe("2026-09-02");
    expect(cleanDate("0001-01-01T00:00:00")).toBe("");
  });
  it("resolves coded values through the page's own dropdowns", () => {
    expect(resolveCode("201201", "currency", ctx().dropdowns)).toBe("USD");
    expect(resolveCode("999", "currency", ctx().dropdowns)).toBe("");
  });
});

describe("row → UCP mapping", () => {
  it("maps garment rows with code fallback, provenance and one group per row", () => {
    const rows = [
      { UDTrackingNo: UD, GarmentsID: 3, ExportLCNo: "LC-A", StyleNo: "ST-1", HSID: "6203.42.00", HSDescription: "Pant", Qty: 4450, UseQty: 4450, Balance: 0, MUnitID: "109502", MUnitName: "PCS", UnitPrice: 4.2, CurrencyID: "201201", CurrencyName: null, Entryby: "x" },
      { UDTrackingNo: UD, GarmentsID: 2, ExportLCNo: "LC-A", StyleNo: "ST-2", HSID: "6203.42.00", HSDescription: "Long pant", Qty: 6000, UseQty: 6000, MUnitName: "PCS", UnitPrice: 5.95, CurrencyID: "201201" },
    ];
    const r = mapSectionRows(readSectionById("garments")!, rows, ctx());
    expect(r.rows).toBe(2);
    const g0 = Object.fromEntries(r.detected.filter((d) => d.groupIndex === 0).map((d) => [d.fieldKey, d.value]));
    expect(g0).toMatchObject({ styleNo: "ST-1", hsCode: "6203.42.00", itemDescription: "Pant", quantityPcs: "4450", usedQuantity: "4450", balance: "0", unit: "PCS", unitPrice: "4.2", currency: "USD" });
    const cur = r.detected.find((d) => d.fieldKey === "currency")!;
    expect(cur.source).toBe("bgmea-portal");
    expect(cur.sourceRef).toContain("/GarmentsInfo");
    expect(cur.sourceRef).toContain("GarmentsID=3");
    expect(cur.sourceRef).toContain("CurrencyID=201201");
    expect(r.unmapped).toHaveLength(0);
  });

  it("rejects rows that belong to another UD", () => {
    const rows = [{ UDTrackingNo: "UD99992026002", NotifyID: 1, NotifyName: "X" }, { UDTrackingNo: UD, NotifyID: 2, NotifyName: "Y", CountryID: "65" }];
    const r = mapSectionRows(readSectionById("notify-party")!, rows, ctx());
    expect(r.rejectedRows).toBe(1);
    expect(r.detected.find((d) => d.fieldKey === "notifyName")!.value).toBe("Y");
    expect(r.detected.find((d) => d.fieldKey === "notifyCountry")!.value).toBe("Denmark");
  });

  it("flags unmapped portal fields instead of guessing", () => {
    const r = mapSectionRows(readSectionById("accessories")!, [{ UDTrackingNo: UD, AccessoriesID: 1, HSID: "9606.22.00", HSDescription: "Button", Fax: "123", WebAddress: "w" }], ctx());
    expect(r.unmapped).toEqual(expect.arrayContaining(["Accessories: WebAddress"]));
    expect(r.detected.find((d) => d.fieldKey === "fax")!.value).toBe("123");
  });

  it("maps Fabric and Accessories into their OWN steps, each starting at row 0", () => {
    const fab = mapSectionRows(readSectionById("fabric")!, [{ UDTrackingNo: UD, FabricID: 1, IsLocal: "N", HSID: "5209.42.00", HSDescription: "Denim", MUnitID: "109501", CountryID: "65" }], ctx());
    const acc = mapSectionRows(readSectionById("accessories")!, [{ UDTrackingNo: UD, AccessoriesID: 1, HSID: "9606.22.00", HSDescription: "Button" }], ctx());
    expect(fab.detected.every((d) => d.stepKey === "fabric" && d.groupIndex === 0)).toBe(true);
    expect(acc.detected.every((d) => d.stepKey === "accessories" && d.groupIndex === 0)).toBe(true);
    const f = Object.fromEntries(fab.detected.map((d) => [d.fieldKey, d.value]));
    expect(f).toMatchObject({ origin: "Foreign", unit: "YDS - (YRD)", supplierCountry: "Denmark" });
    expect(f.itemType).toBeUndefined();
  });

  it("treats an empty section as empty, not as a failure", () => {
    const r = mapSectionRows(readSectionById("accessories")!, [], ctx());
    expect(r).toMatchObject({ portalRows: 0, rows: 0, rejectedRows: 0 });
    expect(r.detected).toHaveLength(0);
  });

  it("expands a size chart grid into one row per measurement line, keeping chart + styles", () => {
    const chart = { UDTrackingNo: UD, SizeMeasurementMainID: 1, AllStyleNo: "ST-1", Table: { row0: { column0: "Description", column1: "S", column2: "M" }, row1: { column0: "Waist", column1: "30", column2: "32" }, row2: { column0: "Hip", column1: "40", column2: "42" } } };
    const r = mapSectionRows(readSectionById("size-chart")!, [chart], ctx());
    expect(r.rows).toBe(2);
    const line1 = Object.fromEntries(r.detected.filter((d) => d.groupIndex === 1).map((d) => [d.fieldKey, d.value]));
    expect(line1).toEqual({ chartNo: "1", styleNos: "ST-1", measurement: "Hip", sizeValues: "S: 40 | M: 42" });
  });

  it("expands consumption into fabric lines linked to their styles", () => {
    const row = {
      UDTrackingNo: UD,
      ConsumptionMainID: 2,
      UDConsumptionStyleInfoList: [{ StyleNo: "ST-1", HSDescription: "Pant", Qty: 4500, MUnitName: "PCE" }],
      UDConsumptionFabricInfoList: [{ HSID: "5209.42.00", HSDescription: "Denim", TradeName: "3/1 RHT", FabricSource: "FabricInfo", Qty: 3645, BaseQty: 10046, Balance: 6401, MUnitName: "YRD" }],
    };
    const r = mapSectionRows(readSectionById("consumption")!, [row], ctx());
    const v = Object.fromEntries(r.detected.map((d) => [d.fieldKey, d.value]));
    expect(v).toMatchObject({ consumptionNo: "2", styleNos: "ST-1 (Pant) — 4500 PCE", component: "5209.42.00", fabricSource: "From Import", totalConsumption: "3645", baseQuantity: "10046", fabricBalance: "6401", unit: "YRD" });
  });

  it("maps Other Material rows (keys from the page's own list template) into their own step", () => {
    const row = { UDTrackingNo: UD, OtherRawMaterialID: 4, RawMaterialTypeID: "1", RawMaterialTypeName: "Fabric", Origin: "Local", UDNo: "UD99992025003", UDDate: "2025-05-01T00:00:00", HSID: "5209.42.00", HSDescription: "Denim", TradeName: "3/1", Qty: 500, MUnitID: "109501", MUnitname: null, MaterialValue: 1200, CurrencyID: "201201", CurrencyName: null, SupplierName: "S", SupplierAddress: "A", CountryID: "65", CountryName: null, PhoneNo: "1", NetWeight: 0, Mystery: "x" };
    const r = mapSectionRows(readSectionById("other-material")!, [row], ctx());
    const v = Object.fromEntries(r.detected.map((d) => [d.fieldKey, d.value]));
    expect(r.detected.every((d) => d.stepKey === "other-material" && d.groupIndex === 0)).toBe(true);
    expect(v).toMatchObject({ materialType: "Fabric", origin: "Local", sourceUdNo: "UD99992025003", sourceUdDate: "2025-05-01", hsCode: "5209.42.00", tradeName: "3/1", quantity: "500", unit: "YDS - (YRD)", value: "1200", currency: "USD", supplierCountry: "Denmark", netWeight: "0" });
    expect(r.unmapped).toEqual(["Other Material: Mystery"]);
  });

  it("derives a port code from the member's port list only when unambiguous", () => {
    const rows = [{ UDTrackingNo: UD, PortID: 1, PortName: "Odense", PortCountryName: "Denmark", DestinationCountryName: "Denmark" }];
    const ok = mapSectionRows(readSectionById("port")!, rows, ctx({ portlist: [{ PortName: "ODENSE", PortCode: "DKODE" }] }));
    expect(ok.detected.find((d) => d.fieldKey === "portCode")!.value).toBe("DKODE");
    const amb = mapSectionRows(readSectionById("port")!, rows, ctx({ portlist: [{ PortName: "Odense", PortCode: "A" }, { PortName: "Odense", PortCode: "B" }] }));
    expect(amb.detected.find((d) => d.fieldKey === "portCode")).toBeUndefined();
  });

  it("reads documents without keeping download URLs", () => {
    const r = mapSectionRows(readSectionById("documents")!, [{ UDTrackingNo: UD, Id: "g", DocumentTypeName: "BB/L/C & PI", EntryDate: "2026-09-01T10:34:02.147", FileDownloadPath: "/UDUpload/Download?objectKey=2026/9/1/abc.pdf", ObjectUrl: "https://example/abc.pdf" }], ctx());
    const v = Object.fromEntries(r.detected.map((d) => [d.fieldKey, d.value]));
    expect(v).toEqual({ docType: "BB/L/C & PI", uploadedAt: "2026-09-01 10:34", fileRef: "abc.pdf" });
  });
});
