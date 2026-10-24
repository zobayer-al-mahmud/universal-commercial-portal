import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { PageHeader, StatusBadge, Stat } from "@/components/ui";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { ExtractionReview } from "@/components/ExtractionReview";
import { BookingBatchAutoStart } from "@/components/BookingBatchAutoStart";
import { BookingLiveProgress } from "@/components/BookingLiveProgress";
import { retryBookingDocAction, reprocessBatchAction, confirmBookingPdfAction, startBookingBatchAction } from "@/app/actions/booking-batch";
import type { MatchResult } from "@/server/booking-correction/batch-types";
import { displayProgress, PROGRESS_TONE } from "@/server/booking-correction/progress";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

const STATE_TONE: Record<string, string> = {
  COMPLETED: "bg-green-100 text-green-800",
  MISMATCH: "bg-rose-100 text-rose-800",
  STATUS_MISMATCH: "bg-rose-100 text-rose-800",
  SEARCH_FAILED: "bg-rose-100 text-rose-800",
  DOWNLOAD_FAILED: "bg-rose-100 text-rose-800",
  FAILED: "bg-rose-100 text-rose-800",
  NEEDS_REVIEW: "bg-amber-100 text-amber-800",
  PORTAL_AUTH_REQUIRED: "bg-amber-100 text-amber-800",
};

function tone(state: string) {
  return STATE_TONE[state] ?? "bg-sky-100 text-sky-800";
}

const REVIEWABLE = ["NEEDS_REVIEW", "MISMATCH", "SEARCH_FAILED", "FAILED", "DOWNLOAD_FAILED", "STATUS_MISMATCH", "PORTAL_AUTH_REQUIRED"];

export default async function BookingBatchPage({ params }: { params: { batchId: string } }) {
  const batch = await prisma.bookingBatch.findUnique({ where: { id: params.batchId } });
  if (!batch) notFound();
  const docs = await prisma.bookingDocument.findMany({ where: { batchId: batch.id }, orderBy: { serial: "asc" }, include: { events: { orderBy: { createdAt: "asc" } } } });

  const user = await getSessionUser();
  const canExport = userHasPermission(user, PERMISSIONS.BOOKING_EXPORT);
  const canRetry = userHasPermission(user, PERMISSIONS.JOB_RETRY);
  const canReview = userHasPermission(user, PERMISSIONS.BOOKING_REVIEW);

  const completed = docs.filter((d) => d.state === "COMPLETED").length;
  const review = docs.filter((d) => REVIEWABLE.includes(d.state) && !["FAILED", "SEARCH_FAILED", "DOWNLOAD_FAILED"].includes(d.state)).length;
  const failed = docs.filter((d) => ["FAILED", "SEARCH_FAILED", "DOWNLOAD_FAILED"].includes(d.state)).length;
  const liveConfigured = env.INTEGRATION_MODE === "live" && env.DAMCO_LIVE_ENABLED && !!env.DAMCO_USERNAME && !!env.DAMCO_PASSWORD;
  const pendingDocs = docs.filter((d) => d.state !== "COMPLETED").length;
  const canAutoStart = canRetry && liveConfigured && pendingDocs > 0 && batch.liveStatus !== "running";

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

      <BookingBatchAutoStart batchId={batch.id} shouldStart={canAutoStart} action={startBookingBatchAction} />

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
        <Link href="/modules/booking-correction" className="btn-ghost text-xs">← Back to module</Link>
      </div>

      {batch.liveMessage ? (
        <div className={`mb-4 rounded-md border px-3 py-2 text-xs ${batch.liveStatus === "blocked" ? "border-amber-200 bg-amber-50 text-amber-800" : batch.liveStatus === "failed" ? "border-rose-200 bg-rose-50 text-rose-800" : "border-slate-200 bg-slate-50 text-slate-700"}`}>
          <strong>Damco automation:</strong> {batch.liveStatus} · {batch.liveMessage}
        </div>
      ) : null}
      {!liveConfigured ? (
        <div className="mb-4 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
          Live Damco automation isn&apos;t enabled on this server, so this batch runs in simulation mode. Contact your administrator to enable live processing.
        </div>
      ) : null}

      <section className="mb-8">
        <h2 className="mb-3 text-sm font-semibold text-slate-800">Automation progress</h2>
        <BookingLiveProgress
          batchId={batch.id}
          canExport={canExport}
          canRetry={canRetry}
          initialRunning={batch.status === "processing" || batch.liveStatus === "running" || pendingDocs > 0}
        />
      </section>

      {/* Results table — one row per uploaded document (§12). */}
      <section className="card mb-8 overflow-x-auto">
        <div className="border-b border-slate-100 px-4 py-3 text-sm font-semibold text-slate-700">Results</div>
        <table className="w-full whitespace-nowrap text-xs">
          <thead className="bg-slate-50">
            <tr>
              <th className="th">SL</th><th className="th">File</th><th className="th">PO</th>
              <th className="th">GW in</th><th className="th">GW bk</th>
              <th className="th">Ctn in</th><th className="th">Ctn bk</th>
              <th className="th">Qty in</th><th className="th">Qty bk</th>
              <th className="th">Booking</th><th className="th">Orig status</th><th className="th">Final</th>
              <th className="th">Progress</th><th className="th">State</th><th className="th">Note</th><th className="th">When</th><th className="th">Download</th>
            </tr>
          </thead>
          <tbody>
            {docs.map((d) => {
              const prog = displayProgress(d);
              return (
              <tr key={d.id} className="border-t border-slate-50">
                <td className="td">{d.serial}</td>
                <td className="td max-w-[160px] truncate" title={d.originalName}>{d.originalName}</td>
                <td className="td font-mono">{d.poNumber || "—"} <span className="text-slate-400">{d.countryCode}</span></td>
                <td className="td">{d.extractedGrossWeight || "—"}</td>
                <td className="td">{d.bookingGrossWeight || "—"}</td>
                <td className="td">{d.extractedCartons || "—"}</td>
                <td className="td">{d.bookingCartons || "—"}</td>
                <td className="td">{d.extractedQuantity || "—"}</td>
                <td className="td">{d.bookingQuantity || "—"}</td>
                <td className="td font-mono">{d.bookingRef || "—"}</td>
                <td className="td">{d.headingStatus || "—"}</td>
                <td className="td">{d.finalStatus || "—"}</td>
                <td className="td"><span className={`badge ${PROGRESS_TONE[prog.label]}`} title={`step ${prog.step}/${prog.of}`}>{prog.label}</span></td>
                <td className="td"><span className={`badge ${tone(d.state)}`}>{d.state}</span></td>
                <td className="td max-w-[200px] truncate text-rose-600" title={d.error || d.warning}>{d.error || d.warning || "—"}</td>
                <td className="td text-slate-400">{d.processedAt ? d.processedAt.toISOString().slice(5, 16).replace("T", " ") : "—"}</td>
                <td className="td">
                  <div className="flex flex-wrap gap-2">
                    {canExport && d.state === "COMPLETED" ? <a href={`/api/booking/doc/${d.id}/generated`} className="text-ananta hover:underline">PDF</a> : null}
                    {canExport && d.portalPdfPath ? <a href={`/api/booking/doc/${d.id}/portal`} target="_blank" rel="noreferrer" className="text-indigo-700 hover:underline" title={`Damco portal PDF (${d.portalPdfSha256.slice(0, 10)}…) — preview in new tab`}>portal</a> : null}
                    {canExport && d.portalPdfPath ? <a href={`/api/booking/doc/${d.id}/portal?download=1`} className="text-indigo-700/70 hover:underline" title="Download the Damco portal PDF">⬇</a> : null}
                    {canExport && d.correctedPdfPath ? <a href={`/api/booking/doc/${d.id}/corrected`} className="text-emerald-700 hover:underline">edited</a> : null}
                    {canExport ? <a href={`/api/booking/doc/${d.id}/original`} className="text-slate-500 hover:underline">orig</a> : null}
                    {canReview ? <Link href={`/booking/doc/${d.id}/edit`} className="text-slate-700 hover:underline">edit</Link> : null}
                  </div>
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      {/* Per-document detail: comparisons, status, review editor, retry, audit. */}
      <h3 className="mb-3 text-sm font-semibold text-slate-700">Document details</h3>
      <div className="space-y-4">
        {docs.map((d) => {
          let match: MatchResult | null = null;
          try { match = d.matchJson && d.matchJson !== "{}" ? (JSON.parse(d.matchJson) as MatchResult) : null; } catch { /* ignore */ }
          return (
            <div key={d.id} className="card p-5">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-slate-700">#{d.serial} · {d.originalName}</span>
                  <span className={`badge ${tone(d.state)}`}>{d.state}</span>
                  {d.manualCorrected ? <span className="badge bg-indigo-100 text-indigo-700">manually corrected</span> : null}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {canReview && d.headingStatus === "REQUESTED" && d.fieldStatus === "REQUESTED" ? (
                    <form action={confirmBookingPdfAction}>
                      <input type="hidden" name="docId" value={d.id} />
                      <button className="btn-primary text-xs" title="Rewrite the corrected PDF with BOOKING CONFIRMED title + status">✓ Confirm PDF (one click)</button>
                    </form>
                  ) : null}
                  {canReview ? <Link href={`/booking/doc/${d.id}/edit`} className="btn-ghost text-xs">✎ Edit PDF text</Link> : null}
                  {canRetry && d.state !== "COMPLETED" ? (
                    <form action={retryBookingDocAction}>
                      <input type="hidden" name="docId" value={d.id} />
                      <input type="hidden" name="batchId" value={batch.id} />
                      <button className="btn-ghost text-xs">↻ Retry</button>
                    </form>
                  ) : null}
                </div>
              </div>

              <div className="grid gap-3 text-xs sm:grid-cols-3 lg:grid-cols-4">
                <div><div className="font-medium text-slate-500">PO · Country</div>{d.poNumber || "—"} · {d.countryCode || "—"}</div>
                <div><div className="font-medium text-slate-500">Booking ref (SO)</div>{d.bookingRef || "—"}</div>
                <div><div className="font-medium text-slate-500">Extraction confidence</div>{(d.extractionConfidence * 100).toFixed(0)}%</div>
                <div><div className="font-medium text-slate-500">Final status</div>{d.finalStatus || "—"}</div>
              </div>

              {match ? (
                <table className="mt-3 w-full text-xs">
                  <thead className="bg-slate-50">
                    <tr><th className="th">Field</th><th className="th">Input PDF</th><th className="th">Damco booking</th><th className="th">Rule</th><th className="th">Result</th></tr>
                  </thead>
                  <tbody>
                    {match.comparisons.map((c, i) => (
                      <tr key={i} className="border-t border-slate-50">
                        <td className="td">{c.label}</td>
                        <td className="td font-mono">{c.input || "∅"}</td>
                        <td className="td font-mono">{c.booking || "∅"}</td>
                        <td className="td text-slate-400">{c.rule}</td>
                        <td className="td">{c.match ? <span className="text-green-700">✓ match</span> : <span className="text-rose-700">✗ {c.difference}</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : null}

              {(d.warning || d.error) ? <p className="mt-2 text-xs text-rose-600">{d.error || d.warning}</p> : null}

              {canReview && REVIEWABLE.includes(d.state) ? (
                <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-3">
                  <div className="mb-2 text-xs font-semibold text-amber-800">Review & correct extracted values</div>
                  <ExtractionReview
                    docId={d.id}
                    poNumber={d.poNumber}
                    countryCode={d.countryCode}
                    grossWeight={d.extractedGrossWeight}
                    cartons={d.extractedCartons}
                    quantity={d.extractedQuantity}
                  />
                </div>
              ) : null}

              {d.events.length > 0 ? (
                <details className="mt-3">
                  <summary className="cursor-pointer text-xs font-medium text-slate-500">Processing history ({d.events.length})</summary>
                  <ol className="mt-2 space-y-1 text-xs">
                    {d.events.map((e) => (
                      <li key={e.id} className="flex items-start gap-2">
                        <span className={`badge ${e.status === "ok" ? "bg-green-100 text-green-700" : e.status === "failed" ? "bg-rose-100 text-rose-700" : "bg-slate-100 text-slate-600"}`}>{e.stage}</span>
                        <span className="text-slate-600">{e.message}</span>
                        <span className="ml-auto text-[10px] text-slate-400">{e.createdAt.toISOString().slice(11, 19)}</span>
                      </li>
                    ))}
                  </ol>
                </details>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
