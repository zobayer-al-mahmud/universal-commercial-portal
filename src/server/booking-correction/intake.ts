import { createHash } from "crypto";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { verifyBookingOnDamco } from "@/server/integrations/damco-adapter";
import { diffBookings, parseBookingText } from "./diff";

const MODULE = "booking-correction";

export interface BookingCorrectionIntakeResult {
  jobId: string;
  bookingKey: string;
  duplicate: boolean;
  status: string;
  allowedCount: number;
  disallowedCount: number;
  reviewTicketCount: number;
  damcoMessage: string;
}

/**
 * Diff an original vs corrected booking, persist the correction plan, and run a
 * read-only Damco SO verification (mock). Applying the correction to the portal is
 * a separate, gated step (live integration is blocked). Fail-closed on disallowed
 * (locked-field) changes.
 */
export async function intakeBookingCorrection(
  originalText: string,
  correctedText: string,
  opts: { actor?: string } = {},
): Promise<BookingCorrectionIntakeResult> {
  const actor = opts.actor ?? "system";
  const original = parseBookingText(originalText);
  const corrected = parseBookingText(correctedText);
  if (!original.orderNo) throw new Error("Original booking has no Order No.");

  const result = diffBookings(original, corrected);

  const hash = createHash("sha256").update(`${originalText}\n==\n${correctedText}`, "utf8").digest("hex");
  const existing = await prisma.sourceDocument.findUnique({ where: { sha256: hash } });
  if (existing?.jobId) {
    const job = await prisma.job.findUnique({ where: { id: existing.jobId } });
    return {
      jobId: existing.jobId,
      bookingKey: result.bookingKey,
      duplicate: true,
      status: job?.status ?? "duplicate",
      allowedCount: 0,
      disallowedCount: 0,
      reviewTicketCount: 0,
      damcoMessage: "Duplicate intake.",
    };
  }

  const job = await prisma.job.create({
    data: {
      module: MODULE,
      type: "booking-correction",
      businessKey: result.bookingKey,
      status: "received",
      payloadJson: JSON.stringify({ bookingKey: result.bookingKey, soNumber: result.soNumber }),
      resultJson: JSON.stringify({ allowedCount: result.allowedCount, disallowedCount: result.disallowedCount }),
    },
  });

  await prisma.sourceDocument.create({
    data: {
      jobId: job.id,
      kind: "booking-pair",
      originalName: `booking-${result.bookingKey}.txt`,
      sha256: hash,
      sizeBytes: Buffer.byteLength(originalText + correctedText),
      mimeDetected: "text/plain",
      storagePath: `./var/storage/booking-correction/${job.id}`,
      metadataJson: JSON.stringify({ bookingKey: result.bookingKey }),
    },
  });

  await prisma.jobStageEvent.create({
    data: { jobId: job.id, stage: "classified", status: "ok", message: `Booking ${result.bookingKey}; ${result.changes.length} change(s)` },
  });

  // Read-only Damco SO verification (mock); applying the change is gated.
  const damco = await verifyBookingOnDamco(result.soNumber);
  await prisma.jobStageEvent.create({
    data: { jobId: job.id, stage: "portal", status: damco.verified ? "ok" : "skipped", message: damco.message, dataJson: JSON.stringify({ ref: damco.ref, mode: damco.mode }) },
  });

  await prisma.bookingCorrection.create({
    data: {
      jobId: job.id,
      orderNo: result.orderNo,
      market: result.market,
      marketCode: result.marketCode,
      soNumber: result.soNumber,
      bookingKey: result.bookingKey,
      changeCount: result.changes.length,
      allowedCount: result.allowedCount,
      disallowedCount: result.disallowedCount,
      changesJson: JSON.stringify(result.changes),
      status: result.outcome,
      message: result.reviewReasons.map((r) => r.code).join("; "),
      damcoVerified: damco.verified,
      damcoRef: damco.ref,
      damcoMessage: damco.message,
    },
  });

  const seen = new Set<string>();
  let reviewTicketCount = 0;
  for (const rr of result.reviewReasons) {
    const key = rr.code + rr.reason;
    if (seen.has(key)) continue;
    seen.add(key);
    await prisma.reviewTicket.create({
      data: { jobId: job.id, module: MODULE, reasonCode: rr.code, reason: rr.reason, contextJson: JSON.stringify({ severity: rr.severity }) },
    });
    reviewTicketCount++;
  }

  await prisma.jobStageEvent.create({
    data: { jobId: job.id, stage: "reconciled", status: result.outcome === "queued" ? "failed" : "ok", message: `${result.allowedCount} allowed / ${result.disallowedCount} disallowed change(s)` },
  });

  await prisma.job.update({ where: { id: job.id }, data: { status: result.outcome } });
  await audit({ entityType: "job", entityId: job.id, action: "booking.correction.diffed", actor, data: { bookingKey: result.bookingKey, outcome: result.outcome } });

  return {
    jobId: job.id,
    bookingKey: result.bookingKey,
    duplicate: false,
    status: result.outcome,
    allowedCount: result.allowedCount,
    disallowedCount: result.disallowedCount,
    reviewTicketCount,
    damcoMessage: damco.message,
  };
}
