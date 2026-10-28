import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  computeWeekFromDate,
  parseTodDate,
  formatCutoffDate,
} from "@/server/shipment-schedule/cutoff-router";

describe("computeWeekFromDate (matches '001 Calendar for 178 Years' workbook)", () => {
  it("Jan 1 of a Thu year is in Week 1", () => {
    // 2026-01-01 is a Thursday.
    const w = computeWeekFromDate(new Date(2026, 0, 1));
    expect(w.year).toBe(2026);
    expect(w.weekNo).toBe(1);
  });

  it("2026-10-19 (Mon) is Week 43 1st cut off", () => {
    const w = computeWeekFromDate(new Date(2026, 9, 19));
    expect(w.weekNo).toBe(43);
    expect(formatCutoffDate(w.mondayDate)).toBe("19.10.2026");
    expect(formatCutoffDate(w.fridayDate)).toBe("23.10.2026");
  });

  it("2026-10-23 (Fri) is still Week 43", () => {
    const w = computeWeekFromDate(new Date(2026, 9, 23));
    expect(w.weekNo).toBe(43);
    expect(formatCutoffDate(w.mondayDate)).toBe("19.10.2026");
    expect(formatCutoffDate(w.fridayDate)).toBe("23.10.2026");
  });

  it("2026-10-26 (Mon) is Week 44 1st cut off", () => {
    const w = computeWeekFromDate(new Date(2026, 9, 26));
    expect(w.weekNo).toBe(44);
    expect(formatCutoffDate(w.mondayDate)).toBe("26.10.2026");
    expect(formatCutoffDate(w.fridayDate)).toBe("30.10.2026");
  });

  it("Dec 27 2026 (Sun) starts Week 53 (year has 53 calendar weeks)", () => {
    const w = computeWeekFromDate(new Date(2026, 11, 27));
    expect(w.weekNo).toBe(53);
  });
});

describe("parseTodDate", () => {
  it("parses '29 Jun, 2026'", () => {
    const d = parseTodDate("29 Jun, 2026");
    expect(d).toBeInstanceOf(Date);
    expect(d!.getFullYear()).toBe(2026);
    expect(d!.getMonth()).toBe(5);
    expect(d!.getDate()).toBe(29);
  });

  it("parses ISO 2026-06-29", () => {
    const d = parseTodDate("2026-06-29");
    expect(d!.getFullYear()).toBe(2026);
    expect(d!.getMonth()).toBe(5);
    expect(d!.getDate()).toBe(29);
  });

  it("parses dd.mm.yyyy 29.06.2026", () => {
    const d = parseTodDate("29.06.2026");
    expect(d!.getFullYear()).toBe(2026);
    expect(d!.getMonth()).toBe(5);
    expect(d!.getDate()).toBe(29);
  });

  it("returns null on empty / unparseable", () => {
    expect(parseTodDate("")).toBeNull();
    expect(parseTodDate("not a date")).toBeNull();
  });
});

describe("cfs-cutoff-days.json seed covers the user's named examples", () => {
  const seed = JSON.parse(
    readFileSync(
      join(__dirname, "..", "prisma", "seed-data", "cfs-cutoff-days.json"),
      "utf8",
    ),
  ) as { marketCodeToCutoffDay: Record<string, "monday" | "friday"> };

  it("maps OH, WZ, CT -> monday (user's examples)", () => {
    expect(seed.marketCodeToCutoffDay.OH).toBe("monday");
    expect(seed.marketCodeToCutoffDay.WZ).toBe("monday");
    expect(seed.marketCodeToCutoffDay.CT).toBe("monday");
  });

  it("maps CN, DX -> friday (user's examples)", () => {
    expect(seed.marketCodeToCutoffDay.CN).toBe("friday");
    expect(seed.marketCodeToCutoffDay.DX).toBe("friday");
  });

  it("has at least 80 Monday and 70 Friday codes", () => {
    const vals = Object.values(seed.marketCodeToCutoffDay);
    const mon = vals.filter((v) => v === "monday").length;
    const fri = vals.filter((v) => v === "friday").length;
    expect(mon).toBeGreaterThanOrEqual(80);
    expect(fri).toBeGreaterThanOrEqual(70);
  });
});
