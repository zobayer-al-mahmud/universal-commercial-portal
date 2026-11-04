import { describe, it, expect } from "vitest";
import { extractPoTransportMode } from "@/server/shipment-schedule/auto-schedule";

/**
 * `extractPoTransportMode` pulls "Sea" or "Air" out of the PO's "Terms of
 * Delivery" line (user rule 2026-11-03). The exact H&M wording is:
 *   "Transport by Sea, Packing Mode Flat, FCA according to the latest edition
 *    of Incoterms at the order placement date."
 * The result lands in the Mode column of every (TOD × market) row routed from
 * that PO, so a parse miss MUST be a silent "" (leave the column blank, never
 * guess).
 */
describe("extractPoTransportMode", () => {
  it("H&M standard Sea line → 'Sea'", () => {
    expect(
      extractPoTransportMode(
        "Transport by Sea, Packing Mode Flat, FCA according to the latest edition of Incoterms at the order placement date.",
      ),
    ).toBe("Sea");
  });

  it("H&M standard Air line → 'Air'", () => {
    expect(
      extractPoTransportMode(
        "Transport by Air, Packing Mode Flat, FCA according to the latest edition of Incoterms at the order placement date.",
      ),
    ).toBe("Air");
  });

  it("case-insensitive on the mode word", () => {
    expect(extractPoTransportMode("Transport by SEA, Packing Mode Flat")).toBe("Sea");
    expect(extractPoTransportMode("Transport by air, Packing Mode Flat")).toBe("Air");
  });

  it("extra whitespace between the words", () => {
    expect(extractPoTransportMode("Transport   by   Sea,")).toBe("Sea");
  });

  it("blank / null / undefined → ''", () => {
    expect(extractPoTransportMode(null)).toBe("");
    expect(extractPoTransportMode(undefined)).toBe("");
    expect(extractPoTransportMode("")).toBe("");
  });

  it("unknown wording → '' (never guess)", () => {
    expect(extractPoTransportMode("Shipping by sea freight only")).toBe("");
    expect(extractPoTransportMode("FCA according to the latest edition")).toBe("");
  });

  it("ignores the Packing Mode word (would otherwise collide)", () => {
    expect(
      extractPoTransportMode(
        "Packing Mode Flat, Transport by Sea, FCA according to the latest edition",
      ),
    ).toBe("Sea");
  });
});
