import { describe, it, expect } from "vitest";
import { parseUdCatalog, normaliseUdDate } from "@/server/ud-automation/catalog";

const MULTI = `1095 - ABM FASHIONS LTD.

Tracking No\tUD Date\tMembership ID
UD10952026004\t02/09/2026\t1095
UD10952026003\t17/08/2026\t1095

4148 - ANANTA GARMENTS LTD.

Tracking No\tUD Date\tMembership ID
UD41482026019\t11/11/2026\t4148
UD41482026020\t09/11/2026\t4148
UD41482026017\t08/11/2026\t4148
`;

describe("normaliseUdDate", () => {
  it("converts dd/mm/yyyy to iso", () => {
    expect(normaliseUdDate("02/09/2026")).toBe("2026-09-02");
    expect(normaliseUdDate("11/11/2026")).toBe("2026-11-11");
  });
  it("rejects impossible dates", () => {
    expect(normaliseUdDate("31/02/2026")).toBe("");
    expect(normaliseUdDate("00/01/2026")).toBe("");
    expect(normaliseUdDate("not a date")).toBe("");
  });
});

describe("parseUdCatalog — multi-factory export", () => {
  const res = parseUdCatalog(MULTI);

  it("parses every valid row across sections", () => {
    expect(res.entries.length).toBe(5);
    expect(res.errors).toEqual([]);
    expect(res.duplicates).toEqual([]);
  });

  it("assigns each row to the factory from its own data", () => {
    const byFactory = res.entries.reduce<Record<string, number>>((a, e) => ((a[e.factoryId] = (a[e.factoryId] ?? 0) + 1), a), {});
    expect(byFactory).toEqual({ "1095": 2, "4148": 3 });
  });

  it("normalises the date and keeps the raw", () => {
    const e = res.entries.find((x) => x.trackingNo === "UD10952026004")!;
    expect(e.udDate).toBe("02/09/2026");
    expect(e.udDateIso).toBe("2026-09-02");
  });

  it("summarises sections", () => {
    const s1095 = res.sections.find((s) => s.factoryId === "1095")!;
    expect(s1095.rows).toBe(2);
  });
});

describe("parseUdCatalog — validation", () => {
  it("reports in-file duplicates instead of dropping them", () => {
    const res = parseUdCatalog("UD41482026019\t11/11/2026\t4148\nUD41482026019\t11/11/2026\t4148");
    expect(res.entries.length).toBe(1);
    expect(res.duplicates.length).toBe(1);
    expect(res.duplicates[0].entry.trackingNo).toBe("UD41482026019");
    expect(res.duplicates[0].firstSeenLine).toBe(1);
  });

  it("reports malformed tracking numbers", () => {
    const res = parseUdCatalog("GARBAGE\t11/11/2026\t4148");
    expect(res.entries.length).toBe(0);
    expect(res.errors.length).toBe(1);
    expect(res.errors[0].reason).toMatch(/tracking number/i);
  });

  it("reports an invalid date", () => {
    const res = parseUdCatalog("UD41482026019\t31/02/2026\t4148");
    expect(res.entries.length).toBe(0);
    expect(res.errors[0].reason).toMatch(/invalid ud date/i);
  });

  it("rejects an unknown factory", () => {
    const res = parseUdCatalog("UD99992026001\t11/11/2026\t9999");
    expect(res.entries.length).toBe(0);
    expect(res.errors[0].reason).toMatch(/known factory/i);
  });

  it("flags a membership id that disagrees with the tracking number", () => {
    const res = parseUdCatalog("UD41482026019\t11/11/2026\t1095");
    expect(res.entries.length).toBe(0);
    expect(res.errors[0].reason).toMatch(/does not match/i);
  });

  it("flags a row placed under the wrong section", () => {
    const res = parseUdCatalog("1095 - ABM FASHIONS LTD.\nUD41482026019\t11/11/2026\t4148");
    expect(res.entries.length).toBe(0);
    expect(res.errors[0].reason).toMatch(/section/i);
  });

  it("infers the factory from the tracking number when membership id is absent", () => {
    const res = parseUdCatalog("UD29662026004\t22/09/2026");
    expect(res.entries.length).toBe(1);
    expect(res.entries[0].factoryId).toBe("2966");
  });
});
