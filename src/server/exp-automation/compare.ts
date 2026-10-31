import type { FieldControl } from "./types";

/**
 * Pure comparison between the Excel value and what the portal form currently
 * holds, per control type. A field "matches" (and is left untouched) when the
 * two are equivalent after type-aware normalisation; otherwise it is reported as
 * mismatched and will be filled from the Excel value. Nothing here mutates state.
 */

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

/** Normalise a date string to YYYY-MM-DD from any of the formats we may see. */
export function normDate(v: string): string {
  const s = (v || "").trim();
  if (!s) return "";
  // ISO-ish: 2026-09-10 or 2026-09-10 00:00:00
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  // DD.MM.YYYY  or DD/MM/YYYY
  m = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  // DD-MMM-YYYY (e.g. 04-Sep-2026)
  m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (m) {
    const mon = MONTHS[m[2].toLowerCase()];
    if (mon) return `${m[3]}-${mon}-${m[1].padStart(2, "0")}`;
  }
  // DD-MM-YYYY
  m = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return s.toLowerCase();
}

const MONTHS_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Render an Excel date in the SAME format the portal field currently shows, so we
 * write a value the APEX control accepts. `sample` is the record's existing value
 * read from the live control; when it is blank or its pattern is unrecognised the
 * Excel string is returned unchanged (we never guess a format).
 */
export function formatDateLike(excel: string, sample: string): string {
  const iso = normDate(excel); // YYYY-MM-DD
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return excel.trim();
  const [, yyyy, mm, dd] = m;
  const s = (sample || "").trim();
  if (!s) return excel.trim();
  if (/^\d{1,2}[./]\d{1,2}[./]\d{4}$/.test(s)) {
    const sep = s.includes(".") ? "." : "/";
    return `${dd}${sep}${mm}${sep}${yyyy}`;
  }
  if (/^\d{1,2}-[A-Za-z]{3}-\d{4}$/.test(s)) {
    return `${dd}-${MONTHS_ABBR[Number(mm) - 1]}-${yyyy}`;
  }
  if (/^[A-Za-z]{3}-\d{1,2}-\d{4}$/.test(s)) {
    return `${MONTHS_ABBR[Number(mm) - 1]}-${dd}-${yyyy}`;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${yyyy}-${mm}-${dd}`;
  if (/^\d{1,2}-\d{1,2}-\d{4}$/.test(s)) return `${dd}-${mm}-${yyyy}`;
  return excel.trim();
}

/** Numeric equivalence tolerant of thousands separators and trailing zeros. */
export function normNumber(v: string): string {
  const s = (v || "").replace(/,/g, "").trim();
  if (s === "") return "";
  const n = Number(s);
  if (!Number.isFinite(n)) return s.toLowerCase();
  // Compare on value, not representation: 2004.30 == 2004.3, 150 == 150.00
  return String(Math.round(n * 1e4) / 1e4);
}

/** Loose text / select equivalence: trim, collapse spaces, case-insensitive. */
export function normText(v: string): string {
  return (v || "").toLowerCase().replace(/\s+/g, " ").trim();
}

export function valuesEquivalent(control: FieldControl, excel: string, portal: string): boolean {
  switch (control) {
    case "date": return normDate(excel) === normDate(portal);
    case "number": return normNumber(excel) === normNumber(portal);
    case "select":
    case "text":
    default: {
      const e = normText(excel);
      const p = normText(portal);
      if (e === p) return true;
      // A select often shows "306-Customs House, lCD, Chattogram" while the Excel
      // may carry just the code "306" or the name — accept a prefix/startsWith.
      if (e && p && (p.startsWith(e) || e.startsWith(p))) return true;
      return false;
    }
  }
}

/**
 * One field's fill result: the Excel value written and what the control showed on
 * read-back. Used to report which fields were populated (NOT a match comparison).
 */
export interface FieldDiff {
  key: string;
  portalLabel: string;
  excel: string;
  portal: string;
}
