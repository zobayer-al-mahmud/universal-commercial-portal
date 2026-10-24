import { createHash } from "crypto";
import { mkdir, readFile, writeFile } from "fs/promises";
import { join } from "path";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { audit } from "@/lib/audit";
import { resolveFolderFileOnDisk, preflightRoot, type DiskResolution } from "./folders";
import { mergePdfs } from "./merge";
import { matrixOutputName, type MatrixRow } from "./parse-matrix";
import { parseActiveMaster } from "./master-store";
import { uniqueNames } from "./master";

/**
 * PDF Combiner matrix run — the only matrix-combiner code that writes DB/disk.
 *
 * active master (CLABING HERE-F) → eligible rows → for each row resolve its
 * SL/FL folder+file slots DIRECTLY against the configured share (fresh every
 * run) → merge in slot order → one PDF per row. Source folders are read-only.
 * A row with any unresolved/unreadable slot produces no PDF (fail closed) and
 * is reported. Resolution is targeted (exact folder+file), so huge folders like
 * Container are never listed in full.
 */

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

export interface MatrixRunInput {
  actor: string;
  /** Specific worksheet row numbers to process; empty/undefined = all eligible. */
  rowNos?: number[];
}

export interface MatrixRunResult {
  runId: string;
  totalRows: number;
  completed: number;
  failed: number;
  skipped: number;
}

type SlotRes = DiskResolution & { slot: number; folder: string; file: string };

function describe(r: SlotRes) {
  return r.status === "found"
    ? { slot: r.slot, folder: r.folder, file: r.file, status: "found", path: `${r.folder}/${r.relPath}` }
    : { slot: r.slot, folder: r.folder, file: r.file, status: r.status };
}

function problemText(r: SlotRes): string {
  switch (r.status) {
    case "missing-folder": return `Folder not found: ${r.folder}`;
    case "missing-file": return `Not found: ${r.folder}/${r.file}`;
    case "invalid": return `Invalid reference: ${r.folder}/${r.file}`;
    default: return `${r.folder}/${r.file}`;
  }
}

export async function runMatrixCombine(input: MatrixRunInput): Promise<MatrixRunResult> {
  const root = env.PDF_COMBINER_ROOT;
  if (!root) throw new Error("PDF_COMBINER_ROOT is not configured — set it in .env to the Combiner Folders share.");

  // Fail fast (and clearly) if the share is unreachable, rather than resolving
  // every row to "missing" and mislabelling a network outage as missing files.
  await preflightRoot(root);

  const { master, result } = await parseActiveMaster(input.actor);

  // Select rows: requested subset (if any) else every eligible row.
  const wanted = new Set((input.rowNos ?? []).map(Number));
  const selected: MatrixRow[] = result.rows.filter((r) => (wanted.size ? wanted.has(r.rowNo) : r.eligible));
  if (selected.length === 0) {
    throw new Error(wanted.size ? "None of the requested rows were found." : "The active master has no eligible rows to combine.");
  }
  if (selected.length > env.PDF_COMBINER_MAX_ROWS) {
    throw new Error(`Selected ${selected.length} rows; the limit is ${env.PDF_COMBINER_MAX_ROWS}.`);
  }

  const foldersUsed = [...new Set(selected.flatMap((r) => r.slots.map((s) => s.folder)))].sort();
  const run = await prisma.pdfCombineRun.create({
    data: {
      masterFileName: `${master.fileName} (v${master.version})`,
      masterSha256: master.sha256,
      masterPath: master.path,
      foldersJson: JSON.stringify(foldersUsed),
      totalRows: selected.length,
      indexedFiles: 0,
      warningsJson: JSON.stringify(result.warnings),
      actor: input.actor,
    },
  });
  const dir = join(env.STORAGE_ROOT, "pdf-combiner", run.id);
  await mkdir(join(dir, "output"), { recursive: true });

  const names = uniqueNames(selected.map((r) => matrixOutputName(r)));
  let completed = 0, failed = 0, skipped = 0, resolvedFiles = 0;

  for (let i = 0; i < selected.length; i++) {
    const row = selected[i];
    const outputName = names[i];

    if (row.slots.length === 0) {
      skipped++;
      await prisma.pdfCombineOutput.create({
        data: { runId: run.id, rowNo: row.rowNo, outputName, status: "SKIPPED", error: row.ineligibleReason || "No document slots in this row." },
      });
      continue;
    }

    const resolutions: SlotRes[] = row.slots.map((s) => ({ slot: s.slot, folder: s.folder, file: s.file, ...resolveFolderFileOnDisk(root, s.folder, s.file) }));
    resolvedFiles += resolutions.filter((r) => r.status === "found").length;
    const filesJson = JSON.stringify(resolutions.map(describe));
    const problems = resolutions.filter((r) => r.status !== "found");
    if (problems.length) {
      failed++;
      await prisma.pdfCombineOutput.create({ data: { runId: run.id, rowNo: row.rowNo, outputName, status: "FAILED", filesJson, error: problems.map(problemText).join("; ") } });
      continue;
    }

    try {
      const inputs = await Promise.all(
        resolutions.map(async (r) => {
          const found = r as Extract<SlotRes, { status: "found" }>;
          return { label: `${r.folder}/${found.relPath}`, data: new Uint8Array(await readFile(found.absPath)) };
        }),
      );
      const merged = await mergePdfs(inputs);
      const outputPath = join(dir, "output", outputName);
      await writeFile(outputPath, merged.bytes);
      completed++;
      await prisma.pdfCombineOutput.create({
        data: { runId: run.id, rowNo: row.rowNo, outputName, status: "COMPLETED", filesJson, outputPath, pageCount: merged.pageCount, sha256: sha256(merged.bytes) },
      });
    } catch (e) {
      failed++;
      await prisma.pdfCombineOutput.create({
        data: { runId: run.id, rowNo: row.rowNo, outputName, status: "FAILED", filesJson, error: e instanceof Error ? e.message : String(e) },
      });
    }
  }

  const status = completed === 0 ? "failed" : failed > 0 ? "partial" : "completed";
  await prisma.pdfCombineRun.update({
    where: { id: run.id },
    data: { status, completedRows: completed, failedRows: failed, skippedRows: skipped, indexedFiles: resolvedFiles },
  });
  await audit({
    entityType: "document",
    entityId: run.id,
    action: "pdf-combiner.matrix-run",
    actor: input.actor,
    data: { master: master.fileName, version: master.version, rows: selected.length, mode: wanted.size ? "rows" : "all", completed, failed, skipped, folders: foldersUsed },
  });

  return { runId: run.id, totalRows: selected.length, completed, failed, skipped };
}
