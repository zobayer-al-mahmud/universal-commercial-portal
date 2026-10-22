import { createHash } from "crypto";
import { mkdir, readFile, writeFile } from "fs/promises";
import { join } from "path";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { audit } from "@/lib/audit";
import { readMaster } from "./read-master";
import { sanitizeOutputName, uniqueNames } from "./master";
import { buildIndex, resolveRef, type Resolution } from "./resolve";
import { indexFolders, resolveSelection } from "./folders";
import { mergePdfs } from "./merge";

/**
 * PDF Combiner run (the only PDF Combiner code that writes DB / disk).
 * master Excel → validate folder selection → index selected folders recursively
 * → resolve each row's files → merge in order → store one PDF per row.
 * Source folders are read-only. A row with any unresolved/unreadable file
 * produces no PDF (fail closed) and is reported.
 */

export interface RunInput {
  masterFileName: string;
  masterData: Buffer;
  folders: string[];
  actor: string;
}

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function describe(r: Resolution) {
  if (r.status === "found") return { ref: r.ref, status: r.status, folder: r.file.folder, relPath: r.file.relPath };
  if (r.status === "ambiguous")
    return { ref: r.ref, status: r.status, candidates: r.candidates.map((c) => `${c.folder}/${c.relPath}`) };
  return { ref: r.ref, status: r.status };
}

export async function runPdfCombine(input: RunInput): Promise<{ runId: string }> {
  const root = env.PDF_COMBINER_ROOT;
  if (!root) throw new Error("PDF_COMBINER_ROOT is not configured — set it in .env to the server source folder.");
  if (input.folders.length === 0) throw new Error("Select at least one folder.");
  if (input.folders.length > env.PDF_COMBINER_MAX_FOLDERS)
    throw new Error(`Select at most ${env.PDF_COMBINER_MAX_FOLDERS} folders.`);
  if (input.masterData.byteLength > env.PDF_COMBINER_MAX_MASTER_MB * 1024 * 1024)
    throw new Error(`Master file exceeds ${env.PDF_COMBINER_MAX_MASTER_MB} MB.`);

  const folders = await resolveSelection(root, input.folders);
  const master = await readMaster(input.masterFileName, input.masterData);
  if (master.rows.length === 0) throw new Error("The master file has no data rows.");
  if (master.rows.length > env.PDF_COMBINER_MAX_ROWS)
    throw new Error(`The master file has ${master.rows.length} rows; the limit is ${env.PDF_COMBINER_MAX_ROWS}.`);

  const files = await indexFolders(folders, { maxFiles: env.PDF_COMBINER_MAX_INDEXED_FILES });
  const index = buildIndex(files);

  const masterSha = sha256(input.masterData);
  const run = await prisma.pdfCombineRun.create({
    data: {
      masterFileName: input.masterFileName,
      masterSha256: masterSha,
      masterPath: "",
      foldersJson: JSON.stringify(folders.map((f) => f.name)),
      totalRows: master.rows.length,
      indexedFiles: files.length,
      warningsJson: JSON.stringify(master.warnings),
      actor: input.actor,
    },
  });
  const dir = join(env.STORAGE_ROOT, "pdf-combiner", run.id);
  await mkdir(join(dir, "output"), { recursive: true });
  const masterPath = join(dir, `master__${input.masterFileName.replace(/[^\w. -]+/g, "_")}`);
  await writeFile(masterPath, input.masterData);
  await prisma.pdfCombineRun.update({ where: { id: run.id }, data: { masterPath } });

  const names = uniqueNames(master.rows.map((r) => sanitizeOutputName(r.outputName, r.rowNo)));
  let completed = 0, failed = 0, skipped = 0;

  for (let i = 0; i < master.rows.length; i++) {
    const row = master.rows[i];
    const outputName = names[i];
    if (row.files.length === 0) {
      skipped++;
      await prisma.pdfCombineOutput.create({
        data: { runId: run.id, rowNo: row.rowNo, outputName, status: "SKIPPED", error: "No file names in this row." },
      });
      continue;
    }

    const resolutions = row.files.map((f) => resolveRef(index, f));
    const filesJson = JSON.stringify(resolutions.map(describe));
    const problems = resolutions.filter((r) => r.status !== "found");
    if (problems.length) {
      failed++;
      const error = problems
        .map((p) => (p.status === "missing" ? `Not found: ${p.ref}` : `Ambiguous (${(p as { candidates: unknown[] }).candidates.length} matches): ${p.ref}`))
        .join("; ");
      await prisma.pdfCombineOutput.create({ data: { runId: run.id, rowNo: row.rowNo, outputName, status: "FAILED", filesJson, error } });
      continue;
    }

    try {
      const inputs = await Promise.all(
        resolutions.map(async (r) => {
          const f = (r as Extract<Resolution, { status: "found" }>).file;
          return { label: `${f.folder}/${f.relPath}`, data: new Uint8Array(await readFile(f.absPath)) };
        }),
      );
      const merged = await mergePdfs(inputs);
      const outputPath = join(dir, "output", outputName);
      await writeFile(outputPath, merged.bytes);
      completed++;
      await prisma.pdfCombineOutput.create({
        data: {
          runId: run.id, rowNo: row.rowNo, outputName, status: "COMPLETED", filesJson,
          outputPath, pageCount: merged.pageCount, sha256: sha256(merged.bytes),
        },
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
    data: { status, completedRows: completed, failedRows: failed, skippedRows: skipped },
  });
  await audit({
    entityType: "document",
    entityId: run.id,
    action: "pdf-combiner.run",
    actor: input.actor,
    data: { master: input.masterFileName, masterSha, folders: input.folders, rows: master.rows.length, completed, failed, skipped },
  });
  return { runId: run.id };
}
