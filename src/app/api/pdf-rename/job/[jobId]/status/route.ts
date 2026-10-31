import { NextResponse } from "next/server";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Live status + per-item progress for one PDF-rename job (polled by the UI). */
export async function GET(_req: Request, { params }: { params: { jobId: string } }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  if (!userHasPermission(user, PERMISSIONS.JOB_READ)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const job = await prisma.renameJob.findUnique({ where: { id: params.jobId } });
  if (!job) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const items = await prisma.renameJobItem.findMany({
    where: { jobId: job.id },
    orderBy: { serial: "asc" },
    include: { events: { orderBy: { createdAt: "asc" }, take: 30 } },
  });

  // "stopping" stays running so the UI keeps polling until the job is parked.
  const running = job.status === "queued" || job.status === "processing" || job.status === "stopping";
  return NextResponse.json({
    jobId: job.id,
    folder: job.folder,
    status: job.status,
    running,
    stopping: job.status === "stopping",
    stopped: job.status === "stopped",
    currentActivity: job.currentActivity,
    minConfidence: job.minConfidence,
    ocrEnabled: job.ocrEnabled,
    startedAt: job.startedAt?.toISOString() ?? null,
    totals: {
      total: job.totalItems,
      processed: job.processedItems,
      renamed: job.renamedItems,
      review: job.reviewItems,
      failed: job.failedItems,
      remaining: Math.max(0, job.totalItems - job.processedItems),
    },
    items: items.map((it) => {
      let candidates: unknown[] = [];
      try { candidates = JSON.parse(it.candidatesJson) as unknown[]; } catch { candidates = []; }
      return {
        id: it.id,
        serial: it.serial,
        originalName: it.originalName,
        state: it.state,
        docType: it.docType,
        invoiceNumber: it.invoiceNumber,
        countryToken: it.countryToken,
        newName: it.newName,
        source: it.source,
        method: it.method,
        confidence: it.confidence,
        pages: it.pages,
        reviewReason: it.reviewReason,
        reasonText: it.reasonText,
        candidates,
        correctedBy: it.correctedBy,
        hasOutput: Boolean(it.outputPath),
        events: it.events.map((e) => ({ stage: e.stage, status: e.status, message: e.message, at: e.createdAt.toISOString() })),
      };
    }),
  });
}
