/**
 * Shipment-schedule routing: given a Sales Contract HNM-summary row's
 * (TOD date, market code), decide which week + which cut-off the shipment
 * belongs in.
 *
 * Two reference datasets drive this:
 *
 * 1. CFS Cut-Off calendar (source: `CFS Cut Off-Updated From Week_38-2026.pdf`,
 *    seeded into `ReferenceData` with `type = "cfs-cutoff-day"`). Maps a
 *    market/country code (e.g. "OH", "CT", "WZ") to the day its cargo must
 *    reach the CFS: `"monday"` (1st cut off) or `"friday"` (2nd cut off).
 *
 * 2. 178-year calendar (source: `001 Calendar for 178 Years with Week
 *    Calculation..xls`). Rather than persist 9k+ rows, we COMPUTE the week
 *    number from the formula underlying that Excel template:
 *    the week containing Jan 1 of year Y is week 1; weeks start on SUNDAY.
 *    Verified against the sample files the user named -- 2026-10-19 (Mon) is
 *    "Week 43 1st cut off" and 2026-10-23 (Fri) is "Week 43 2nd cut off".
 */
import { prisma } from "@/lib/db";

export type CutoffDay = "monday" | "friday";

export interface WeekInfo {
  year: number;
  weekNo: number;
  mondayDate: Date; // Monday of this week (1st cut-off day)
  fridayDate: Date; // Friday of this week (2nd cut-off day)
}

/** Zero-time copy. */
function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/**
 * Week-number formula matching the 178-year calendar workbook:
 * week 1 of year Y starts on the Sunday on-or-before Jan 1 of Y.
 */
export function computeWeekFromDate(input: Date): WeekInfo {
  const d = startOfDay(input);
  const year = d.getFullYear();
  const jan1 = new Date(year, 0, 1);
  // Sunday on-or-before Jan 1 (Sun=0 => offset 0; else go back dayOfWeek days)
  const sunBeforeJan1 = new Date(jan1);
  sunBeforeJan1.setDate(jan1.getDate() - jan1.getDay());
  const daysSince = Math.round((d.getTime() - sunBeforeJan1.getTime()) / 86_400_000);
  const weekNo = Math.floor(daysSince / 7) + 1;
  // Monday / Friday of this week.
  const sunOfWeek = new Date(sunBeforeJan1);
  sunOfWeek.setDate(sunBeforeJan1.getDate() + (weekNo - 1) * 7);
  const mondayDate = new Date(sunOfWeek);
  mondayDate.setDate(sunOfWeek.getDate() + 1);
  const fridayDate = new Date(sunOfWeek);
  fridayDate.setDate(sunOfWeek.getDate() + 5);
  return { year, weekNo, mondayDate, fridayDate };
}

/**
 * Parse a TOD date as it appears on the H&M Summary (column N): "29 Jun, 2026"
 * or ISO "2026-06-29" or dd.mm.yyyy "29.06.2026" / dd/mm/yyyy. Returns null
 * when the string is empty or unparseable (caller decides what to do).
 */
export function parseTodDate(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;

  // "29 Jun, 2026" / "29 Jun 2026"
  const named = s.match(/^(\d{1,2})\s+([A-Za-z]{3,})\.?,?\s+(\d{4})$/);
  if (named) {
    const day = Number(named[1]);
    const month = MONTH_INDEX[named[2].slice(0, 3).toLowerCase()];
    const year = Number(named[3]);
    if (month !== undefined) return new Date(year, month, day);
  }

  // ISO yyyy-mm-dd
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));

  // dd.mm.yyyy or dd/mm/yyyy
  const dmy = s.match(/^(\d{1,2})[.\/\-](\d{1,2})[.\/\-](\d{4})$/);
  if (dmy) return new Date(Number(dmy[3]), Number(dmy[2]) - 1, Number(dmy[1]));

  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t) : null;
}

const MONTH_INDEX: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/** "19.10.2026" — matches the format the schedule UI stores cut-off dates in. */
export function formatCutoffDate(d: Date): string {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = String(d.getFullYear());
  return `${dd}.${mm}.${yyyy}`;
}

/**
 * Read the DB mapping (seeded from `prisma/seed-data/cfs-cutoff-days.json`,
 * editable in-portal). Returns `null` when the market code is not in the
 * mapping -- caller must leave the shipment unrouted (never guess).
 */
export async function resolveCutoffDayForMarket(marketCode: string): Promise<CutoffDay | null> {
  const code = String(marketCode || "").trim().toUpperCase();
  if (!code) return null;
  const row = await prisma.referenceData.findUnique({
    where: { type_code: { type: "cfs-cutoff-day", code } },
  });
  if (!row || !row.active) return null;
  const v = row.value.toLowerCase();
  return v === "monday" || v === "friday" ? v : null;
}

export interface ResolvedRoute {
  year: number;
  weekNo: number;
  weekTitle: string;        // "Week 43 1st cut off 19.10.2026 2nd 23.10.2026"
  cutoffDay: CutoffDay;     // which cutoff THIS row goes to
  cutoffLabel: string;      // "1st cut off" | "2nd cut off"
  cutoffDate: string;       // "19.10.2026" or "23.10.2026" for this row's cut-off
  mondayCutoffDate: string; // 1st cut-off date for the whole week
  fridayCutoffDate: string; // 2nd cut-off date for the whole week
}

/**
 * End-to-end resolution: TOD date + market code -> (year, week, cutoff).
 * Returns null when either input is missing/unknown; the caller should leave
 * the shipment UNROUTED in that case (fail-closed, per CLAUDE.md).
 */
export async function resolveRouteForSummaryRow(opts: {
  todRaw: string;
  marketCode: string;
}): Promise<ResolvedRoute | null> {
  const tod = parseTodDate(opts.todRaw);
  if (!tod) return null;
  const day = await resolveCutoffDayForMarket(opts.marketCode);
  if (!day) return null;

  const week = computeWeekFromDate(tod);
  const mondayStr = formatCutoffDate(week.mondayDate);
  const fridayStr = formatCutoffDate(week.fridayDate);
  const label = day === "monday" ? "1st cut off" : "2nd cut off";
  return {
    year: week.year,
    weekNo: week.weekNo,
    weekTitle: `Week ${week.weekNo} 1st cut off ${mondayStr} 2nd ${fridayStr}`,
    cutoffDay: day,
    cutoffLabel: label,
    cutoffDate: day === "monday" ? mondayStr : fridayStr,
    mondayCutoffDate: mondayStr,
    fridayCutoffDate: fridayStr,
  };
}
