import { NextResponse } from "next/server";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { prisma } from "@/lib/db";

/** Live status + per-row state + recent events for one EXP job (polled by the UI). */
export async function GET(_req: Request, { params }: { params: { jobId: string } }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  if (!userHasPermission(user, PERMISSIONS.EXP_RUN)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const job = await prisma.expJob.findUnique({ where: { id: params.jobId } });
  if (!job) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const rows = await prisma.expJobRow.findMany({
    where: { jobId: job.id },
    orderBy: { rowNo: "asc" },
    include: { events: { orderBy: { createdAt: "desc" }, take: 3 } },
  });

  // Flat, newest-first event feed across the job's rows for the live log panel.
  const recentEvents = await prisma.expJobRowEvent.findMany({
    where: { row: { jobId: job.id } },
    orderBy: { createdAt: "desc" },
    take: 80,
    include: { row: { select: { rowNo: true } } },
  });

  const remaining = job.total - job.processed;
  return NextResponse.json({
    id: job.id,
    kind: job.kind,
    sheetName: job.sheetName,
    sourceName: job.sourceName,
    status: job.status,
    hasFile: Boolean(job.storedPath),
    fileBytes: job.fileBytes,
    counts: {
      total: job.total,
      processed: job.processed,
      matched: job.matched,
      changed: job.changed,
      partial: job.partial,
      downloaded: job.downloaded,
      skipped: job.skipped,
      failed: job.failed,
      remaining: remaining < 0 ? 0 : remaining,
    },
    // "stopping" still counts as running so the UI keeps polling until the loop
    // finishes parking the job (then status flips to "stopped").
    running: job.status === "running" || job.status === "stopping",
    stopping: job.status === "stopping",
    stopped: job.status === "stopped",
    events: recentEvents.map((e) => ({ rowNo: e.row.rowNo, step: e.step, status: e.status, message: e.message, at: e.createdAt.toISOString() })),
    rows: rows.map((r) => {
      let mismatched: { portalLabel: string; excel: string; portal: string }[] = [];
      let notes: string[] = [];
      let values: Record<string, string> = {};
      try { mismatched = JSON.parse(r.mismatchedFields) as typeof mismatched; } catch { /* ignore */ }
      try {
        const dj = JSON.parse(r.dataJson) as { notes?: string[]; values?: Record<string, string> };
        notes = dj.notes ?? [];
        values = dj.values ?? {};
      } catch { /* ignore */ }
      return {
        id: r.id,
        rowNo: r.rowNo,
        adscode: r.adscode,
        expSerial: r.expSerial,
        expYear: r.expYear,
        expNo: r.expNo,
        invoiceNo: r.invoiceNo,
        saveAs: r.saveAs,
        status: r.status,
        step: r.step,
        error: r.error,
        retryCount: r.retryCount,
        hasPdf: Boolean(r.pdfPath),
        pdfPages: r.pdfPages,
        mismatched,
        notes,
        values,
        lastEvent: r.events[0] ? { step: r.events[0].step, status: r.events[0].status, message: r.events[0].message, at: r.events[0].createdAt.toISOString() } : null,
      };
    }),
  });
}
