import { promises as fs } from "fs";
import path from "path";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";

export type ApplyActionKind =
  | "copy"
  | "missing-source"
  | "target-exists"
  | "no-target"
  | "skipped-not-planned"
  | "already-applied";

export interface ApplyItem {
  id: string;
  originalName: string;
  targetName: string | null;
  status: string;
  applied: boolean;
}

export interface ApplyAction {
  id: string;
  originalName: string;
  targetName: string | null;
  action: ApplyActionKind;
  reason: string;
}

/**
 * Decide the apply action for each rename item. Pure: existence is injected.
 * Only `planned`, not-yet-applied items with a free target are copied; collisions
 * (on disk or within this run) and missing sources are refused, never overwritten.
 */
export function resolveApplyActions(
  items: ApplyItem[],
  preds: { sourceExists: (name: string) => boolean; targetExists: (name: string) => boolean },
): ApplyAction[] {
  const claimed = new Set<string>();
  return items.map((it) => {
    const base = { id: it.id, originalName: it.originalName, targetName: it.targetName };
    if (it.applied) return { ...base, action: "already-applied" as const, reason: "Already copied" };
    if (it.status !== "planned") return { ...base, action: "skipped-not-planned" as const, reason: `Status is '${it.status}'` };
    if (!it.targetName) return { ...base, action: "no-target" as const, reason: "No target filename" };
    if (!preds.sourceExists(it.originalName)) return { ...base, action: "missing-source" as const, reason: "Source file not found in input dir" };
    if (preds.targetExists(it.targetName) || claimed.has(it.targetName))
      return { ...base, action: "target-exists" as const, reason: `Target '${it.targetName}' already exists (never overwritten)` };
    claimed.add(it.targetName);
    return { ...base, action: "copy" as const, reason: "" };
  });
}

export interface ApplyResult {
  dryRun: boolean;
  inputDir: string;
  outputDir: string;
  summary: Record<ApplyActionKind, number>;
  copied: { originalName: string; targetName: string }[];
}

/**
 * Apply a rename plan by COPYING source scans to renamed files in an output dir.
 * Originals are never modified; the source tree is read-only. Gated: callers must
 * hold the rename.apply permission, and dryRun=true makes no filesystem changes.
 */
export async function applyRenameBatch(
  jobId: string,
  opts: { actor?: string; dryRun?: boolean; inputDir?: string } = {},
): Promise<ApplyResult> {
  const actor = opts.actor ?? "system";
  const dryRun = opts.dryRun ?? true;
  const inputDir = opts.inputDir || env.RENAME_INPUT_DIR || "";
  if (!inputDir) throw new Error("RENAME_INPUT_DIR is not configured; cannot locate source PDFs.");

  const outputDir = path.join(env.STORAGE_ROOT, "pdf-rename", jobId, "renamed");

  const rows = await prisma.renameItem.findMany({ where: { jobId } });
  if (rows.length === 0) throw new Error("No rename items for this job.");

  const items: ApplyItem[] = rows.map((r) => ({ id: r.id, originalName: r.originalName, targetName: r.targetName, status: r.status, applied: r.applied }));

  const exists = async (p: string) => {
    try { await fs.access(p); return true; } catch { return false; }
  };

  // Resolve actions with async existence checks captured up front.
  const srcExistsMap = new Map<string, boolean>();
  for (const it of items) if (!srcExistsMap.has(it.originalName)) srcExistsMap.set(it.originalName, await exists(path.join(inputDir, it.originalName)));
  const tgtExistsMap = new Map<string, boolean>();
  for (const it of items) if (it.targetName && !tgtExistsMap.has(it.targetName)) tgtExistsMap.set(it.targetName, await exists(path.join(outputDir, it.targetName)));

  const actions = resolveApplyActions(items, {
    sourceExists: (n) => srcExistsMap.get(n) ?? false,
    targetExists: (n) => tgtExistsMap.get(n) ?? false,
  });

  const summary: Record<ApplyActionKind, number> = {
    copy: 0, "missing-source": 0, "target-exists": 0, "no-target": 0, "skipped-not-planned": 0, "already-applied": 0,
  };
  const copied: { originalName: string; targetName: string }[] = [];

  if (!dryRun) await fs.mkdir(outputDir, { recursive: true });

  for (const a of actions) {
    summary[a.action]++;
    if (a.action === "copy" && a.targetName) {
      if (!dryRun) {
        await fs.copyFile(path.join(inputDir, a.originalName), path.join(outputDir, a.targetName));
        await prisma.renameItem.update({ where: { id: a.id }, data: { applied: true, appliedPath: path.join(outputDir, a.targetName) } });
      }
      copied.push({ originalName: a.originalName, targetName: a.targetName });
    }
  }

  await prisma.jobStageEvent.create({
    data: { jobId, stage: dryRun ? "apply-dryrun" : "apply", status: "ok", message: `${dryRun ? "Dry-run: would copy" : "Copied"} ${summary.copy} file(s) to ${outputDir}`, actor },
  });
  await audit({ entityType: "job", entityId: jobId, action: dryRun ? "rename.apply.dryrun" : "rename.apply", actor, data: { summary, outputDir } });

  return { dryRun, inputDir, outputDir, summary, copied };
}
