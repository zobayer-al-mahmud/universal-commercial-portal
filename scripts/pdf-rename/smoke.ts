/**
 * End-to-end smoke test for the PDF File Rename folder workflow against the REAL
 * files in PDF_RENAME_ROOT. Verifies invoice extraction (text + OCR) reproduces
 * the known filenames, and that apply copies into the output sub-folder without
 * overwriting or touching originals.
 *
 * Run (PowerShell/bash), from the repo root:
 *   node node_modules/tsx/dist/cli.mjs scripts/pdf-rename/smoke.ts [scanSampleCount]
 */
import { readdirSync, statSync, rmSync, existsSync } from "fs";
import path from "path";
import { env } from "@/lib/env";
import { scanFolder, applyPlan, listRenameFolders } from "@/server/pdf-rename/folder-rename";
import { shutdownOcr } from "@/server/pdf-rename/ocr";

const root = env.PDF_RENAME_ROOT;
const OUT = env.PDF_RENAME_OUTPUT_SUBDIR;

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error("✗ " + msg);
    process.exitCode = 1;
  } else {
    console.log("✓ " + msg);
  }
}

async function scanAll(folder: string, files?: string[]) {
  const r = await scanFolder(root, folder, { outputSubdir: OUT, maxFiles: env.PDF_RENAME_MAX_FILES, files });
  const correct = r.items.filter((i) => i.status === "planned" && i.newName === `${path.basename(i.originalName, ".pdf")}.pdf`).length;
  return { r, correct };
}

async function main() {
  const sample = Number(process.argv[2] ?? 8);
  console.log("ROOT:", root, "| OCR_ENABLED:", env.OCR_ENABLED, "\n");

  const folders = await listRenameFolders(root, OUT);
  console.log("Folders:", folders.map((f) => `${f.name} (${f.fileCount})`).join(" | "), "\n");

  // Identify the folders by role from their names.
  const fcr = folders.find((f) => /FCR/i.test(f.name))?.name;
  const soft = folders.find((f) => /SOFT/i.test(f.name))?.name;
  const scan = folders.find((f) => /SCAN/i.test(f.name))?.name;

  // 1. FCR — all digital, invoice from 'INV NO :'.
  if (fcr) {
    const { r, correct } = await scanAll(fcr);
    console.log(`FCR: ${correct}/${r.summary.total} extracted matching filename (planned=${r.summary.planned}, review=${r.summary.needsReview}, dup=${r.summary.collision})`);
    assert(correct === r.summary.total && r.summary.total > 0, "FCR: every file's extracted invoice equals its current filename");
  }

  // 2. Shipping Bill soft copy — digital, box-44.
  if (soft) {
    const { r, correct } = await scanAll(soft);
    console.log(`SOFT COPY: ${correct}/${r.summary.total} extracted matching filename (planned=${r.summary.planned}, review=${r.summary.needsReview}, dup=${r.summary.collision})`);
    assert(correct === r.summary.total && r.summary.total > 0, "SOFT COPY: every file's extracted invoice equals its current filename");
  }

  // 3. Scanned copies — OCR path, sample only (OCR is slow).
  let scanSampleFiles: string[] = [];
  if (scan) {
    scanSampleFiles = readdirSync(path.join(root, scan)).filter((f) => f.toLowerCase().endsWith(".pdf")).slice(0, sample);
    const { r, correct } = await scanAll(scan, scanSampleFiles);
    console.log(`SCAN (OCR, ${scanSampleFiles.length} sampled): ${correct}/${r.summary.total} extracted matching filename (planned=${r.summary.planned}, review=${r.summary.needsReview})`);
    assert(correct === r.summary.total && r.summary.total > 0, "SCAN: OCR-extracted invoice equals filename on every sampled file");
  }

  // 4. Apply on a small FCR subset → verify copy, no-overwrite, originals intact.
  if (fcr) {
    const outDir = path.join(root, fcr, OUT);
    if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true }); // clean slate for the test
    const subset = readdirSync(path.join(root, fcr)).filter((f) => f.toLowerCase().endsWith(".pdf")).slice(0, 3);
    const sizesBefore = subset.map((f) => statSync(path.join(root, fcr, f)).size);
    const { r } = await scanAll(fcr, subset);
    const apply1 = await applyPlan(root, fcr, OUT, r.items);
    assert(apply1.summary.renamed === subset.length, `APPLY: copied ${subset.length} file(s) into ${OUT}/`);
    // Re-apply must NOT overwrite.
    const apply2 = await applyPlan(root, fcr, OUT, r.items);
    assert(apply2.summary.renamed === 0 && apply2.summary["target-exists"] === subset.length, "APPLY: re-run never overwrites existing targets");
    // Originals unchanged.
    const sizesAfter = subset.map((f) => statSync(path.join(root, fcr, f)).size);
    assert(JSON.stringify(sizesBefore) === JSON.stringify(sizesAfter), "APPLY: original files are untouched (same size)");
    // Clean up the test output so the folder is left as found.
    rmSync(outDir, { recursive: true, force: true });
    console.log(`(cleaned up ${fcr}/${OUT})`);
  }

  await shutdownOcr();
  console.log(process.exitCode ? "\nSMOKE FAILED" : "\nSMOKE PASSED");
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
