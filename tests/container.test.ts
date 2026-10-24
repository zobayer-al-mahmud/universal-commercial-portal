import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { parseContainerResultHtml, verifyContainerMatch, normalizeContainerNo } from "@/server/container/parse";

const fx = (n: string) => readFileSync(join(process.cwd(), "tests", "fixtures", n), "utf8");

describe("CTG Port container result parser (real portal HTML)", () => {
  const found = parseContainerResultHtml(fx("ctg-container-found.html"));

  it("parses a found container's fields", () => {
    expect(found.found).toBe(true);
    expect(found.containerNo).toBe("TLLU4872965");
    expect(found.positionLocation).toBe("Slot : T-OC89, Block : , Yard :");
    expect(found.slot).toBe("T-OC89");
    expect(found.category).toBe("IMPRT");
    expect(found.type).toBe("MTY");
    expect(found.destination).toBe("2599");
    expect(found.mlo).toBe("MSL, MAERSK A/S");
    expect(found.shippingAgent).toBe("MBL, MAERSK BANGLADESH LTD");
    expect(found.isoCode).toBe("45G1");
    expect(found.containerSize).toBe("40");
    expect(found.containerHeight).toBe("9.6");
  });

  it("detects a not-found result", () => {
    const r = parseContainerResultHtml(fx("ctg-container-notfound.html"));
    expect(r.found).toBe(false);
    expect(r.message).toMatch(/not found/i);
    expect(r.containerNo).toBe("");
  });

  it("ignores the commented-out duplicate block", () => {
    // The portal comments out a second "Detail Information" table; those rows
    // must not leak into the parsed fields.
    expect(Object.keys(found.fields)).not.toContain("last vessel name");
  });

  it("verifies a matching container (number only)", () => {
    expect(verifyContainerMatch(found, { containerNo: "tllu 4872965" })).toEqual({ ok: true });
  });

  it("rejects a mismatched container number", () => {
    const v = verifyContainerMatch(found, { containerNo: "MSKU1234567" });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/does not match/i);
  });

  it("verifies an expected location substring when supplied", () => {
    expect(verifyContainerMatch(found, { containerNo: "TLLU4872965", location: "T-OC89" }).ok).toBe(true);
    expect(verifyContainerMatch(found, { containerNo: "TLLU4872965", location: "Z-ZZ00" }).ok).toBe(false);
  });

  it("normalizes container numbers", () => {
    expect(normalizeContainerNo("tllu-4872965")).toBe("TLLU4872965");
  });
});
