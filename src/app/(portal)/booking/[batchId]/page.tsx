import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { PageHeader, StatusBadge, Stat } from "@/components/ui";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { BookingLiveProgress } from "@/components/BookingLiveProgress";
import { reprocessBatchAction, startBookingBatchAction } from "@/app/actions/booking-batch";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

const REVIEWABLE = ["NEEDS_REVIEW", "MISMATCH", "SEARCH_FAILED", "FAILED", "DOWNLOAD_FAILED", "STATUS_MISMATCH", "PORTAL_AUTH_REQUIRED"];

export default async function BookingBatchPage({ params }: { params: { batchId: string } }) {
  const batch = await prisma.bookingBatch.findUnique({ where: { id: params.batchId } });
  if (!batch) notFound();
  const docs = await prisma.bookingDocument.findMany({ where: { batchId: batch.id }, orderBy: { serial: "asc" }, select: { state: true } });

  const user = await getSessionUser();
  const canExport = userHasPermission(user, PERMISSIONS.BOOKING_EXPORT);
  const canRetry = userHasPermission(user, PERMISSIONS.JOB_RETRY);
  const canReview = userHasPermission(user, PERMISSIONS.BOOKING_REVIEW);

  const completed = docs.filter((d) => d.state === "COMPLETED").length;
  const review = docs.filter((d) => REVIEWABLE.includes(d.state) && !["FAILED", "SEARCH_FAILED", "DOWNLOAD_FAILED"].includes(d.state)).length;
  const failed = docs.filter((d) => ["FAILED", "SEARCH_FAILED", "DOWNLOAD_FAILED"].includes(d.state)).length;
  const liveConfigured = env.INTEGRATION_MODE === "live" && env.DAMCO_LIVE_ENABLED && !!env.DAMCO_USERNAME && !!env.DAMCO_PASSWORD;
  const pendingDocs = docs.filter((d) => d.state !== "COMPLETED").length;
  // Processing is EXPLICIT-ONLY: it begins only when the user clicks Process
  // Selected / Process All / Start / Retry / Reprocess. The batch page no longer
  // auto-starts anything on mount — opening or reloading a batch must never kick
  // off work, and "Process Selected" of a few rows must never turn into a
  // whole-batch run (user requirement). An in-flight run keeps going in the
  // server process regardless; this page just polls and shows it.

  return (
    <div>
      <PageHeader
        title={`Booking batch ${batch.id.slice(0, 8)}`}
        subtitle={`${batch.company} · ${batch.buyer} · Damco mode: ${batch.damcoMode}`}
        actions={<StatusBadge status={batch.status} />}
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-4">
        <Stat label="Documents" value={batch.totalDocs} />
        <Stat label="Completed" value={completed} tone="text-green-700" />
        <Stat label="Needs review" value={review} tone="text-amber-700" />
        <Stat label="Failed" value={failed} tone="text-rose-700" />
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {canRetry && liveConfigured ? (
          <form action={startBookingBatchAction}>
            <input type="hidden" name="batchId" value={batch.id} />
            <button className="btn-primary text-xs" disabled={batch.liveStatus === "running" || pendingDocs === 0}>
              {batch.liveStatus === "running" ? "▶ Damco automation running…" : batch.liveStatus === "blocked" ? "▶ Resume Damco automation" : "▶ Start Damco automation"}
            </button>
          </form>
        ) : null}
        {canRetry ? (
          <form action={reprocessBatchAction}>
            <input type="hidden" name="batchId" value={batch.id} />
            <button className="btn-ghost text-xs">↻ Reprocess non-completed</button>
          </form>
        ) : null}
        {canExport ? <a href={`/api/booking/${batch.id}/zip`} className="btn-primary text-xs">⬇ Batch ZIP (completed)</a> : null}
        {canExport ? <a href={`/api/booking/${batch.id}/zip?include=all`} className="btn-ghost text-xs">⬇ ZIP · originals + Damco + edited</a> : null}
        <a href={`/api/booking/${batch.id}/failed-report`} className="btn-ghost text-xs">⬇ Failed / review report (CSV)</a>
        <Link href="/modules/booking-correction" className="btn-ghost text-xs">← Back to process</Link>
      </div>

      {/* The automation status line is rendered LIVE inside BookingLiveProgress
          (which polls), so no static server-rendered "Damco automation: running"
          banner here — that snapshot went stale and kept showing "running" after
          the run had finished. */}
      {!liveConfigured ? (
        <div className="mb-4 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
          Live Damco automation isn&apos;t enabled on this server, so this batch runs in simulation mode. Contact your administrator to enable live processing.
        </div>
      ) : null}

      {/* One unified batch view: overall progress bar, summary counts, centralized
          log, and a single place to review / retry / confirm / download each PDF.
          Per-PDF status indicators were removed in favour of this consolidated view. */}
      <BookingLiveProgress
        batchId={batch.id}
        canExport={canExport}
        canRetry={canRetry}
        canReview={canReview}
        canConfirm={canReview}
        initialRunning={batch.status === "processing" || batch.liveStatus === "running" || pendingDocs > 0}
      />
    </div>
  );
}
