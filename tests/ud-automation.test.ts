import { describe, it, expect } from "vitest";
import { UD_STEPS, UD_STEP_KEYS } from "@/server/ud-automation/steps";
import { extractFromDocument, findLabeledValue } from "@/server/ud-automation/extract";
import { computeConflicts, applyDetected, foldStates, isLowConfidence } from "@/server/ud-automation/provenance";
import { isForbiddenUdControl } from "@/server/ud-automation/guards";
import type { DetectedValue, UdFieldState } from "@/server/ud-automation/types";
import { cellKey } from "@/server/ud-automation/types";

function fs(partial: Partial<UdFieldState> & Pick<UdFieldState, "stepKey" | "fieldKey" | "value">): UdFieldState {
  return { groupIndex: 0, source: "manual", sourceRef: "", confidence: null, conflict: false, edited: false, ...partial };
}
function dv(partial: Partial<DetectedValue> & Pick<DetectedValue, "stepKey" | "fieldKey" | "value">): DetectedValue {
  return { groupIndex: 0, source: "sales-contract", sourceRef: "SC.pdf", confidence: 0.55, ...partial };
}

describe("step catalogue integrity", () => {
  it("has 12 steps numbered 1..12 with unique keys", () => {
    expect(UD_STEPS.length).toBe(12);
    expect(new Set(UD_STEP_KEYS).size).toBe(12);
    expect(UD_STEPS.map((s) => s.no)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it("keeps SRS-mandated steps manual (no auto sources)", () => {
    for (const key of ["size-chart", "consumption"]) {
      const step = UD_STEPS.find((s) => s.key === key)!;
      expect(step.manualOnly).toBe(true);
      for (const f of step.fields) expect(f.autoSources).toEqual([]);
    }
  });

  it("only allows PI to auto-fill fabric & accessories", () => {
    const step = UD_STEPS.find((s) => s.key === "fabric-accessories")!;
    for (const f of step.fields) expect(f.autoSources).toEqual(["pi"]);
  });

  it("auto-fills only the eligible garment quantity from the Sales Contract", () => {
    const step = UD_STEPS.find((s) => s.key === "garments")!;
    const qty = step.fields.find((f) => f.key === "quantityPcs")!;
    expect(qty.autoSources).toEqual(["sales-contract"]);
    // other garment fields stay manual
    expect(step.fields.find((f) => f.key === "itemDescription")!.autoSources).toEqual([]);
  });

  it("marks Excel auto-fill as unconfirmed for data steps (template pending)", () => {
    const lien = UD_STEPS.find((s) => s.key === "lien-bank")!;
    expect(lien.excelSupport).toBe("unconfirmed");
  });
});

describe("extraction (conservative, never fabricates)", () => {
  it("finds a labelled value on the same line", () => {
    expect(findLabeledValue("Port of Loading: Chittagong", ["Port of Loading"])).toBe("Chittagong");
    expect(findLabeledValue("nothing here", ["Buyer"])).toBe("");
  });

  it("returns low-confidence detections only for recognised labels", () => {
    const text = "Buyer: H&M\nExport LC No: 12345\nPort of Discharge: Hamburg\nUnrelated line";
    const out = extractFromDocument({ text, source: "sales-contract", fileName: "SC.pdf" });
    const map = Object.fromEntries(out.map((d) => [`${d.stepKey}.${d.fieldKey}`, d.value]));
    expect(map["buyer.buyerName"]).toBe("H&M");
    expect(map["export-lc.lcNumber"]).toBe("12345");
    expect(map["port.portOfDischarge"]).toBe("Hamburg");
    for (const d of out) expect(isLowConfidence(d.confidence)).toBe(true);
  });

  it("extracts nothing for an empty/unrecognised document", () => {
    expect(extractFromDocument({ text: "random text with no labels", source: "sales-contract", fileName: "x.pdf" })).toEqual([]);
    // PI rules are pending a confirmed sample layout
    expect(extractFromDocument({ text: "Fabric: cotton", source: "pi", fileName: "pi.pdf" })).toEqual([]);
  });
});

describe("provenance + conflict rules", () => {
  it("filling a blank slot is not a conflict", () => {
    const existing = [fs({ stepKey: "buyer", fieldKey: "buyerName", value: "" })];
    const detected = [dv({ stepKey: "buyer", fieldKey: "buyerName", value: "H&M" })];
    expect(computeConflicts(existing, detected)).toEqual([]);
    const applied = applyDetected(existing, detected, new Set());
    expect(applied).toHaveLength(1);
    expect(applied[0].value).toBe("H&M");
    expect(applied[0].edited).toBe(false);
  });

  it("a differing non-empty value is a conflict and is NOT overwritten without acceptance", () => {
    const existing = [fs({ stepKey: "buyer", fieldKey: "buyerName", value: "OLD", edited: true })];
    const detected = [dv({ stepKey: "buyer", fieldKey: "buyerName", value: "NEW" })];
    const conflicts = computeConflicts(existing, detected);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].existingEdited).toBe(true);

    // not accepted → no change
    expect(applyDetected(existing, detected, new Set())).toEqual([]);
    // accepted → overwrite
    const accepted = new Set([cellKey("buyer", "buyerName", 0)]);
    const applied = applyDetected(existing, detected, accepted);
    expect(applied).toHaveLength(1);
    expect(applied[0].value).toBe("NEW");
  });

  it("an identical value is left unchanged and raises no conflict", () => {
    const existing = [fs({ stepKey: "port", fieldKey: "portOfLoading", value: "Chittagong" })];
    const detected = [dv({ stepKey: "port", fieldKey: "portOfLoading", value: "Chittagong" })];
    expect(computeConflicts(existing, detected)).toEqual([]);
    expect(applyDetected(existing, detected, new Set())).toEqual([]);
  });

  it("flags low-confidence filled values for review", () => {
    const existing: UdFieldState[] = [];
    const detected = [dv({ stepKey: "port", fieldKey: "portOfLoading", value: "Chittagong", confidence: 0.4 })];
    const applied = applyDetected(existing, detected, new Set());
    expect(applied[0].conflict).toBe(true);
  });

  it("never applies an empty detected value", () => {
    const existing = [fs({ stepKey: "buyer", fieldKey: "buyerName", value: "KEEP" })];
    const detected = [dv({ stepKey: "buyer", fieldKey: "buyerName", value: "" })];
    expect(applyDetected(existing, detected, new Set())).toEqual([]);
  });

  it("never-submit guard forbids final-action controls but allows navigation/fill", () => {
    for (const bad of ["Submit", "Save", "Save UD", "Finalize", "Approve", "Confirm", "Apply", "Acknowledge", "Complete", "Lock UD"]) {
      expect(isForbiddenUdControl(bad)).toBe(true);
    }
    for (const ok of ["Login", "Search", "Next", "Add Row", "Edit", "Browse", "Upload", "Cancel", ""]) {
      expect(isForbiddenUdControl(ok)).toBe(false);
    }
  });

  it("foldStates replaces changed cells and keeps the rest", () => {
    const current = [fs({ stepKey: "a", fieldKey: "x", value: "1" }), fs({ stepKey: "a", fieldKey: "y", value: "2" })];
    const changed = [fs({ stepKey: "a", fieldKey: "x", value: "9" })];
    const out = foldStates(current, changed);
    expect(out.find((s) => s.fieldKey === "x")!.value).toBe("9");
    expect(out.find((s) => s.fieldKey === "y")!.value).toBe("2");
  });
});
