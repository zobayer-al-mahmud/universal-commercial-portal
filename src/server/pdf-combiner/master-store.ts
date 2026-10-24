import { createHash } from "crypto";
import { access, copyFile, mkdir, readFile, writeFile } from "fs/promises";
import { join } from "path";
import ExcelJS from "exceljs";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { audit } from "@/lib/audit";
import { MATRIX_SHEET, parseMatrixGrid, type MatrixParseResult } from "./parse-matrix";

/**
 * UCP-managed "active" master Excel store for the INCENTIV SET COMBINER
 * workflow. The backend file (env.PDF_COMBINER_MASTER_PATH) seeds UCP's own
 * active copy once; after that UCP is the source of truth and the backend file
 * is never written. Edits / re-imports replace the active copy, bump the
 * version and are audited. The bytes live under STORAGE_ROOT.
 */

const MASTER_ID = "active";
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function activeDir(): string { return join(env.STORAGE_ROOT, "pdf-combiner"); }
export function activeMasterPath(): string { return join(activeDir(), "active-master.xlsx"); }

async function exists(p: string): Promise<boolean> { try { await access(p); return true; } catch { return false; } }

export interface ActiveMaster {
  fileName: string;
  path: string;
  sha256: string;
  version: number;
  sheetName: string;
  eligible: number;
  updatedBy: string;
  updatedAt: Date;
}

/** Stringify an exceljs cell value (rich text, hyperlink, formula result, …). */
export function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return String(v).trim();
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    if ("richText" in v && Array.isArray(v.richText)) return v.richText.map((t) => t.text).join("").trim();
    if ("text" in v && (v as { text?: unknown }).text !== undefined) return cellText((v as { text: ExcelJS.CellValue }).text);
    if ("result" in v) return cellText((v as { result: ExcelJS.CellValue }).result);
    if ("hyperlink" in v) return String((v as { text?: string }).text ?? "").trim();
  }
  return String(v).trim();
}

/** Read the CLABING HERE-F worksheet of a master workbook into a string grid. */
export async function extractMatrixGrid(data: Buffer): Promise<string[][]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(data as unknown as ArrayBuffer);
  const ws = wb.getWorksheet(MATRIX_SHEET) ?? wb.worksheets[0];
  if (!ws) throw new Error(`Master workbook has no "${MATRIX_SHEET}" worksheet.`);
  const grid: string[][] = [];
  ws.eachRow({ includeEmpty: true }, (row, rowNo) => {
    const values: string[] = [];
    const n = Math.max(row.cellCount, row.actualCellCount);
    for (let c = 1; c <= n; c++) values.push(cellText(row.getCell(c).value));
    grid[rowNo - 1] = values;
  });
  for (let i = 0; i < grid.length; i++) grid[i] ??= [];
  return grid;
}

/** Validate that a buffer is a usable INCENTIV SET COMBINER master. */
export async function validateMaster(data: Buffer): Promise<{ ok: true; result: MatrixParseResult } | { ok: false; error: string }> {
  try {
    const grid = await extractMatrixGrid(data);
    const result = parseMatrixGrid(grid);
    if (result.headerRow === 0) {
      return { ok: false, error: `The "${MATRIX_SHEET}" sheet was not found or has no recognisable header (needs an "INVOICE NO" column and "SL-01"/"FL-01" document columns).` };
    }
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unreadable Excel file." };
  }
}

/** Current active master record (null if never seeded). */
export async function getActiveMaster(): Promise<ActiveMaster | null> {
  const row = await prisma.pdfCombineMaster.findUnique({ where: { id: MASTER_ID } });
  if (!row) return null;
  return { fileName: row.fileName, path: row.path, sha256: row.sha256, version: row.version, sheetName: row.sheetName, eligible: row.eligible, updatedBy: row.updatedBy, updatedAt: row.updatedAt };
}

/**
 * Ensure the active master exists, seeding it from the backend file on first
 * use. Returns the active record. Throws a clear error when neither the active
 * copy nor the backend seed file is available.
 */
export async function ensureActiveMaster(actor = "system"): Promise<ActiveMaster> {
  const current = await getActiveMaster();
  if (current && (await exists(current.path))) return current;

  // Seed from the configured backend file.
  const seed = env.PDF_COMBINER_MASTER_PATH;
  if (!seed || !(await exists(seed))) {
    throw new Error(`No active master and the backend seed file is not available (PDF_COMBINER_MASTER_PATH="${seed}"). Configure it or re-import a master.`);
  }
  const data = await readFile(seed);
  const v = await validateMaster(data);
  if (!v.ok) throw new Error(`Backend seed master is invalid: ${v.error}`);

  await mkdir(activeDir(), { recursive: true });
  await copyFile(seed, activeMasterPath());
  const fileName = seed.replace(/\\/g, "/").split("/").pop() || "master.xlsx";
  const eligible = v.result.rows.filter((r) => r.eligible).length;
  const rec = await prisma.pdfCombineMaster.upsert({
    where: { id: MASTER_ID },
    update: { fileName, path: activeMasterPath(), sha256: sha256(data), version: { increment: current ? 1 : 0 }, sheetName: v.result.sheetName, eligible, updatedBy: actor },
    create: { id: MASTER_ID, fileName, path: activeMasterPath(), sha256: sha256(data), version: 1, sheetName: v.result.sheetName, eligible, updatedBy: actor },
  });
  await audit({ entityType: "document", entityId: MASTER_ID, action: "pdf-combiner.master.seeded", actor, data: { fileName, eligible } });
  return { fileName: rec.fileName, path: rec.path, sha256: rec.sha256, version: rec.version, sheetName: rec.sheetName, eligible: rec.eligible, updatedBy: rec.updatedBy, updatedAt: rec.updatedAt };
}

/** Read the active master bytes (seeding first if needed). */
export async function readActiveMasterBytes(actor = "system"): Promise<Buffer> {
  const rec = await ensureActiveMaster(actor);
  return readFile(rec.path);
}

/** Parse the active master into combine rows (seeding first if needed). */
export async function parseActiveMaster(actor = "system"): Promise<{ master: ActiveMaster; result: MatrixParseResult }> {
  const master = await ensureActiveMaster(actor);
  const data = await readFile(master.path);
  const result = parseMatrixGrid(await extractMatrixGrid(data));
  return { master, result };
}

/**
 * Replace the active master with new bytes (from a re-import or a save of an
 * edited workbook). Validates first; bumps the version and audits.
 */
export async function saveActiveMaster(data: Buffer, opts: { fileName: string; actor: string; action?: string; note?: string }): Promise<{ master: ActiveMaster; eligible: number }> {
  const v = await validateMaster(data);
  if (!v.ok) throw new Error(v.error);
  await mkdir(activeDir(), { recursive: true });
  await writeFile(activeMasterPath(), data);
  const eligible = v.result.rows.filter((r) => r.eligible).length;
  const prev = await getActiveMaster();
  const rec = await prisma.pdfCombineMaster.upsert({
    where: { id: MASTER_ID },
    update: { fileName: opts.fileName, path: activeMasterPath(), sha256: sha256(data), version: (prev?.version ?? 0) + 1, sheetName: v.result.sheetName, eligible, updatedBy: opts.actor },
    create: { id: MASTER_ID, fileName: opts.fileName, path: activeMasterPath(), sha256: sha256(data), version: 1, sheetName: v.result.sheetName, eligible, updatedBy: opts.actor },
  });
  await audit({ entityType: "document", entityId: MASTER_ID, action: opts.action ?? "pdf-combiner.master.replaced", actor: opts.actor, data: { fileName: opts.fileName, version: rec.version, eligible, note: opts.note ?? "" } });
  return { master: { fileName: rec.fileName, path: rec.path, sha256: rec.sha256, version: rec.version, sheetName: rec.sheetName, eligible: rec.eligible, updatedBy: rec.updatedBy, updatedAt: rec.updatedAt }, eligible };
}
