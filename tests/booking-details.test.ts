import { describe, it, expect } from "vitest";
import {
  assembleBookingDetails,
  extractFrCode,
  pickDynamicFieldValue,
  sanitizeFieldValue,
  type RawBookingDetails,
} from "@/server/booking-correction/booking-details";

function raw(over: Partial<RawBookingDetails> = {}): RawBookingDetails {
  return {
    grossWeight: "106.52", cartons: "9", quantity: "360",
    status: "CONFIRMED", confirmationNumber: "CTG4425608",
    poNumber: "726936/5-2027", sku: "LH/7656", manufacturer: "ANANTA GARMENTS LTD",
    dynamicFields: [
      { label: "PL1", value: "Booking Request" },
      { label: "PL2", value: "" },
      { label: "FR", value: "PLW256" },
      { label: "Freight Service", value: "SEA" },
      { label: "Product Name", value: "OLA L/S DENIM SHIRT" },
    ],
    ...over,
  };
}

describe("sanitizeFieldValue — reject label echoes & placeholders", () => {
  it("accepts a genuine value", () => {
    expect(sanitizeFieldValue("PLW256", "FR")).toBe("PLW256");
  });
  it("rejects the value when it echoes its own label (the old 'FR' bug)", () => {
    expect(sanitizeFieldValue("FR", "FR")).toBe("");
    expect(sanitizeFieldValue("fr", "FR")).toBe("");
  });
  it("rejects dropdown placeholders", () => {
    for (const p of ["Select...", "Select", "Please select", "Choose", "--", "N/A", "none", "-", "…"]) {
      expect(sanitizeFieldValue(p, "Manufacturer")).toBe("");
    }
  });
  it("trims and collapses internal whitespace", () => {
    expect(sanitizeFieldValue("  PLW 256 ", "FR")).toBe("PLW 256");
  });
});

describe("extractFrCode / pickDynamicFieldValue", () => {
  it("picks the FR dynamic field value, not the label", () => {
    expect(extractFrCode(raw().dynamicFields)).toBe("PLW256");
  });
  it("returns '' when FR only echoes its label (so match stays 'not verified', never a false mismatch)", () => {
    const fields = [{ label: "FR", value: "FR" }, { label: "Freight Service", value: "SEA" }];
    expect(extractFrCode(fields)).toBe("");
  });
  it("skips a junk FR pairing and keeps looking for a real value", () => {
    const fields = [
      { label: "FR", value: "Select..." }, // stray / wrong control
      { label: "FR", value: "ESW267" }, // the real one
    ];
    expect(extractFrCode(fields)).toBe("ESW267");
  });
  it("tolerates a trailing marker on the FR label (FR:, FR Code)", () => {
    expect(extractFrCode([{ label: "FR:", value: "NLW174" }])).toBe("NLW174");
    expect(extractFrCode([{ label: "FR Code", value: "NLW174" }])).toBe("NLW174");
  });
  it("does not confuse 'Freight Service' for the FR field", () => {
    const fields = [{ label: "Freight Service", value: "SEA" }];
    expect(extractFrCode(fields)).toBe("");
    expect(pickDynamicFieldValue(fields, /^FR$/i)).toBe("");
  });
  it("is empty for an empty field list", () => {
    expect(extractFrCode([])).toBe("");
    expect(extractFrCode(undefined)).toBe("");
  });
});

describe("assembleBookingDetails", () => {
  it("assembles the PLW256 booking with the correct FR value", () => {
    const d = assembleBookingDetails(raw());
    expect(d).toMatchObject({
      grossWeight: "106.52", cartons: "9", quantity: "360",
      status: "CONFIRMED", poNumber: "726936/5-2027", sku: "LH/7656", frCode: "PLW256",
    });
  });
  it("never surfaces 'FR' or 'Select...' as real values", () => {
    const d = assembleBookingDetails(raw({
      dynamicFields: [{ label: "FR", value: "FR" }],
      manufacturer: "Select...",
    }));
    expect(d.frCode).toBe("");
    expect(d.manufacturer).toBe("");
  });
});
