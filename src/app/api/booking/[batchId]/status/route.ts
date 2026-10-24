import { NextResponse } from "next/server";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { prisma } from "@/lib/db";
import { liveStage, BOOKING_STEPS } from "@/server/booking-correction/progress";
import type { MatchResult } from "@/server/booking-correction/batch-types";

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

  const TERMINAL = new Set([
    "COMPLETED",
    "MISMATCH",
    "STATUS_MISMATCH",
    "SEARCH_FAILED",
    "DOWNLOAD_FAILED",
    "FAILED",
    "NEEDS_REVIEW",
    "PORTAL_AUTH_REQUIRED",
  ]);
  const allTerminal = docs.length > 0 && docs.every((d) => TERMINAL.has(d.state));

  return NextResponse.json({
    batchId: batch.id,
    status: batch.status,
    liveStatus: batch.liveStatus,
    liveStep: batch.liveStep,
    liveMessage: batch.liveMessage,
    liveDocId: batch.liveDocId,
    steps: BOOKING_STEPS,
    running: !allTerminal,
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
