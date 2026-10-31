import { NextResponse } from "next/server";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { prisma } from "@/lib/db";

const TERMINAL = new Set(["completed", "not_found", "mismatch", "failed", "needs_auth", "stopped"]);

/** Aggregate live status for a bulk container batch (polled by the UI). */
export async function GET(_req: Request, { params }: { params: { batchId: string } }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  if (!userHasPermission(user, PERMISSIONS.CONTAINER_SEARCH)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const batch = await prisma.containerBatch.findUnique({ where: { id: params.batchId } });
  if (!batch) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const rows = await prisma.containerSearch.findMany({ where: { batchId: batch.id }, orderBy: { createdAt: "asc" } });

  let verified = 0, failed = 0, done = 0, running = 0, queued = 0, stopped = 0;
  for (const r of rows) {
    if (r.status === "stopped") stopped++;
    else if (r.status === "completed" && r.pdfPath) verified++;
    else if (TERMINAL.has(r.status)) failed++;
    if (TERMINAL.has(r.status)) done++;
    else if (r.status === "running") running++;
    else queued++;
  }

  return NextResponse.json({
    batchId: batch.id,
    total: batch.total,
    running: running > 0 || queued > 0,
    stopped: stopped > 0 && running === 0 && queued === 0,
    counts: { total: rows.length, done, verified, failed, running, queued, stopped },
    containers: rows.map((r) => ({
      id: r.id,
      containerNo: r.portalContainerNo || r.containerNo,
      status: r.status,
      step: r.step,
      location: r.positionLocation,
      hasPdf: Boolean(r.pdfPath),
      pdfPages: r.pdfPages,
      error: r.error,
    })),
  });
}
