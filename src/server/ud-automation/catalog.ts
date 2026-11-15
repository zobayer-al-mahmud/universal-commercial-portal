/**
 * UD Automation — catalog parser/validator (PURE, no I/O so it is unit-testable).
 *
 * Parses the BGMEA UD-list export into per-factory catalog entries. The export
 * lists, per factory, a section header ("1095 - ABM FASHIONS LTD.") followed by a
 * "Tracking No / UD Date / Membership ID" table. It also accepts a single-factory
 * table with no section header (factory is then inferred from each row).
 *
 * Nothing is dropped silently: rows that cannot be parsed or fail validation are
 * returned in `errors`, and in-file repeats of a (factory, tracking no) are
 * returned in `duplicates`. The caller decides what to persist and reports both.
 *
 * The factory a row belongs to is resolved from its data, not from which screen
 * the user is on: membership id (if a known factory) first, else the 4 digits that
 * follow "UD" in the tracking number. The section header is only used to
 * cross-check and to flag mismatches.
 */

import { isKnownFactory } from "./factories";

export interface ParsedCatalogEntry {
  factoryId: string;
  trackingNo: string;
  udDate: string; // raw, as listed (dd/mm/yyyy)
  udDateIso: string; // normalised yyyy-mm-dd, or "" if unparseable
  membershipId: string;
  line: number; // 1-based source line
}

export interface CatalogRowError {
  line: number;
  raw: string;
  reason: string;
}

export interface CatalogDuplicate {
  entry: ParsedCatalogEntry;
  firstSeenLine: number;
}

export interface CatalogSectionSummary {
  factoryId: string;
  name: string;
  rows: number;
}

export interface CatalogParseResult {
  entries: ParsedCatalogEntry[]; // unique + valid
  duplicates: CatalogDuplicate[]; // in-file repeats of (factory, tracking no)
  errors: CatalogRowError[]; // malformed / unresolved rows
  sections: CatalogSectionSummary[];
}

const SECTION_RE = /^(\d{3,6})\s*[-–—]\s*(.+?)\.?\s*$/;
const TRACKING_RE = /^UD\d{6,}$/i;

/** Is this the "Tracking No / UD Date / Membership ID" column header row? */
function isHeaderRow(cols: string[]): boolean {
  const joined = cols.join(" ").toLowerCase();
  return joined.includes("tracking") && joined.includes("date");
}

/** Split a data line on tabs, or on runs of 2+ spaces when there are no tabs. */
function splitColumns(line: string): string[] {
  if (line.includes("\t")) return line.split("\t").map((c) => c.trim()).filter((c) => c !== "");
  return line.split(/\s{2,}/).map((c) => c.trim()).filter((c) => c !== "");
}

/** Normalise a dd/mm/yyyy date to yyyy-mm-dd, or "" if it is not a valid date. */
export function normaliseUdDate(raw: string): string {
  const m = raw.trim().match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/);
  if (!m) return "";
  let [, dd, mm, yyyy] = m;
  if (yyyy.length === 2) yyyy = (Number(yyyy) >= 70 ? "19" : "20") + yyyy;
  const d = Number(dd);
  const mo = Number(mm);
  const y = Number(yyyy);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 2000 || y > 2100) return "";
  // Reject impossible day-of-month (e.g. 31/02).
  const dim = new Date(y, mo, 0).getDate();
  if (d > dim) return "";
  return `${y.toString().padStart(4, "0")}-${mo.toString().padStart(2, "0")}-${d.toString().padStart(2, "0")}`;
}

/** Resolve the factory a tracking number belongs to: the 4 digits after "UD". */
function factoryFromTracking(trackingNo: string): string | null {
  const m = trackingNo.toUpperCase().match(/^UD(\d{4})\d+$/);
  if (!m) return null;
  return isKnownFactory(m[1]) ? m[1] : null;
}

export function parseUdCatalog(text: string): CatalogParseResult {
  const entries: ParsedCatalogEntry[] = [];
  const duplicates: CatalogDuplicate[] = [];
  const errors: CatalogRowError[] = [];
  const sectionRows = new Map<string, CatalogSectionSummary>();
  const seen = new Map<string, number>(); // "factoryId|trackingNo" -> first line

  let currentSection: { factoryId: string; name: string } | null = null;

  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const line = rawLine.trim();
    const lineNo = i + 1;
    if (line === "") continue;

    // Section header ("<id> - <NAME>") — only when it is NOT itself a data row.
    const sec = line.match(SECTION_RE);
    if (sec && !/^UD\d/i.test(line)) {
      const id = sec[1];
      currentSection = { factoryId: id, name: sec[2].trim() };
      if (!sectionRows.has(id)) sectionRows.set(id, { factoryId: id, name: sec[2].trim(), rows: 0 });
      continue;
    }

    const cols = splitColumns(line);
    if (cols.length === 0) continue;
    if (isHeaderRow(cols)) continue;

    const trackingNo = (cols[0] || "").toUpperCase();
    const udDate = cols[1] || "";
    const membershipRaw = (cols[2] || "").trim();

    if (!TRACKING_RE.test(trackingNo)) {
      errors.push({ line: lineNo, raw: line, reason: `Not a valid UD tracking number ("${cols[0] ?? ""}").` });
      continue;
    }

    // Resolve the owning factory from the row's own data (authoritative), then
    // cross-check the section header and membership id.
    const fromTracking = factoryFromTracking(trackingNo);
    const fromMembership = isKnownFactory(membershipRaw) ? membershipRaw : null;
    const factoryId = fromMembership ?? fromTracking ?? (currentSection && isKnownFactory(currentSection.factoryId) ? currentSection.factoryId : null);

    if (!factoryId) {
      errors.push({ line: lineNo, raw: line, reason: "Could not determine a known factory from the tracking number or membership id." });
      continue;
    }
    if (!trackingNo.startsWith(`UD${factoryId}`)) {
      errors.push({ line: lineNo, raw: line, reason: `Tracking number ${trackingNo} does not match factory ${factoryId}.` });
      continue;
    }
    if (fromMembership && fromTracking && fromMembership !== fromTracking) {
      errors.push({ line: lineNo, raw: line, reason: `Membership id ${membershipRaw} does not match tracking number ${trackingNo}.` });
      continue;
    }
    if (currentSection && isKnownFactory(currentSection.factoryId) && currentSection.factoryId !== factoryId) {
      errors.push({ line: lineNo, raw: line, reason: `Row for factory ${factoryId} found under the ${currentSection.factoryId} section.` });
      continue;
    }

    const udDateIso = normaliseUdDate(udDate);
    if (udDate.trim() !== "" && udDateIso === "") {
      errors.push({ line: lineNo, raw: line, reason: `Invalid UD date ("${udDate}").` });
      continue;
    }

    const entry: ParsedCatalogEntry = {
      factoryId,
      trackingNo,
      udDate: udDate.trim(),
      udDateIso,
      membershipId: membershipRaw || factoryId,
      line: lineNo,
    };

    const key = `${factoryId}|${trackingNo}`;
    const firstSeen = seen.get(key);
    if (firstSeen !== undefined) {
      duplicates.push({ entry, firstSeenLine: firstSeen });
      continue;
    }
    seen.set(key, lineNo);
    entries.push(entry);
    const s = sectionRows.get(factoryId) ?? { factoryId, name: "", rows: 0 };
    s.rows += 1;
    sectionRows.set(factoryId, s);
  }

  return { entries, duplicates, errors, sections: [...sectionRows.values()] };
}
