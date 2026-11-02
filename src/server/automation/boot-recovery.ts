import { prisma } from "@/lib/db";
import { env } from "@/lib/env";

/**
 * Crash/restart recovery for interrupted automation runs.
 *
 * The run registry (automation/cancellation.ts) is in-memory, so after a server
 * restart every row left in a transient "running"/in-flight state is ORPHANED —
 * no loop is driving it, yet the UI would show a phantom "running". On boot we
 * reset those rows to a resumable pending state and park their job/batch so the
 * status is honest. Completed rows, downloaded PDFs and saved files are never
 * touched. We do NOT auto-drive the live portals unattended; the operator (or
 * the next explicit action) resumes. AUTOMATION_RESUME_ON_BOOT is reserved for a
 * future opt-in auto-resume and only affects logging today.
 */

const EXP_ACTIVE = ["queued", "running"];
const EXP_DONE = ["matched", "filled", "updated", "updated_verified", "downloaded"];
const EXP_FAILED = ["not_found", "mismatch", "failed", "needs_auth", "update_failed"];
const BOOKING_INFLIGHT = ["EXTRACTING", "READY_TO_SEARCH", "PORTAL_SEARCH", "BOOKING_MATCHING", "PDF_GENERATING", "STATUS_VALIDATION"];

export async function recoverInterruptedRuns(): Promise<void> {
  const mode = env.AUTOMATION_RESUME_ON_BOOT ? "resume-on-boot" : "park-only";
  let total = 0;
  for (const [name, fn] of [["exp", recoverExp], ["booking", recoverBooking], ["container", recoverContainer]] as const) {
    try {
      total += await fn();
    } catch (e) {
      console.error(`[boot-recovery] ${name} recovery failed:`, e instanceof Error ? e.message : e);
    }
  }
  if (total > 0) console.log(`[boot-recovery] reset ${total} interrupted row(s) (${mode}).`);
}

/** EXP: queued/running rows → pending; running/stopping jobs → a parked status. */
async function recoverExp(): Promise<number> {
  const { count } = await prisma.expJobRow.updateMany({ where: { status: { in: EXP_ACTIVE } }, data: { status: "pending", step: "" } });
  const jobs = await prisma.expJob.findMany({ where: { status: { in: ["running", "stopping"] } }, select: { id: true } });
  for (const j of jobs) {
    const rows = await prisma.expJobRow.findMany({ where: { jobId: j.id }, select: { status: true } });
    const done = rows.filter((r) => EXP_DONE.includes(r.status)).length;
    const failed = rows.filter((r) => EXP_FAILED.includes(r.status)).length;
    const pending = rows.some((r) => r.status === "pending");
    const status = done + failed > 0 ? (pending ? "idle" : failed > 0 ? "partially_failed" : "completed") : "created";
    await prisma.expJob.update({ where: { id: j.id }, data: { status } }).catch(() => undefined);
  }
  return count;
}

/** Booking: in-flight docs → UPLOADED; processing/stopping batches → parked. */
async function recoverBooking(): Promise<number> {
  const { count } = await prisma.bookingDocument.updateMany({ where: { state: { in: BOOKING_INFLIGHT } }, data: { state: "UPLOADED" } });
  await prisma.bookingBatch
    .updateMany({
      where: { OR: [{ status: "processing" }, { status: "stopping" }, { liveStatus: "running" }] },
      data: { status: "uploaded", liveStatus: "interrupted", liveMessage: "Interrupted by a server restart — press Start/Process to continue." },
    })
    .catch(() => undefined);
  return count;
}

/** Container: running searches → queued (their resumable state). */
async function recoverContainer(): Promise<number> {
  const { count } = await prisma.containerSearch
    .updateMany({ where: { status: "running" }, data: { status: "queued", step: "" } })
    .catch(() => ({ count: 0 }));
  return count;
}
