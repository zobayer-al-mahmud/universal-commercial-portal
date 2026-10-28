/**
 * Consolidated H&M Sales Contract Summary Excel writer (2026-10-26 spec Â§9, Â§11, Â§12).
 *
 * Workbook layout: one worksheet "H&M" with the 21-column header the user
 * requires. Rows are grouped by (commercialContNo, folderLetter) sections,
 * sorted by contract number ascending then by the folder's configured
 * sequence. New PO rows are inserted at the correct position inside their
 * section; rows belonging to OTHER contracts are preserved verbatim, together
 * with every manually-entered Remarks / Without Discount / Discount FOB
 * value already present in the sheet.
 *
 * Strategy:
 *  1. Open the template workbook (if `templatePath` points at an existing
 *     file) and read every row of the "H&M" sheet into memory, keyed by
 *     a stable PO + marketCode fingerprint. If no template, start fresh.
 *  2. For each PO in `pos`: build its summary rows, then OVERWRITE any
 *     existing rows that match this PO's fingerprint, PRESERVING columns
 *     P/T/U from the previous row. Rows that match no PO in `pos` are
 *     carried through unchanged.
 *  3. Re-sort by (contractNo ASC, folder sequence ASC, PO sequence ASC)
 *     and write to a new file.
 *
 * Never overwrites the input template (`outputPath` must differ from
 * `templatePath`), matching the user's Â§9 preserve-original rule.
 */
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import ExcelJS from "exceljs";
import type { SalesContractSummaryRow } from "./summary-rows";
import { mapToSummaryRows, type SalesContractSummaryConfig } from "./summary-rows";
import type { SalesContractPoExtract } from "./types";

/** 21-column header, in order (spec Â§9). */
export const SUMMARY_HEADERS = [
  "Marchent Cont. No.",
  "Date",
  "Buyer Code",
  "Commercial Cont. No.",
  "Date",
  "Order No.",
  "Order Qty",
  "Style No.",
  "FOB",
  "Item Des.",
  "Cat",
  "HTS",
  "CONTRACT VALUE",
  "TOD",
  "COUNTRY",
  "REMARKS",
  "Merchandiser Name",
  "pack/set Qty",
  "pack/set",
  "Without Discount / Old FOB",
  "Discount FOB con: date",
] as const;

/** Columns the writer NEVER sets automatically – manual-only (spec Â§9, Â§11-8). */
const MANUAL_COLS = new Set<number>([16 /* REMARKS */, 20 /* Without Discount */, 21 /* Discount FOB con: date */]);

const SHEET_NAME = "H&M";
const HEADER_ROW = 1;
const DATA_START_ROW = 2;

export interface SalesContractSummaryWriteOptions {
  /** Existing Summary workbook to update. Omit for a fresh file. Never
   *  overwritten – see outputPath. */
  templatePath?: string;
  /** Where the regenerated workbook is written. */
  outputPath: string;
  /** PO extraction + per-PO config for every PO in scope. */
  pos: { poId: string; po: SalesContractPoExtract; config: SalesContractSummaryConfig }[];
  /** Sort order for folder letters (`[{ folderLetter: "A", sequence: 0 }, …]`).
   *  Folders not listed sort last, alphabetically. */
  folderSequence: { folderLetter: string; sequence: number }[];
}

export interface SalesContractSummaryWriteResult {
  outputPath: string;
  totalRows: number;
  preservedRows: number;       // rows from the template that were kept untouched
  insertedRows: number;        // rows added for the first time
  skippedExistingMatches: {    // business-fingerprint matches that preserved an existing row
    orderNo: string;
    tod: string;
    marketCode: string;
    fob: string;               // numeric or "" as read from the sheet
    newContract: string;       // what config said this row's contract was
    existingContract: string;  // what the existing row's column D says
    note: "contract_preserved_from_existing" | "exact_duplicate" | "manual_assignment_kept";
  }[];
  ambiguousMatches: {          // 2+ existing rows share the same business fingerprint
    orderNo: string;
    tod: string;
    marketCode: string;
    fob: string;
    occurrences: number;
    rows: number[];            // sheet row indexes
  }[];
}

interface StoredRow {
  // The "business" fingerprint used for row-level de-dup (spec 2026-10-26
  // follow-up). It identifies a logical line regardless of contract or
  // folder reassignment, so manual moves survive regen.
  businessFp: string;
  // The row's current contract (col D) and inferred folder letter (col A ref
  // suffix). These are PRESERVED from the existing sheet on a match and only
  // set from the generator config on first insertion.
  commercialContNo: string;
  folderLetter: string;
  orderNo: string;
  marketCode: string;
  tod: string;
  // Payload (full 21 columns)
  values: (string | number | null)[];
  // Manual columns captured from the sheet (preserved on regen)
  manual: { P: string; T: string; U: string };
  // Sort hints
  folderSequence: number;
  isFirstForPo: boolean;
  poSequence: number;          // insertion order within the folder
  // For the result's row-index reporting on ambiguous matches.
  originRow?: number;          // sheet row index when read from the template
}

export async function writeSummaryWorkbook(opts: SalesContractSummaryWriteOptions): Promise<SalesContractSummaryWriteResult> {
  await mkdir(dirname(opts.outputPath), { recursive: true });

  const folderSeq = new Map<string, number>();
  for (const f of opts.folderSequence) folderSeq.set(f.folderLetter.toUpperCase(), f.sequence);
  const seqOf = (f: string): number => {
    const upper = (f ?? "").toUpperCase();
    const s = folderSeq.get(upper);
    return typeof s === "number" ? s : Number.MAX_SAFE_INTEGER;
  };

  // 1 – Read the existing sheet if present.
  const existing: StoredRow[] = [];
  if (opts.templatePath) {
    try {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.readFile(opts.templatePath);
      const sheet = wb.getWorksheet(SHEET_NAME);
      if (sheet) {
        sheet.eachRow({ includeEmpty: false }, (row, rowIdx) => {
          if (rowIdx < DATA_START_ROW) return;
          const values: (string | number | null)[] = [];
          for (let c = 1; c <= SUMMARY_HEADERS.length; c++) values.push(readCell(row.getCell(c)));
          // Blank row? skip.
          if (values.every((v) => v === "" || v === null)) return;
          const commercialContNo = String(values[3] ?? "").trim();  // D
          const orderNo = String(values[5] ?? "").trim();           // F
          const country = String(values[14] ?? "").trim();          // O
          const marketCode = extractMarketCode(country);
          const tod = String(values[13] ?? "").trim();              // N
          const folderLetter = inferFolderFromRef(String(values[0] ?? ""));
          const businessFp = buildBusinessFp({
            orderNo,
            tod,
            marketCode,
            fob: values[8],                                         // I
            styleNo: String(values[7] ?? ""),                       // H
            country,                                                // O (full, for art bracket)
          });
          existing.push({
            businessFp,
            commercialContNo,
            folderLetter,
            orderNo,
            marketCode,
            tod,
            values,
            manual: {
              P: String(values[15] ?? ""),
              T: String(values[19] ?? ""),
              U: String(values[20] ?? ""),
            },
            folderSequence: seqOf(folderLetter),
            isFirstForPo: values[6] !== null && values[6] !== "", // G non-blank → first row for PO
            poSequence: Number.MAX_SAFE_INTEGER, // template rows sort stable by their own grouping
            originRow: rowIdx,
          });
        });
      }
    } catch {
      // Template unreadable → start fresh. We never bail on a bad template.
    }
  }

  // Index existing rows by business fingerprint – used to decide for each new
  // row whether it matches an existing one (preserve), has no match (insert),
  // or hits an ambiguous duplicate (flag; do nothing).
  const existingByFp = new Map<string, StoredRow[]>();
  for (const e of existing) {
    if (!e.businessFp) continue;
    const bucket = existingByFp.get(e.businessFp);
    if (bucket) bucket.push(e);
    else existingByFp.set(e.businessFp, [e]);
  }

  // 2 – Build the new rows from `pos` and merge against existing by business fp.
  const newRowsToInsert: StoredRow[] = [];
  const skippedExistingMatches: SalesContractSummaryWriteResult["skippedExistingMatches"] = [];
  const ambiguousMatches: SalesContractSummaryWriteResult["ambiguousMatches"] = [];
  const flaggedAmbiguousFps = new Set<string>();

  opts.pos.forEach(({ poId, po, config }, poIdx) => {
    const built = mapToSummaryRows(po, config, poId);
    if (built.length === 0) return;
    const commercialContNo = config.contractNo.trim();
    const folderLetter = config.folderLetter.trim().toUpperCase();

    built.forEach((r) => {
      const stored: StoredRow = {
        businessFp: buildBusinessFp({
          orderNo: r.orderNo,
          tod: r.tod,
          marketCode: r.marketCode,
          fob: r.fob,
          styleNo: r.styleNo,
          country: r.country,
        }),
        commercialContNo,
        folderLetter,
        orderNo: r.orderNo,
        marketCode: r.marketCode,
        tod: r.tod,
        values: summaryRowToCells(r),
        manual: { P: r.remarks, T: r.withoutDiscountOldFob, U: r.discountFobConDate },
        folderSequence: seqOf(folderLetter),
        isFirstForPo: r.isFirstForPo,
        poSequence: poIdx,
      };

      const matches = existingByFp.get(stored.businessFp) ?? [];

      if (matches.length === 0) {
        // No existing row for this business line → insert fresh.
        newRowsToInsert.push(stored);
        return;
      }

      if (matches.length >= 2) {
        // 2+ existing rows share this fingerprint → never guess which one is
        // "the" row (spec 2026-10-26-2 rule 7). Preserve them all; skip the
        // new row; raise one review entry for the fingerprint.
        if (!flaggedAmbiguousFps.has(stored.businessFp)) {
          flaggedAmbiguousFps.add(stored.businessFp);
          ambiguousMatches.push({
            orderNo: r.orderNo,
            tod: r.tod,
            marketCode: r.marketCode,
            fob: r.fob === null ? "" : String(r.fob),
            occurrences: matches.length,
            rows: matches.map((m) => m.originRow ?? 0).filter(Boolean),
          });
        }
        return;
      }

      // Exactly one existing match → PRESERVE it. The user may have manually
      // moved it to a different contract (spec 2026-10-26-2 rule 6); never
      // overwrite that. If manual P/T/U already live on the row they stay;
      // if the existing row has them BLANK we leave them blank (no auto-fill).
      const prior = matches[0];
      const existingContract = prior.commercialContNo;
      const note: "contract_preserved_from_existing" | "exact_duplicate" | "manual_assignment_kept" =
        !existingContract || existingContract === commercialContNo
          ? "exact_duplicate"
          : (prior.manual.P || prior.manual.T || prior.manual.U)
            ? "manual_assignment_kept"
            : "contract_preserved_from_existing";
      skippedExistingMatches.push({
        orderNo: r.orderNo,
        tod: r.tod,
        marketCode: r.marketCode,
        fob: r.fob === null ? "" : String(r.fob),
        newContract: commercialContNo,
        existingContract,
        note,
      });
    });
  });

  // All existing rows are preserved. The writer never deletes rows from the
  // template; it only decides whether to INSERT a generator row alongside them.
  const preserved: StoredRow[] = [...existing];

  // 3 – Combine, sort, and write.
  const combined: StoredRow[] = [...preserved, ...newRowsToInsert];
  combined.sort((a, b) => {
    const n = cmpNum(a.commercialContNo, b.commercialContNo);
    if (n !== 0) return n;
    if (a.folderSequence !== b.folderSequence) return a.folderSequence - b.folderSequence;
    if (a.folderLetter !== b.folderLetter) return a.folderLetter.localeCompare(b.folderLetter);
    if (a.poSequence !== b.poSequence) return a.poSequence - b.poSequence;
    if (a.orderNo !== b.orderNo) return a.orderNo.localeCompare(b.orderNo);
    // Within a PO: first-for-PO row first, then markets alphabetically.
    if (a.isFirstForPo !== b.isFirstForPo) return a.isFirstForPo ? -1 : 1;
    return a.marketCode.localeCompare(b.marketCode);
  });

  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet(SHEET_NAME);
  const headerRow = sheet.getRow(HEADER_ROW);
  SUMMARY_HEADERS.forEach((h, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = h;
    cell.font = { bold: true };
  });
  sheet.columns = SUMMARY_HEADERS.map((h) => ({ header: h, width: Math.max(10, Math.min(32, h.length + 4)) }));

  combined.forEach((row, idx) => {
    const r = sheet.getRow(DATA_START_ROW + idx);
    row.values.forEach((v, col) => {
      // col is 0-based; cells are 1-based.
      const cell = r.getCell(col + 1);
      if (v === null || v === undefined) return;
      cell.value = v;
    });
    r.commit();
  });

  await wb.xlsx.writeFile(opts.outputPath);
  return {
    outputPath: opts.outputPath,
    totalRows: combined.length,
    preservedRows: preserved.length,
    insertedRows: newRowsToInsert.length,
    skippedExistingMatches,
    ambiguousMatches,
  };
}

/**
 * Business fingerprint – identifies a logical line of the Summary irrespective
 * of contract/folder reassignment, so manual moves of rows survive regen.
 *
 * Fields used (lowercased + whitespace-normalised, blanks preserved as "" so
 * "FP collisions" happen on actually missing data rather than on random
 * normalisation differences):
 *   - orderNo (col F)
 *   - tod       (col N – delivery date)
 *   - marketCode (col O's leading token, strip paren group)
 *   - fob (col I – numeric, printed to 2 dp)
 *   - styleNo (col H)
 *   - article number (col O's `[art 051]` suffix if present – distinguishes
 *     multi-article POs that share a (market, TOD) pair)
 *
 * Returns "" when the row has neither an orderNo nor a market – such a row
 * never matches anything and the writer leaves it alone.
 */
export function buildBusinessFp(input: {
  orderNo: string;
  tod: string;
  marketCode: string;
  fob: string | number | null | undefined;
  styleNo: string;
  country?: string;
}): string {
  const order = normalize(input.orderNo);
  const market = normalize(input.marketCode).toUpperCase();
  if (!order || !market) return "";
  const tod = normalize(input.tod).toLowerCase();
  const fobNum = typeof input.fob === "number" ? input.fob : Number(input.fob ?? "");
  const fob = Number.isFinite(fobNum) ? fobNum.toFixed(2) : "";
  const style = normalize(input.styleNo).toLowerCase();
  const artMatch = (input.country ?? "").match(/\[art\s+([A-Za-z0-9]+)\]/i);
  const article = artMatch ? artMatch[1].toLowerCase() : "";
  return `${order}|${market}|${tod}|${fob}|${style}|${article}`;
}

function normalize(v: string | null | undefined): string {
  return String(v ?? "").replace(/\s+/g, " ").trim();
}

function summaryRowToCells(r: SalesContractSummaryRow): (string | number | null)[] {
  // 21 columns, in header order.
  // NOTE: 2026-10-27 rule change —
  //   Column B = merchandiser entry date per (contract × folder); re-used
  //              on every row from the same folder in the same contract.
  //              Carried in `folderCommercialDate` from summary.ts.
  //   Column E = Sales Contract date (one date per contract). Carried in
  //              `contractDate` from summary.ts.
  return [
    r.marchentContNo,                       // A
    r.folderCommercialDate,                 // B — per (contract × folder) merchandiser date
    r.buyerCode,                            // C
    r.commercialContNo,                     // D
    r.contractDate,                         // E — Sales Contract date (one per contract)
    r.orderNo,                              // F
    r.orderQty,                             // G
    r.styleNo,                              // H
    r.fob,                                  // I
    r.itemDes,                              // J
    r.cat,                                  // K
    r.hts,                                  // L
    r.contractValue,                        // M
    r.tod,                                  // N
    r.country,                              // O
    r.remarks,                              // P
    r.merchandiserName,                     // Q
    r.packSetQty,                           // R
    r.packSet,                              // S
    r.withoutDiscountOldFob,                // T
    r.discountFobConDate,                   // U
  ];
}

function readCell(c: ExcelJS.Cell): string | number | null {
  const v = c.value as unknown;
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return v;
  if (typeof v === "string") return v;
  if (typeof v === "object" && v !== null) {
    const obj = v as Record<string, unknown>;
    if ("result" in obj) {
      const r = obj.result;
      if (typeof r === "number" || typeof r === "string") return r;
    }
    if ("text" in obj) return String(obj.text ?? "");
  }
  return String(v);
}

/** Extract a folder letter from a Marchent Cont. No. of the form AGL/H&M/97-A/2026. */
function inferFolderFromRef(ref: string): string {
  const m = String(ref ?? "").match(/^AGL\/H&M\/\d+-([A-Z])\/\d{4}$/);
  return m ? m[1] : "";
}

/**
 * Extract the H&M market code from a COUNTRY cell string. Handles both the
 * new-format cell (`"OE (OLCEU)"` / `"OE (OLCEU) [art 051]"`) and the legacy
 * merged format the live tracker uses in historical rows
 * (`"29 Jun, 2026 OE (OLCEU) 3 544 87%"`). Returns "" when no market code is
 * detectable so the row does not match anything in the fingerprint index.
 */
export function extractMarketCode(country: string): string {
  const s = String(country ?? "").trim();
  if (!s) return "";
  const paren = s.match(/\b([A-Z]{2,3})\s*\(/);  // "<CODE> ("
  if (paren) return paren[1];
  const token = s.match(/^([A-Z]{2,3})\b/);       // bare "<CODE>"
  if (token) return token[1];
  const anywhere = s.match(/\b([A-Z]{2,3})\b/);   // last resort
  return anywhere ? anywhere[1] : "";
}

/** Compare two strings numerically when both are integers; fall back to lex. */
function cmpNum(a: string, b: string): number {
  const na = Number(a), nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return a.localeCompare(b);
}

