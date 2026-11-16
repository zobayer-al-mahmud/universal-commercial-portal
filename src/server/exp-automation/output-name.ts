/**
 * EXP PDF output naming — the single source of truth for what a captured EXP PDF
 * is called, used by both the per-row download route and the batch ZIP so a file
 * has the SAME name everywhere.
 *
 * The user's rule: name by the record's own EXP fields. Priority:
 *   1. Save_As  — the operator's explicit filename (the Download sheet's column);
 *      present only for Download rows, so this preserves the existing Download
 *      naming untouched.
 *   2. EXP No   — the canonical 18/20-digit identifier (Correction/Duplicate rows
 *      that carry it). → e.g. "26120000123456.pdf".
 *   3. ADSCode_Serial_Year — when there is no EXP No (the usual Correction case).
 *      → e.g. "012345_4408_2026.pdf".
 *   4. Invoice No, then a row-number fallback, so a file is never nameless.
 *
 * Names are sanitised to a safe, flat basename (no path separators, no directory
 * prefix, no double ".pdf"); nothing here creates ".pdf/" folders or nesting.
 * Pure — no I/O, no portal, no DB — so it is unit-testable and shared freely.
 */

export interface ExpNameFields {
  rowNo?: number;
  expNo?: string | null;
  adscode?: string | null;
  expSerial?: string | null;
  expYear?: string | null;
  invoiceNo?: string | null;
  saveAs?: string | null;
}

/** Collapse a value to a safe, flat filename token (never a path, never ".pdf"). */
function sanitizeToken(v: string | null | undefined): string {
  return (v ?? "")
    .trim()
    .replace(/\.pdf$/i, "") // drop a trailing extension if the source carried one
    .replace(/[\\/]+/g, "_") // never allow path separators
    .replace(/[^\w.-]+/g, "_") // keep word chars, dot, dash; everything else → _
    .replace(/_{2,}/g, "_")
    .replace(/^[_.]+|[_.]+$/g, "") // no leading/trailing _ or .
    .slice(0, 120);
}

/**
 * The basename (no extension) for a row's PDF, by the priority above. Always
 * returns a non-empty token.
 */
export function expPdfBase(row: ExpNameFields): string {
  const saveAs = sanitizeToken(row.saveAs);
  if (saveAs) return saveAs;

  const expNo = sanitizeToken(row.expNo);
  if (expNo) return expNo;

  const ad = sanitizeToken(row.adscode);
  const serial = sanitizeToken(row.expSerial);
  const year = sanitizeToken(row.expYear);
  if (ad && serial && year) return `${ad}_${serial}_${year}`;

  const inv = sanitizeToken(row.invoiceNo);
  if (inv) return inv;

  // Last resort: the best single identifier we have, else the row number.
  return expNo || serial || ad || (row.rowNo ? `row-${row.rowNo}` : "exp");
}

/** The full `<base>.pdf` filename for a single row. */
export function expPdfFilename(row: ExpNameFields): string {
  return `${expPdfBase(row)}.pdf`;
}

/**
 * De-duplicating namer for a batch: returns a unique `<base>.pdf`, suffixing
 * `-2`, `-3`, … when the base is already taken (case-insensitively), and records
 * the chosen name in `used` so later rows cannot overwrite it. This is what keeps
 * two rows that resolve to the same identifier from clobbering each other in a ZIP.
 */
export function uniqueExpPdfName(row: ExpNameFields, used: Set<string>): string {
  const base = expPdfBase(row);
  let name = `${base}.pdf`;
  let n = 2;
  while (used.has(name.toLowerCase())) name = `${base}-${n++}.pdf`;
  used.add(name.toLowerCase());
  return name;
}
