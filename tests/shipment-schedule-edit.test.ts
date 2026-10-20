import { describe, it, expect } from "vitest";
import { validateScheduleEdit, recomputeLineValue, isEditableField, LOCKED_FIELDS } from "@/server/shipment-schedule/edit";

describe("validateScheduleEdit — field-level validation (§4.2)", () => {
  it("rejects edits to locked identity fields", () => {
    for (const f of LOCKED_FIELDS) {
      const r = validateScheduleEdit(f, "anything");
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/locked|not an editable/i);
    }
  });

  it("rejects an unknown field", () => {
    expect(validateScheduleEdit("totallyMadeUp", "x").ok).toBe(false);
  });

  it("validates PCS as a positive whole number", () => {
    expect(validateScheduleEdit("pcs", "2000").normalized).toBe("2000");
    expect(validateScheduleEdit("pcs", "1,500").normalized).toBe("1500");
    expect(validateScheduleEdit("pcs", "0").ok).toBe(false);
    expect(validateScheduleEdit("pcs", "12.5").ok).toBe(false);
    expect(validateScheduleEdit("pcs", "-3").ok).toBe(false);
  });

  it("validates FOB as a non-negative number", () => {
    expect(validateScheduleEdit("fob", "12.64").normalized).toBe("12.64");
    expect(validateScheduleEdit("fob", "-1").ok).toBe(false);
    expect(validateScheduleEdit("fob", "abc").ok).toBe(false);
  });

  it("constrains cut-off to 1st / 2nd", () => {
    expect(validateScheduleEdit("cutOff", "1st").normalized).toBe("1st");
    expect(validateScheduleEdit("cutOff", "2ND").normalized).toBe("2nd");
    expect(validateScheduleEdit("cutOff", "3rd").ok).toBe(false);
  });

  it("requires DD.MM.YYYY cut-off dates", () => {
    expect(validateScheduleEdit("firstCutOff", "09.06.2026").ok).toBe(true);
    expect(validateScheduleEdit("secondCutOff", "2026-06-09").ok).toBe(false);
  });

  it("uppercases market code and forbids blanking a mandatory field", () => {
    expect(validateScheduleEdit("marketCode", "nhw12").normalized).toBe("NHW12");
    expect(validateScheduleEdit("marketCode", "  ").ok).toBe(false);
    expect(validateScheduleEdit("style", "").ok).toBe(false);
  });

  it("allows free-text optional fields to be set or blanked", () => {
    expect(validateScheduleEdit("composition", "100% cotton").ok).toBe(true);
    expect(validateScheduleEdit("invoiceNo", "").ok).toBe(true);
  });
});

describe("recomputeLineValue", () => {
  it("computes PCS × FOB rounded to 2 decimals", () => {
    expect(recomputeLineValue(2000, 12.64)).toBe(25280);
    expect(recomputeLineValue(100, 1.25)).toBe(125);
    expect(recomputeLineValue(3, 1.01)).toBe(3.03);
  });
});

describe("isEditableField", () => {
  it("recognises editable fields and rejects others", () => {
    expect(isEditableField("pcs")).toBe(true);
    expect(isEditableField("orderNo")).toBe(false);
  });
});
