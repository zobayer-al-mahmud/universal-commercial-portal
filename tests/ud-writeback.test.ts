import { describe, it, expect } from "vitest";
import { isFinalSubmitControl, isForbiddenUdControl, bgmeaWriteBackGate, confirmationMatches, UD_NEVER_AUTO_SUBMITS } from "@/server/ud-automation/guards";
import { PORTAL_WRITE_SECTIONS, MANUAL_WRITE_STEPS, isUdEditable, matchOption, planPageWrites, readFieldValue, readSectionById, sameValue } from "@/server/ud-automation/portal-map";

describe("click guards", () => {
  it("never allows final-submit or destructive controls to be automated", () => {
    expect(UD_NEVER_AUTO_SUBMITS).toBe(true);
    for (const label of ["Submit", "UD Submission", "Approve", "Finalize", "Lock", "Send", "Acknowledge", "Confirm", "Delete", "Remove", "Cancel", "Cancellation", "Payment", "Pay"]) {
      expect(isFinalSubmitControl(label)).toBe(true);
    }
  });

  it("does NOT treat page-save controls as final submission (they are allowed only in a confirmed write-back)", () => {
    for (const label of ["Save", "Update", "New", "Add row", "Next"]) {
      expect(isFinalSubmitControl(label)).toBe(false);
    }
  });

  it("read/fetch context forbids save, submit and delete", () => {
    for (const label of ["Save", "Submit", "Update", "Delete", "Approve"]) expect(isForbiddenUdControl(label)).toBe(true);
    for (const label of ["Login", "Search", "Open", "Select", "Upload"]) expect(isForbiddenUdControl(label)).toBe(false);
  });
});

describe("Confirm Ready for BGMEA — explicit factory + UD confirmation", () => {
  const record = { factoryId: "4148", udNumber: "UD41482025004" };
  it("accepts only the exact factory and UD (case-insensitive UD)", () => {
    expect(confirmationMatches({ confirmFactoryId: "4148", confirmUdNumber: "ud41482025004" }, record)).toBe(true);
    expect(confirmationMatches({ confirmFactoryId: "4149", confirmUdNumber: "UD41482025004" }, record)).toBe(false);
    expect(confirmationMatches({ confirmFactoryId: "4148", confirmUdNumber: "UD41482025005" }, record)).toBe(false);
    expect(confirmationMatches({ confirmFactoryId: "4148", confirmUdNumber: "" }, record)).toBe(false);
    expect(confirmationMatches({ confirmFactoryId: "4148", confirmUdNumber: "" }, { factoryId: "4148", udNumber: "" })).toBe(false);
  });

  it("is switched off by default (fail-closed kill switch)", async () => {
    const gate = await bgmeaWriteBackGate("4148");
    expect(gate.enabled).toBe(false);
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toMatch(/off/i);
  });
});

describe("BGMEA editability mirrors the portal's canEdit", () => {
  it("allows NEW / DISCREPANCY / CORRECTION (and unset), refuses submitted/passed", () => {
    expect(isUdEditable(null)).toBe(true);
    expect(isUdEditable(0)).toBe(true);
    expect(isUdEditable(45)).toBe(true);
    expect(isUdEditable(50)).toBe(true);
    expect(isUdEditable(5)).toBe(false);
    expect(isUdEditable(55)).toBe(false);
  });
});

describe("write planning (pure)", () => {
  const garments = PORTAL_WRITE_SECTIONS.find((w) => w.id === "garments")!;
  const readDef = readSectionById("garments")!;
  const dropdowns = [{ label: "Currency", options: [{ value: "201201", label: "USD" }] }, { label: "Unit Name", options: [{ value: "109502", label: "PCS - (PCE)" }] }];
  const resolve = (row: Record<string, unknown>, f: { field: string }) => readFieldValue(readDef, row, f.field, { udNumber: "UD99992026001", dropdowns, extra: {} });
  const portal = [
    { UDTrackingNo: "UD99992026001", GarmentsID: 1, ExportLCNo: "LC-A", StyleNo: "ST-1", HSID: "6203.42.00", HSDescription: "Pant", Qty: 100, UseQty: 100, MUnitID: "109502", MUnitName: "PCS", UnitPrice: 2.5, CurrencyID: "201201", CurrencyName: null },
    { UDTrackingNo: "UD99992026001", GarmentsID: 2, ExportLCNo: "LC-A", StyleNo: "ST-2", HSID: "6203.42.00", HSDescription: "Shorts", Qty: 50, UseQty: 50, MUnitID: "109502", MUnitName: "PCS", UnitPrice: 3, CurrencyID: "201201", CurrencyName: null },
  ];

  it("marks matching rows unchanged, writes only differing fields, creates new rows, never deletes", () => {
    const ucp: { groupIndex: number; values: Record<string, string> }[] = [
      { groupIndex: 0, values: { exportLcNo: "LC-A", styleNo: "ST-1", quantityPcs: "100", unitPrice: "2.50", currency: "USD", unit: "PCS" } },
      { groupIndex: 1, values: { exportLcNo: "LC-A", styleNo: "ST-2", quantityPcs: "60" } },
      { groupIndex: 2, values: { exportLcNo: "LC-A", styleNo: "ST-3", quantityPcs: "10", itemDescription: "Jacket" } },
    ];
    const { plans, portalOnly } = planPageWrites(garments, ucp, portal, resolve);
    expect(plans.map((p) => p.action)).toEqual(["unchanged", "update", "create"]);
    expect(plans[1].changes.map((c) => c.field)).toEqual(["quantityPcs"]);
    expect(plans[2].changes.map((c) => c.field)).toContain("itemDescription");
    expect(portalOnly).toHaveLength(0);
  });

  it("leaves BGMEA-only rows unchanged and skips rows it cannot match", () => {
    const { plans, portalOnly, skipped } = planPageWrites(garments, [{ groupIndex: 0, values: { quantityPcs: "5" } }], portal, resolve);
    expect(plans).toHaveLength(0);
    expect(skipped).toHaveLength(1);
    expect(portalOnly).toHaveLength(2);
  });

  it("refuses ambiguous matches instead of guessing", () => {
    const dup = [...portal, { ...portal[0], GarmentsID: 9 }];
    const { plans, skipped } = planPageWrites(garments, [{ groupIndex: 0, values: { styleNo: "ST-1", exportLcNo: "LC-A", quantityPcs: "1" } }], dup, resolve);
    expect(plans).toHaveLength(0);
    expect(skipped[0].reason).toMatch(/ambiguous/i);
  });

  it("matches lien banks by BGMEA bank id, or by name when the id is blank", () => {
    const lien = PORTAL_WRITE_SECTIONS.find((w) => w.id === "lien-bank")!;
    const rows = [{ BankId: "1", BranchSpecificCode: "1111", BankName: "ALPHA BANK" }];
    const r1 = planPageWrites(lien, [{ groupIndex: 0, values: { bankId: "1111" } }], rows, () => "");
    const r2 = planPageWrites(lien, [{ groupIndex: 0, values: { bankName: "alpha bank" } }], rows, () => "");
    const r3 = planPageWrites(lien, [{ groupIndex: 0, values: { bankName: "BETA BANK" } }], rows, () => "");
    expect(r1.plans[0].action).toBe("unchanged");
    expect(r2.plans[0].action).toBe("unchanged");
    expect(r3.plans[0].action).toBe("create");
  });

  it("writes Fabric, Accessories and Other Material as separate BGMEA pages", () => {
    const pages = PORTAL_WRITE_SECTIONS.filter((w) => ["fabric", "accessories", "other-material"].includes(w.id));
    expect(pages.map((w) => w.stepKey)).toEqual(["fabric", "accessories", "other-material"]);
    for (const w of pages) expect(w.rowFilter).toBeUndefined();
  });

  it("leaves size chart, consumption, documents and UD info for manual completion", () => {
    expect(Object.keys(MANUAL_WRITE_STEPS).sort()).toEqual(["consumption", "documents", "size-chart", "ud-select"]);
  });
});

describe("value + option matching", () => {
  it("compares numbers, dates and text the way BGMEA stores them", () => {
    expect(sameValue("4.20", "4.2")).toBe(true);
    expect(sameValue("2026-08-23T00:00:00", "2026-08-23")).toBe(true);
    expect(sameValue("Bestseller A/S", "bestseller a/s")).toBe(true);
    expect(sameValue("100", "101")).toBe(false);
  });

  it("picks exactly one dropdown option, or none", () => {
    const units = [{ value: "1", label: "YDS - (YRD)" }, { value: "2", label: "PCS - (PCE)" }, { value: "3", label: "DOZ - (DZN)" }];
    expect(matchOption("PCS", units)?.value).toBe("2");
    expect(matchOption("PCE", units)?.value).toBe("2");
    expect(matchOption("KG", units)).toBeNull();
    const banks = [{ value: "10", label: "1111 (ALPHA BANK PLC)" }, { value: "11", label: "2222 (BETA BANK PLC)" }];
    expect(matchOption("1111", banks)?.value).toBe("10");
    const amb = [{ value: "a", label: "USD" }, { value: "b", label: "USD" }];
    expect(matchOption("USD", amb)).toBeNull();
  });
});
