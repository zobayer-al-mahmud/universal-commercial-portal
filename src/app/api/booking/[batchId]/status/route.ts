import { NextResponse } from "next/server";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { prisma } from "@/lib/db";
import { liveStage, BOOKING_STEPS } from "@/server/booking-correction/progress";
import type { MatchResult } from "@/server/booking-correction/batch-types";

/** Parse the batch's stored run-scope (JSON array of doc ids) → string[] | null. */
function parseRunScope(json: string | null): string[] | null {
  if (!json) return null;
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) && arr.length ? (arr as string[]) : null;
  } catch {
    return null;
  }
}

export const dynamic = "force-dynamic";

/** Live status + per-document progress for one booking batch (polled by the UI). */
export async function GET(_req: Request, { params }: { params: { batchId: string } }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  if (!userHasPermission(user, PERMISSIONS.JOB_READ)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const batch = await prisma.bookingBatch.findUnique({ where: { id: params.batchId } });
  if (!batch) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const docs = await prisma.bookingDocument.findMany({
    where: { batchId: batch.id },
    orderBy: { serial: "asc" },
    include: { events: { orderBy: { createdAt: "asc" }, take: 40 } },
  });

  // Actively-processing document states (mid-pipeline). UPLOADED is NOT one of
  // them — it means "pending / never started". A run is "running" only while the
  // backend run is live (batch.liveStatus === "running") or at least one document
  // is mid-pipeline; untouched UPLOADED rows (e.g. the rows a Process Selected run
  // never picked) must NOT keep the batch "running" — that left the Stop button,
  // the "live" indicator and polling stuck on after a scoped run had finished.
  const IN_FLIGHT = new Set([
    "EXTRACTING", "READY_TO_SEARCH", "PORTAL_SEARCH", "BOOKING_MATCHING", "PDF_GENERATING", "STATUS_VALIDATION",
  ]);
  const anyInFlight = docs.some((d) => IN_FLIGHT.has(d.state));
  const stopping = batch.status === "stopping";
  const stopped = batch.status === "stopped";
  const isRunning = !stopped && (batch.liveStatus === "running" || stopping || anyInFlight);

  return NextResponse.json({
    batchId: batch.id,
    status: batch.status,
    liveStatus: batch.liveStatus,
    liveStep: batch.liveStep,
    liveMessage: batch.liveMessage,
    liveDocId: batch.liveDocId,
    steps: BOOKING_STEPS,
    // "stopping" stays running so the UI keeps polling until the batch is parked.
    running: isRunning,
    stopping,
    stopped,
    // Doc ids the active/most-recent run is processing (Process Selected / Retry /
    // Reprocess). The UI scopes the progress bar, counters, current-row and log to
    // these so a 3-row selection never displays as whole-batch progress. null when
    // a run covers the whole batch or no scope is recorded.
    runScope: parseRunScope(batch.runScopeJson),
    totals: {
      total: batch.totalDocs,
      completed: batch.completedDocs,
      review: batch.reviewDocs,
      failed: batch.failedDocs,
    },
    docs: docs.map((d) => {
      let match: MatchResult | null = null;
      try {
        match = d.matchJson ? (JSON.parse(d.matchJson) as MatchResult) : null;
      } catch {
        match = null;
      }
      const stage = liveStage({ state: d.state, liveStep: d.liveStep, portalPdfPath: d.portalPdfPath });
      return {
        id: d.id,
        serial: d.serial,
        name: d.originalName,
        state: d.state,
        liveStep: d.liveStep,
        stage,
        poNumber: d.poNumber,
        countryCode: d.countryCode,
        shipper: d.shipper,
        frCode: d.frCode,
        sourceType: d.sourceType,
        bookingRef: d.bookingRef,
        finalStatus: d.finalStatus,
        headingStatus: d.headingStatus,
        fieldStatus: d.fieldStatus,
        error: d.error,
        warning: d.warning,
        extracted: {
          grossWeight: d.extractedGrossWeight,
          cartons: d.extractedCartons,
          quantity: d.extractedQuantity,
        },
        booking: {
          grossWeight: d.bookingGrossWeight,
          cartons: d.bookingCartons,
          quantity: d.bookingQuantity,
        },
        match: match
          ? {
              outcome: match.outcome ?? "",
              comparisons: Array.isArray(match.comparisons) ? match.comparisons : [],
              notes: Array.isArray(match.notes) ? match.notes : [],
            }
          : null,
        hasOriginal: Boolean(d.storagePath),
        hasPortalPdf: Boolean(d.portalPdfPath),
        hasGeneratedPdf: Boolean(d.generatedPdfPath),
        hasCorrectedPdf: Boolean(d.correctedPdfPath),
        events: d.events.map((e) => ({ step: e.stage, status: e.status, message: e.message, at: e.createdAt.toISOString() })),
      };
    }),
  });
}
