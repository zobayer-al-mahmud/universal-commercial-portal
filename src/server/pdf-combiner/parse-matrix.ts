/**
 * PDF Combiner — "INCENTIV SET COMBINER" master parsing (pure, side-effect-free).
 *
 * The real backend master (`INCENTIV SET COMBINER FORMET FINAL - exp sirial.xlsx`)
 * drives combining from its `CLABING HERE-F` worksheet. Each data row is ONE
 * export set; the documents to merge are given as explicit folder/file PAIRS in
 * document order:
 *
 *   | SL NO | EXP NO | INVOICE NO | PURPOSE | COUNTRY | COUNTRY CODE |
 *     COUNTRY FOR E-DOC | SL-01 | FL-01 | SL-02 | FL-02 | … | SL-18 | …
 *
 *   SL-0n = the FOLDER name under the configured share (e.g. "FCR").
 *   FL-0n = the FILE name inside that folder (e.g. "63577" → 63577.pdf, or a
 *           container id like "TLLU4872965").
 *
 * The sheet itself is the verified mapping — we never guess a folder or a file.
 * A slot is only used when BOTH its SL (folder) and FL (file) cells are filled.
 * Documents merge in ascending slot order (SL-01, SL-02, …).
 */

export interface MatrixSlot {
  /** Slot number (1-based, from the SL-0n/FL-0n column pair). */
  slot: number;
  /** Folder name (value of the SL-0n cell). */
  folder: string;
  /** File reference inside that folder (value of the FL-0n cell). */
  file: string;
}

export interface MatrixRow {
  /** 1-based worksheet row number (what the user sees in Excel). */
  rowNo: number;
  /** Serial number (SL NO column); empty when absent. */
  serialNo: string;
  /** EXP number (EXP NO column); empty when absent. */
  expNo: string;
  /** Invoice number (INVOICE NO column); empty when absent. */
  invoiceNo: string;
  /** Purpose (PURPOSE column), e.g. "E-DOC HM"; empty when absent. */
  purpose: string;
  /** Country-for-e-doc label; empty when absent. */
  country: string;
  /** Ordered document slots to merge (only filled folder+file pairs). */
  slots: MatrixSlot[];
  /** True when the row has an invoice/serial key AND at least one slot. */
  eligible: boolean;
  /** Why a row is not eligible (for display). */
  ineligibleReason?: string;
}

export interface MatrixParseResult {
  /** The worksheet the rows were read from. */
  sheetName: string;
  /** 1-based header row number. */
  headerRow: number;
  rows: MatrixRow[];
  /** Column-name → 1-based column index (for the editor / display). */
  columns: { name: string; index: number }[];
  warnings: string[];
}

/** The worksheet that holds the resolved folder/file pairs. */
export const MATRIX_SHEET = "CLABING HERE-F";

const norm = (s: unknown) => (s ?? "").toString().trim();
const up = (s: unknown) => norm(s).toUpperCase();

/**
 * Parse a 2-D grid of already-stringified cell texts (row-major, 1 row per
 * array entry) from the CLABING HERE-F sheet into eligible combine rows.
 */
export function parseMatrixGrid(grid: (string | null | undefined)[][], sheetName = MATRIX_SHEET): MatrixParseResult {
  const warnings: string[] = [];
  const clean = grid.map((r) => (r ?? []).map((c) => norm(c)));

  // Header = the first row that contains both an INVOICE NO column and an SL-0n column.
  let headerRow = -1;
  for (let i = 0; i < clean.length; i++) {
    const hasInvoice = clean[i].some((c) => up(c) === "INVOICE NO");
    const hasSlot = clean[i].some((c) => /^SL-\d+$/i.test(c));
    if (hasInvoice && hasSlot) { headerRow = i; break; }
  }
  if (headerRow < 0) {
    return { sheetName, headerRow: 0, rows: [], columns: [], warnings: [`Could not find the header row (needs "INVOICE NO" and "SL-0n" columns) on sheet "${sheetName}".`] };
  }

  const header = clean[headerRow];
  const columns = header.map((name, i) => ({ name, index: i + 1 })).filter((c) => c.name !== "");

  const findCol = (label: string) => header.findIndex((c) => up(c) === label);
  const colSerial = findCol("SL NO");
  const colExp = findCol("EXP NO");
  const colInvoice = findCol("INVOICE NO");
  const colPurpose = findCol("PURPOSE");
  const colCountry = findCol("COUNTRY FOR E-DOC");

  // Collect SL-0n / FL-0n column pairs, keyed by slot number.
  const slByNum = new Map<number, number>(); // slot → column index (0-based)
  const flByNum = new Map<number, number>();
  header.forEach((c, i) => {
    const sl = c.match(/^SL-(\d+)$/i);
    const fl = c.match(/^FL-(\d+)$/i);
    if (sl) slByNum.set(parseInt(sl[1], 10), i);
    else if (fl) flByNum.set(parseInt(fl[1], 10), i);
  });
  const slotNums = [...slByNum.keys()].sort((a, b) => a - b);
  if (slotNums.length === 0) warnings.push("No SL-0n document columns found.");

  const rows: MatrixRow[] = [];
  for (let r = headerRow + 1; r < clean.length; r++) {
    const cells = clean[r];
    if (!cells.some((c) => c !== "")) continue; // skip fully blank rows

    const serialNo = colSerial >= 0 ? (cells[colSerial] ?? "") : "";
    const expNo = colExp >= 0 ? (cells[colExp] ?? "") : "";
    const invoiceNo = colInvoice >= 0 ? (cells[colInvoice] ?? "") : "";
    const purpose = colPurpose >= 0 ? (cells[colPurpose] ?? "") : "";
    const country = colCountry >= 0 ? (cells[colCountry] ?? "") : "";

    const slots: MatrixSlot[] = [];
    const danglers: string[] = [];
    for (const n of slotNums) {
      const slCol = slByNum.get(n)!;
      const flCol = flByNum.get(n);
      const folder = cells[slCol] ?? "";
      const file = flCol !== undefined ? (cells[flCol] ?? "") : "";
      if (!folder && !file) continue;
      if (folder && file) slots.push({ slot: n, folder, file });
      else if (folder && flCol === undefined) danglers.push(`SL-${String(n).padStart(2, "0")} ("${folder}") has no FL-${String(n).padStart(2, "0")} file column`);
      else if (folder && !file) danglers.push(`SL-${String(n).padStart(2, "0")} ("${folder}") has no file name`);
      else if (!folder && file) danglers.push(`FL-${String(n).padStart(2, "0")} ("${file}") has no folder`);
    }

    // A row needs a key (invoice or serial) to be meaningful, and ≥1 slot.
    const hasKey = invoiceNo !== "" || serialNo !== "";
    let eligible = hasKey && slots.length > 0;
    let ineligibleReason: string | undefined;
    if (!eligible) {
      if (!hasKey && slots.length === 0) ineligibleReason = "No invoice/serial number and no document slots.";
      else if (!hasKey) ineligibleReason = "No invoice or serial number.";
      else ineligibleReason = danglers.length ? `No complete document slots (${danglers.join("; ")}).` : "No document slots.";
    } else if (danglers.length) {
      ineligibleReason = `Partial slots ignored: ${danglers.join("; ")}`;
    }

    rows.push({ rowNo: r + 1, serialNo, expNo, invoiceNo, purpose, country, slots, eligible, ineligibleReason });
  }

  return { sheetName, headerRow: headerRow + 1, rows, columns, warnings };
}

/** Make a safe, Windows-legal output file name (no extension forced here). */
export function matrixOutputName(row: MatrixRow): string {
  const base = (row.invoiceNo || row.serialNo || `Row_${row.rowNo}`)
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "_")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, 150);
  return `${base || `Row_${row.rowNo}`}.pdf`;
}
