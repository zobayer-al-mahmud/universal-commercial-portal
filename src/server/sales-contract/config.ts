/**
 * Pure helpers for the H&M Sales Contract configuration layer (2026-10-26 spec):
 *
 *  - buildContractRef         AGL/H&M/{contractNo}-{folder}/{poYear}
 *  - lookupBuyerCode          (contractNo, folder) → "AGL 349 A" via SalesContractBuyerCode
 *  - buildMerchandiserName    "S-{season}-{poYear}- A, B, C" from SalesContractFolderMapping
 *  - parseSeason              "4-2026" → { season: "4", year: "2026" }
 *  - extractPoYear            "20 Apr, 2026" | "20.04.2026" | ISO → "2026"
 *
 * No I/O here. Database access lives in config-intake.ts.
 */
import type { SalesContractPdfHeader } from "./types";

export interface ParsedSeason {
  season: string;
  year: string;
}

/**
 * Parse the H&M `Season:` label (e.g. "4-2026") into { season, year }. Returns
 * `null` for a value that is not confidently a `<digits>-<4-digit-year>`
 * pattern, so callers can route the PO to review per spec Â§5.8 instead of
 * inventing a value.
 */
export function parseSeason(raw: string | null | undefined): ParsedSeason | null {
  if (!raw) return null;
  const m = String(raw).trim().match(/^(\d{1,2})\s*-\s*(\d{4})$/);
  if (!m) return null;
  return { season: m[1], year: m[2] };
}

/**
 * Pull the 4-digit year from a Date-of-Order string. Supports the H&M
 * supplier-PDF date formats seen so far: "20 Apr, 2026", "20-Apr-2026",
 * "20/04/2026", "2026-04-20". Returns `""` when no 4-digit year is present.
 */
export function extractPoYear(dateOfOrder: string | null | undefined): string {
  if (!dateOfOrder) return "";
  const m = String(dateOfOrder).match(/\b(19|20)\d{2}\b/);
  return m ? m[0] : "";
}

/**
 * `AGL/H&M/97-A/2026` – the H&M contract reference. Order of inputs is
 * (contractNo, folderLetter, poYear) because that is the display order.
 *
 * Throws if any part is empty – the caller is expected to validate inputs
 * and surface a review warning rather than letting a half-formed ref through.
 */
export function buildContractRef(contractNo: string, folderLetter: string, poYear: string): string {
  const c = String(contractNo ?? "").trim();
  const f = String(folderLetter ?? "").trim().toUpperCase();
  const y = String(poYear ?? "").trim();
  if (!c || !f || !y) {
    throw new Error(
      `Cannot build H&M contract ref: contractNo=${JSON.stringify(c)}, folder=${JSON.stringify(f)}, poYear=${JSON.stringify(y)}`,
    );
  }
  return `AGL/H&M/${c}-${f}/${y}`;
}

/**
 * `S-4-2026- Manik, Aslam, Shaheen` – folder config supplies the names, PO
 * supplies season + year. Blank names → `"S-4-2026-"` with a trailing dash,
 * which the UI shows as "needs folder config".
 */
export function buildMerchandiserName(
  season: string,
  poYear: string,
  merchandisers: readonly string[],
): string {
  const s = String(season ?? "").trim();
  const y = String(poYear ?? "").trim();
  const names = (merchandisers ?? []).map((n) => String(n ?? "").trim()).filter(Boolean);
  const prefix = `S-${s}-${y}-`;
  return names.length ? `${prefix} ${names.join(", ")}` : prefix;
}

/**
 * Resolve a SalesContractPdfHeader (as extracted from the PO PDF) into the derived fields
 * used by the Summary writer. Does not touch the DB – pass in the folder
 * mapping separately so this remains pure.
 */
export interface ResolveInput {
  header: SalesContractPdfHeader;
  contractNo: string;
  folderLetter: string;
  merchandisers: readonly string[];
}
export interface ResolveOutput {
  contractRef: string;         // column A
  poYear: string;              // used in ref + merchandiser name
  season: string;              // used in merchandiser name
  merchandiserName: string;    // column Q
  warnings: string[];          // review-queue codes if any input was missing
}
export function resolvePoDerivedFields(input: ResolveInput): ResolveOutput {
  const warnings: string[] = [];
  const parsed = parseSeason(input.header.season);
  if (!parsed) warnings.push("SEASON_UNPARSEABLE");
  const season = parsed?.season ?? "";
  // PO year preference: Season year, then Date of Order, then empty.
  let poYear = parsed?.year ?? "";
  if (!poYear) poYear = extractPoYear(input.header.dateOfOrder);
  if (!poYear) warnings.push("PO_YEAR_UNKNOWN");

  let contractRef = "";
  if (input.contractNo && input.folderLetter && poYear) {
    contractRef = buildContractRef(input.contractNo, input.folderLetter, poYear);
  } else {
    if (!input.contractNo) warnings.push("CONTRACT_NO_MISSING");
    if (!input.folderLetter) warnings.push("FOLDER_LETTER_MISSING");
  }
  if (!input.merchandisers || input.merchandisers.length === 0) warnings.push("FOLDER_MERCHANDISERS_MISSING");

  const merchandiserName = buildMerchandiserName(season, poYear, input.merchandisers);
  return { contractRef, poYear, season, merchandiserName, warnings };
}
