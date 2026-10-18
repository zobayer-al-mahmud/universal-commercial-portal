import { createHash } from "crypto";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { parseCsvRecords } from "./parse-csv";
import { buildRenamePlan, detectDocType } from "./rename";
import type { RenameDocType } from "./types";

const MODULE = "pdf-rename";

export interface RenameIntakeResult {
  jobId: string;
  docType: RenameDocType;
  duplicate: boolean;
  summary: { total: number; planned: number; collision: number; skipped: number; needsReview: number };
  status: string;
}

/**
 * Ingest an extraction CSV, build a deterministic rename plan, and persist it as
 * a job with per-file RenameItem rows. The plan is a PREVIEW: no files on disk are
 * renamed (originals are preserved). Collisions / missing keys route to review.
 */
export async function intakeRenameBatch(
  csvText: string,
  opts: { actor?: string; docType?: RenameDocType } = {},
): Promise<RenameIntakeResult> {
  const actor = opts.actor ?? "system";
  const records = parseCsvRecords(csvText);
  if (records.length === 0) throw new Error("No rows parsed from CSV.");

  const docType = opts.docType ?? detectDocType(records);
  if (!docType) throw new Error("Could not detect document type (expected FCR or Bill of Export headers).");

  const hash = createHash("sha256").update(csvText, "utf8").digest("hex");

  // Idempotency on CSV content hash.
  const existing = await prisma.sourceDocument.findUnique({ where: { sha256: hash } });
  if (existing?.jobId) {
    const job = await prisma.job.findUnique({ where: { id: existing.jobId } });
    return {
      jobId: existing.jobId,
      docType,
      duplicate: true,
      status: job?.status ?? "duplicate",
      summary: { total: 0, planned: 0, collision: 0, skipped: 0, needsReview: 0 },
    };
  }

  const plan = buildRenamePlan(records, { docType });
  const status = plan.summary.collision > 0 || plan.summary.needsReview > 0 ? "queued" : "draft";

  const job = await prisma.job.create({
    data: {
      module: MODULE,
      type: "rename-batch",
      businessKey: `${docType}:${plan.summary.total}`,
      status: "received",
      payloadJson: JSON.stringify({ docType, rows: plan.summary.total }),
      resultJson: JSON.stringify(plan.summary),
    },
  });

  await prisma.sourceDocument.create({
    data: {
      jobId: job.id,
      kind: "csv",
      originalName: `${docType}-extraction.csv`,
      sha256: hash,
      sizeBytes: Buffer.byteLength(csvText),
      mimeDetected: "text/csv",
      storagePath: `./var/storage/pdf-rename/${job.id}`,
      metadataJson: JSON.stringify({ docType }),
    },
  });

  await prisma.jobStageEvent.create({
    data: { jobId: job.id, stage: "classified", status: "ok", message: `Detected ${docType}; ${plan.summary.total} rows` },
  });

  // Persist rename items in batch.
  await prisma.renameItem.createMany({
    data: plan.items.map((it) => ({
      jobId: job.id,
      docType: it.docType,
      originalName: it.originalName,
      targetName: it.targetName,
      businessKey: it.businessKey,
      status: it.status,
      reason: it.reason,
      rowJson: JSON.stringify(it.row),
    })),
  });

  await prisma.jobStageEvent.create({
    data: {
      jobId: job.id,
      stage: "planned",
      status: status === "queued" ? "failed" : "ok",
      message: `planned=${plan.summary.planned} collision=${plan.summary.collision} skipped=${plan.summary.skipped} needsReview=${plan.summary.needsReview}`,
    },
  });

  // Review tickets for collisions / needs-review.
  if (plan.summary.collision > 0) {
    await prisma.reviewTicket.create({
      data: {
        jobId: job.id,
        module: MODULE,
        reasonCode: "RENAME_COLLISION",
        reason: `${plan.summary.collision} file(s) map to a duplicate target name (Q-PR-01: confirm canonical pattern/collision rule).`,
        contextJson: JSON.stringify({ severity: "hard" }),
      },
    });
  }
  if (plan.summary.needsReview > 0) {
    await prisma.reviewTicket.create({
      data: {
        jobId: job.id,
        module: MODULE,
        reasonCode: "RENAME_KEY_MISSING",
        reason: `${plan.summary.needsReview} file(s) have no usable invoice key.`,
        contextJson: JSON.stringify({ severity: "hard" }),
      },
    });
  }

  await prisma.job.update({ where: { id: job.id }, data: { status } });
  await audit({
    entityType: "job",
    entityId: job.id,
    action: "rename.planned",
    actor,
    data: { docType, summary: plan.summary, status },
  });

  return { jobId: job.id, docType, duplicate: false, summary: plan.summary, status };
}
