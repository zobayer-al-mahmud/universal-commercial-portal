"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import type { StepPhase } from "@/server/booking-correction/progress";
import { retryBookingDocAction, confirmBookingPdfAction } from "@/app/actions/booking-batch";
import { ExtractionReview } from "@/components/ExtractionReview";
import { StopProcessButton } from "@/components/StopProcessButton";

interface Comparison {
  field: string;
  label: string;
  input: string;
  booking: string;
  match: boolean;
  difference: string;
}

interface DocStatus {
  id: string;
  serial: number;
  name: string;
  state: string;
  liveStep: string | null;
  stage: { current: number; phase: "running" | "done" | "error"; errorStep: number; steps: StepPhase[] };
  poNumber: string;
  countryCode: string;
  shipper?: string;
  frCode?: string;
  sourceType?: string;
  bookingRef: string;
  finalStatus: string;
  headingStatus?: string;
  fieldStatus?: string;
  error: string;
  warning: string;
  extracted: { grossWeight: string; cartons: string; quantity: string };
  booking: { grossWeight: string; cartons: string; quantity: string };
  match: { outcome: string; comparisons: Comparison[]; notes: string[] } | null;
  hasOriginal: boolean;
  hasPortalPdf: boolean;
  hasGeneratedPdf: boolean;
  hasCorrectedPdf: boolean;
  events: { step: string; status: string; message: string; at: string }[];
}

interface StatusPayload {
  batchId: string;
  status: string;
  liveStatus: string | null;
  liveMessage: string | null;
  running: boolean;
  stopping?: boolean;
  stopped?: boolean;
  totals: { total: number; completed: number; review: number; failed: number };
  docs: DocStatus[];
  /** Doc ids the active/most-recent run is processing; when set, the progress
   *  bar, counters, current-row and log are scoped to these rows only. */
  runScope?: string[] | null;
}

const TERMINAL_ERROR = new Set(["MISMATCH", "STATUS_MISMATCH", "SEARCH_FAILED", "DOWNLOAD_FAILED", "FAILED", "NEEDS_REVIEW", "PORTAL_AUTH_REQUIRED"]);
const REVIEWABLE = new Set(["NEEDS_REVIEW", "MISMATCH", "SEARCH_FAILED", "FAILED", "DOWNLOAD_FAILED", "STATUS_MISMATCH", "PORTAL_AUTH_REQUIRED"]);

function stateLabel(state: string): string {
  return state.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
}

function stateTone(state: string): string {
  if (state === "COMPLETED") return "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-600/15";
  if (TERMINAL_ERROR.has(state)) {
    if (state === "NEEDS_REVIEW" || state === "PORTAL_AUTH_REQUIRED") return "bg-amber-50 text-amber-700 ring-1 ring-amber-600/20";
    return "bg-rose-50 text-rose-700 ring-1 ring-rose-600/15";
  }
  return "bg-sky-50 text-sky-700 ring-1 ring-sky-600/15";
}

function ValueRow({ c }: { c: Comparison }) {
  return (
    <tr className="border-t border-slate-100">
      <td className="px-3 py-1.5 text-slate-600">{c.label}</td>
      <td className="px-3 py-1.5 font-mono">{c.input || "—"}</td>
      <td className="px-3 py-1.5 font-mono">{c.booking || "—"}</td>
      <td className="px-3 py-1.5">
        {c.match ? (
          <span className="text-emerald-600">✓ match</span>
        ) : (
          <span className="text-rose-600">✕ {c.difference || "differs"}</span>
        )}
      </td>
    </tr>
  );
}

/** A doc whose real Damco status is still REQUESTED (or unverified) → eligible for verify-only confirm. */
function isUnconfirmed(doc: DocStatus): boolean {
  if (doc.state === "COMPLETED") return false;
  return /requested/i.test(doc.finalStatus || "") || doc.state === "STATUS_MISMATCH" || doc.state === "PORTAL_AUTH_REQUIRED";
}

function needsAttention(doc: DocStatus): boolean {
  return doc.state !== "COMPLETED" && (doc.stage.phase === "error" || isUnconfirmed(doc));
}

function DownloadLinks({ doc, canExport, canReview }: { doc: DocStatus; canExport: boolean; canReview: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
      {doc.hasPortalPdf && canExport ? (
        <>
          <a href={`/api/booking/doc/${doc.id}/portal`} target="_blank" rel="noreferrer" className="font-medium text-ananta hover:underline">👁 Damco PDF</a>
          <a href={`/api/booking/doc/${doc.id}/portal?download=1`} className="text-ananta/70 hover:underline" title="Download the Damco portal PDF">⬇</a>
        </>
      ) : null}
      {doc.hasGeneratedPdf && canExport ? (
        <a href={`/api/booking/doc/${doc.id}/generated`} target="_blank" rel="noreferrer" className="text-slate-500 hover:underline">UCP PDF</a>
      ) : null}
      {doc.hasCorrectedPdf && canExport ? (
        <a href={`/api/booking/doc/${doc.id}/corrected`} target="_blank" rel="noreferrer" className="text-emerald-700 hover:underline">edited</a>
      ) : null}
      {doc.hasOriginal && canExport ? (
        <a href={`/api/booking/doc/${doc.id}/original`} target="_blank" rel="noreferrer" className="text-slate-500 hover:underline">original</a>
      ) : null}
      {canReview ? <Link href={`/booking/doc/${doc.id}/edit`} className="text-slate-700 hover:underline">✎ edit PDF text</Link> : null}
    </div>
  );
}

/** A focused panel for a document that still needs a human: error + value diff +
 *  correction form + retry/confirm. It carries NO per-PDF progress indicator —
 *  overall progress lives in the single batch bar above. */
function AttentionItem({ doc, batchId, canExport, canRetry, canReview, canConfirm, onChanged }: { doc: DocStatus; batchId: string; canExport: boolean; canRetry: boolean; canReview: boolean; canConfirm: boolean; onChanged: () => void }) {
  const [pending, startTransition] = useTransition();

  function retry() {
    const fd = new FormData();
    fd.set("docId", doc.id);
    fd.set("batchId", batchId);
    startTransition(async () => {
      await retryBookingDocAction(fd);
      setTimeout(onChanged, 700);
    });
  }

  function confirmBooking() {
    const fd = new FormData();
    fd.set("docId", doc.id);
    fd.set("batchId", batchId);
    startTransition(async () => {
      await confirmBookingPdfAction(fd);
      setTimeout(onChanged, 700);
    });
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-slate-400">#{doc.serial}</span>
            <span className="truncate text-sm font-semibold text-slate-800">{doc.name}</span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
            {doc.poNumber ? <span>PO <span className="font-mono text-slate-700">{doc.poNumber}</span></span> : null}
            {doc.countryCode ? <span>SKU <span className="font-mono text-slate-700">{doc.countryCode}</span></span> : null}
            {doc.shipper ? <span>Shipper <span className="text-slate-700">{doc.shipper}</span></span> : null}
            {doc.frCode ? <span>FR <span className="font-mono text-slate-700">{doc.frCode}</span></span> : null}
            {doc.bookingRef ? <span>Booking <span className="font-mono text-slate-700">{doc.bookingRef}</span></span> : null}
          </div>
        </div>
        <span className={`badge ${stateTone(doc.state)}`}>{stateLabel(doc.state)}</span>
      </div>

      {doc.error || doc.warning ? (
        <div className={`mt-3 rounded-lg border px-3 py-2 text-xs ${doc.stage.phase === "error" ? "border-rose-200 bg-rose-50 text-rose-700" : "border-amber-200 bg-amber-50 text-amber-800"}`}>
          {doc.error || doc.warning}
        </div>
      ) : null}

      {doc.match && (doc.match.comparisons?.length ?? 0) > 0 ? (
        <div className="mt-3 overflow-x-auto rounded-lg border border-slate-200">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                <th className="px-3 py-1.5 text-left font-semibold">Value</th>
                <th className="px-3 py-1.5 text-left font-semibold">Packing list</th>
                <th className="px-3 py-1.5 text-left font-semibold">Damco booking</th>
                <th className="px-3 py-1.5 text-left font-semibold">Result</th>
              </tr>
            </thead>
            <tbody>
              {(doc.match.comparisons ?? []).map((c) => <ValueRow key={c.field} c={c} />)}
            </tbody>
          </table>
        </div>
      ) : null}

      {canReview && REVIEWABLE.has(doc.state) ? (
        <div className="mt-3 rounded-md border border-amber-200 bg-amber-50/60 p-3">
          <div className="mb-2 text-xs font-semibold text-amber-800">Review &amp; correct extracted values</div>
          <ExtractionReview
            docId={doc.id}
            poNumber={doc.poNumber}
            countryCode={doc.countryCode}
            grossWeight={doc.extracted.grossWeight}
            cartons={doc.extracted.cartons}
            quantity={doc.extracted.quantity}
          />
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <DownloadLinks doc={doc} canExport={canExport} canReview={canReview} />
        <div className="ml-auto flex items-center gap-2">
          {canConfirm && isUnconfirmed(doc) ? (
            <button onClick={confirmBooking} disabled={pending} className="btn-ghost btn-xs text-emerald-700" title="Re-check the live Damco status; marks CONFIRMED only if the portal itself reports CONFIRMED.">
              {pending ? "Verifying…" : "✓ Confirm Booking"}
            </button>
          ) : null}
          {canRetry ? (
            <button onClick={retry} disabled={pending} className="btn-ghost btn-xs">
              {pending ? "Retrying…" : "↻ Retry"}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// --- All Documents filter buckets (confirmed / requested / failed / pending) ---
type DocFilter = "all" | "confirmed" | "requested" | "failed";
function docBucket(doc: DocStatus): Exclude<DocFilter, "all"> | "pending" {
  if (doc.state === "COMPLETED") return "confirmed";
  if (isUnconfirmed(doc)) return "requested"; // REQUESTED / STATUS_MISMATCH / PORTAL_AUTH_REQUIRED
  if (doc.stage.phase === "error") return "failed";
  return "pending"; // uploaded / mid-pipeline
}
/** Case-insensitive match of a search term against a document's identifiers. */
function docMatchesSearch(d: DocStatus, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return [String(d.serial), d.name, d.poNumber, d.countryCode, d.shipper, d.frCode, d.bookingRef]
    .some((v) => (v || "").toLowerCase().includes(needle));
}
/** Does this document have any downloadable PDF (for bulk download/select)? */
function docHasAnyPdf(d: DocStatus): boolean {
  return d.hasCorrectedPdf || d.hasPortalPdf || d.hasGeneratedPdf || d.hasOriginal;
}

/** One metric tile in the live process summary. */
function SummaryCard({ label, value, tone }: { label: string; value: number; tone: "slate" | "emerald" | "amber" | "rose" | "sky" }) {
  const tones: Record<string, string> = {
    slate: "border-slate-200 bg-slate-50 text-slate-700",
    emerald: "border-emerald-200 bg-emerald-50 text-emerald-700",
    amber: "border-amber-200 bg-amber-50 text-amber-700",
    rose: "border-rose-200 bg-rose-50 text-rose-700",
    sky: "border-sky-200 bg-sky-50 text-sky-700",
  };
  return (
    <div className={`rounded-lg border p-2.5 ${tones[tone]}`}>
      <div className="text-[10px] font-semibold uppercase tracking-wide opacity-70">{label}</div>
      <div className="mt-0.5 text-xl font-bold tabular-nums">{value}</div>
    </div>
  );
}

export function BookingLiveProgress({
  batchId,
  canExport,
  canRetry,
  canReview = false,
  canConfirm = false,
  initialRunning,
}: {
  batchId: string;
  canExport: boolean;
  canRetry: boolean;
  canReview?: boolean;
  canConfirm?: boolean;
  initialRunning: boolean;
}) {
  const [data, setData] = useState<StatusPayload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [retrying, startRetryAll] = useTransition();
  const [showLog, setShowLog] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [docFilter, setDocFilter] = useState<DocFilter>("all");
  const [docSearch, setDocSearch] = useState("");
  const [bulkConfirm, setBulkConfirm] = useState<{ running: boolean; done: number; total: number; confirmed: number; stillRequested: number; failed: number } | null>(null);
  const [, startBulk] = useTransition();
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const wasRunningRef = useRef(false);
  const router = useRouter();

  const stop = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }, []);

  const poll = useCallback(async () => {
    try {
      const r = await fetch(`/api/booking/${batchId}/status`, { cache: "no-store" });
      if (!r.ok) { setErr(`Status ${r.status}`); return; }
      const payload = (await r.json()) as StatusPayload;
      setData(payload);
      setErr(null);
      // When a run finishes (running → not-running), refresh the server-rendered
      // page once so the status badge, "Start automation" button and counters
      // sync with the backend's final state (they are not polled).
      if (wasRunningRef.current && !payload.running) router.refresh();
      wasRunningRef.current = payload.running;
      if (!payload.running) stop();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "poll failed");
    }
  }, [batchId, stop, router]);

  useEffect(() => {
    void poll();
    // Always poll briefly on mount; keep polling while the batch is running.
    pollRef.current = setInterval(() => void poll(), 1500);
    return () => stop();
  }, [poll, stop, initialRunning]);

  const restart = useCallback(() => {
    if (!pollRef.current) pollRef.current = setInterval(() => void poll(), 1500);
    void poll();
  }, [poll]);

  // Scope everything the progress panel reports to the rows the active run is
  // processing (Process Selected / Retry / Reprocess). Falls back to the whole
  // batch when no scope is recorded. The review lists below stay whole-batch.
  const runScopeSet = data?.runScope && data.runScope.length ? new Set(data.runScope) : null;
  const inScope = (d: DocStatus) => !runScopeSet || runScopeSet.has(d.id);
  const failedDocs = (data?.docs ?? []).filter((d) => inScope(d) && d.stage.phase === "error");
  const retryAllFailed = useCallback(() => {
    startRetryAll(async () => {
      for (const d of failedDocs) {
        const fd = new FormData();
        fd.set("docId", d.id);
        fd.set("batchId", batchId);
        await retryBookingDocAction(fd);
      }
      restart();
    });
  }, [failedDocs, batchId, restart]);

  if (!data) {
    return (
      <div className="card flex items-center gap-3 p-5 text-sm text-slate-500">
        <span className="spinner" /> Loading batch progress…
      </div>
    );
  }

  // --- Run progress (scoped to the active run's rows, not the whole batch) ---
  const docs = data.docs;
  const scoped = docs.filter(inScope);
  const isScoped = !!runScopeSet && scoped.length < docs.length;
  const total = scoped.length || data.totals.total || docs.length;
  const confirmed = scoped.filter((d) => d.state === "COMPLETED").length;
  const requested = scoped.filter((d) => isUnconfirmed(d)).length;
  const failed = scoped.filter((d) => d.stage.phase === "error" && !isUnconfirmed(d) && d.state !== "COMPLETED").length;
  const doneCount = scoped.filter((d) => d.stage.phase === "done" || d.stage.phase === "error").length;
  const pct = total > 0 ? Math.round((doneCount / total) * 100) : 0;
  const currentDoc = scoped.find((d) => d.stage.phase === "running");
  const attention = docs.filter(needsAttention); // review list stays whole-batch

  // Live log, scoped to the rows this run is processing.
  const combinedLog = scoped
    .flatMap((d) => (d.events ?? []).map((e) => ({ ...e, serial: d.serial, docName: d.name })))
    .sort((a, b) => a.at.localeCompare(b.at))
    .slice(-200);

  // --- All Documents: whole-batch buckets, filter + search, selection ---
  const allDocs = docs;
  const bucketCounts: Record<DocFilter, number> = {
    all: allDocs.length,
    confirmed: allDocs.filter((d) => docBucket(d) === "confirmed").length,
    requested: allDocs.filter((d) => docBucket(d) === "requested").length,
    failed: allDocs.filter((d) => docBucket(d) === "failed").length,
  };
  const remainingCount = allDocs.filter((d) => docBucket(d) === "pending").length;
  const visibleDocs = allDocs.filter((d) => (docFilter === "all" || docBucket(d) === docFilter) && docMatchesSearch(d, docSearch));
  const selectedDocs = allDocs.filter((d) => selected.has(d.id));
  const selectedDownloadable = selectedDocs.filter(docHasAnyPdf);
  const selectedRequested = selectedDocs.filter((d) => isUnconfirmed(d));
  const allVisibleSelected = visibleDocs.length > 0 && visibleDocs.every((d) => selected.has(d.id));

  function toggleDoc(id: string) {
    setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }
  function toggleAllVisible() {
    setSelected((s) => {
      const everyOn = visibleDocs.length > 0 && visibleDocs.every((d) => s.has(d.id));
      const n = new Set(s);
      if (everyOn) visibleDocs.forEach((d) => n.delete(d.id));
      else visibleDocs.forEach((d) => n.add(d.id));
      return n;
    });
  }

  // Bulk "Verify & Confirm": re-check each selected REQUESTED booking against the
  // live Damco portal, one at a time (sequential). Reuses the per-doc verified
  // flow — only a booking the portal reports CONFIRMED is flipped; nothing is
  // submitted/acknowledged on the portal. Tallies the real outcomes afterwards.
  function bulkVerifyConfirm() {
    const targets = selectedRequested;
    if (targets.length === 0) return;
    if (typeof window !== "undefined" && !window.confirm(`Verify ${targets.length} selected booking(s) against the LIVE Damco portal, one at a time?\n\nEach is re-checked; only those the portal itself reports CONFIRMED are marked confirmed and get an edited PDF. Nothing is submitted or acknowledged on the portal.`)) return;
    setBulkConfirm({ running: true, done: 0, total: targets.length, confirmed: 0, stillRequested: 0, failed: 0 });
    startBulk(async () => {
      for (const d of targets) {
        const fd = new FormData();
        fd.set("docId", d.id);
        fd.set("batchId", batchId);
        try { await confirmBookingPdfAction(fd); } catch { /* keep going; tallied from fresh state */ }
        setBulkConfirm((p) => (p ? { ...p, done: p.done + 1 } : p));
      }
      let confirmed = 0, still = 0, failed = 0;
      try {
        const r = await fetch(`/api/booking/${batchId}/status`, { cache: "no-store" });
        if (r.ok) {
          const fresh = (await r.json()) as StatusPayload;
          const byId = new Map(fresh.docs.map((x) => [x.id, x]));
          for (const t of targets) {
            const nd = byId.get(t.id);
            if (!nd) continue;
            if (nd.state === "COMPLETED") confirmed++;
            else if (isUnconfirmed(nd)) still++;
            else failed++;
          }
          setData(fresh);
        }
      } catch { /* ignore — counts stay 0 */ }
      setBulkConfirm({ running: false, done: targets.length, total: targets.length, confirmed, stillRequested: still, failed });
      setSelected(new Set());
      restart();
    });
  }

  return (
    <div className="space-y-4">
      {/* Live Process Summary — whole-batch counters, update as documents finish. */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        <SummaryCard label="Total" value={bucketCounts.all} tone="slate" />
        <SummaryCard label="Confirmed" value={bucketCounts.confirmed} tone="emerald" />
        <SummaryCard label="Requested" value={bucketCounts.requested} tone="amber" />
        <SummaryCard label="Failed" value={bucketCounts.failed} tone="rose" />
        <SummaryCard label="Remaining" value={remainingCount} tone="sky" />
      </div>

      {/* The one unified batch progress bar + summary counts + centralized log. */}
      <div className="card p-5">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-slate-800">{isScoped ? `Processing ${total} selected row${total === 1 ? "" : "s"}` : "Batch progress"}</h3>
          <div className="flex items-center gap-2 text-xs">
            {canRetry && failedDocs.length > 0 ? (
              <button onClick={retryAllFailed} disabled={retrying} className="btn-ghost btn-xs">
                {retrying ? "Retrying…" : `↻ Retry all failed (${failedDocs.length})`}
              </button>
            ) : null}
            {canRetry ? <StopProcessButton scope="booking" id={batchId} running={data.running} onStopped={restart} /> : null}
            {data.running ? <span className="inline-flex items-center gap-1 text-slate-500"><span className="spinner h-3 w-3" /> live</span> : data.stopped ? <span className="text-rose-600">stopped</span> : <span className="text-slate-400">done</span>}
          </div>
        </div>
        <div className="mb-2 h-2.5 w-full overflow-hidden rounded-full bg-slate-100">
          <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${pct}%` }} />
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          <span className="font-semibold text-slate-700">{total} {isScoped ? "selected" : "uploaded"}</span>
          <span className="text-emerald-700">{confirmed} confirmed</span>
          <span className="text-amber-700">{requested} requested</span>
          <span className="text-rose-700">{failed} failed</span>
          <span className="ml-auto text-slate-500">{doneCount}/{total} processed · {pct}%</span>
        </div>
        {currentDoc ? (
          <div className="mt-2 text-xs text-slate-500">
            Current: <span className="font-medium text-slate-700">#{currentDoc.serial} {currentDoc.name}</span>
            {currentDoc.liveStep ? <span> · {currentDoc.liveStep}</span> : null}
          </div>
        ) : null}
        {data.liveMessage ? (
          <div className={`mt-3 rounded-lg border px-3 py-2 text-xs ${data.liveStatus === "blocked" ? "border-amber-200 bg-amber-50 text-amber-800" : data.liveStatus === "failed" ? "border-rose-200 bg-rose-50 text-rose-700" : "border-ananta-100 bg-ananta-50 text-ananta-800"}`}>
            <strong>Automation:</strong> {data.liveStatus ?? data.status} · {data.liveMessage}
          </div>
        ) : null}
        <div className="mt-3 border-t border-slate-100 pt-2">
          <button onClick={() => setShowLog((v) => !v)} className="text-xs text-slate-400 hover:text-slate-600">
            {showLog ? "Hide processing log" : `Show processing log (${combinedLog.length})`}
          </button>
          {showLog ? (
            <div className="mt-2 max-h-64 space-y-1 overflow-y-auto rounded-lg border border-slate-100 bg-slate-50/60 p-3 text-[11px]">
              {combinedLog.length === 0 ? <div className="text-slate-400">No events yet.</div> : combinedLog.map((e, i) => (
                <div key={i} className="flex gap-2">
                  <span className="shrink-0 text-slate-400">{e.at.slice(11, 19)}</span>
                  <span className="shrink-0 font-mono text-slate-400">#{e.serial}</span>
                  <span className={`shrink-0 font-medium ${e.status === "failed" ? "text-rose-600" : e.status === "ok" ? "text-emerald-600" : "text-slate-500"}`}>{e.step}</span>
                  <span className="text-slate-600">{e.message}</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      {err ? <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">Progress poll error: {err}</div> : null}

      {/* Items that still need a human: review / retry / confirm — no per-PDF bar. */}
      {attention.length > 0 ? (
        <div className="card p-5">
          <h3 className="mb-3 text-sm font-semibold text-slate-800">Needs attention ({attention.length})</h3>
          <div className="space-y-3">
            {attention.map((doc) => (
              <AttentionItem key={doc.id} doc={doc} batchId={batchId} canExport={canExport} canRetry={canRetry} canReview={canReview} canConfirm={canConfirm} onChanged={restart} />
            ))}
          </div>
        </div>
      ) : null}

      {/* All documents — filter, search, select, bulk download / verify-confirm. */}
      <div className="card p-5">
        <button onClick={() => setShowAll((v) => !v)} className="flex w-full items-center justify-between text-sm font-semibold text-slate-800">
          <span>All documents ({docs.length})</span>
          <span className="text-xs font-normal text-slate-400">{showAll ? "Hide" : "Show"}</span>
        </button>
        {showAll ? (
          <div className="mt-3 space-y-3">
            {/* Filter chips + search */}
            <div className="flex flex-wrap items-center gap-2">
              {(["all", "confirmed", "requested", "failed"] as DocFilter[]).map((key) => {
                const label = key === "all" ? "All" : key.charAt(0).toUpperCase() + key.slice(1);
                return (
                  <button
                    key={key}
                    onClick={() => setDocFilter(key)}
                    className={`rounded-full border px-3 py-1 text-[11px] font-semibold ${docFilter === key ? "border-ananta-300 bg-ananta-50 text-ananta-700" : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50"}`}
                  >
                    {label} ({bucketCounts[key]})
                  </button>
                );
              })}
              <input
                value={docSearch}
                onChange={(e) => setDocSearch(e.target.value)}
                placeholder="Search PO, SKU, FR, booking, file…"
                className="ml-auto w-64 max-w-full rounded border border-slate-300 px-2 py-1 text-xs"
              />
              <span className="text-[11px] text-slate-400">{visibleDocs.length} shown</span>
            </div>

            {/* Bulk action bar */}
            <div className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-200 bg-slate-50/60 px-3 py-2">
              <span className="text-[11px] font-semibold text-slate-500">{selected.size} selected</span>
              {canExport && selectedDownloadable.length > 0 ? (
                <a href={`/api/booking/${batchId}/zip?docIds=${selectedDownloadable.map((d) => d.id).join(",")}`} className="btn-ghost btn-xs" title="Download the selected documents' PDFs as one ZIP, each named PO_Country_FR.">
                  ⬇ Download selected ({selectedDownloadable.length}) ZIP
                </a>
              ) : null}
              {canConfirm && selectedRequested.length > 0 ? (
                <button onClick={bulkVerifyConfirm} disabled={!!bulkConfirm?.running} className="btn-ghost btn-xs text-emerald-700 disabled:opacity-40" title="Re-verify each selected Requested booking against the live Damco portal; only portal-confirmed bookings are marked confirmed.">
                  {bulkConfirm?.running ? `Verifying ${bulkConfirm.done}/${bulkConfirm.total}…` : `✓ Verify & Confirm selected (${selectedRequested.length})`}
                </button>
              ) : null}
              {selected.size > 0 ? <button onClick={() => setSelected(new Set())} className="text-[11px] text-slate-400 hover:text-slate-600">Clear</button> : null}
              {bulkConfirm && !bulkConfirm.running ? (
                <span className="text-[11px] text-slate-500">
                  Verified: <span className="text-emerald-600">{bulkConfirm.confirmed} confirmed</span> · <span className="text-amber-600">{bulkConfirm.stillRequested} still requested</span> · <span className="text-rose-600">{bulkConfirm.failed} failed</span>
                </span>
              ) : null}
              {selected.size === 0 ? <span className="text-[11px] text-slate-400">Tick rows to download or verify-confirm in bulk.</span> : null}
            </div>

            <div className="overflow-x-auto">
              <table className="w-full whitespace-nowrap text-xs">
                <thead className="bg-slate-50 text-slate-500">
                  <tr>
                    <th className="px-2 py-1.5"><input type="checkbox" checked={allVisibleSelected} onChange={toggleAllVisible} aria-label="Select all shown" /></th>
                    <th className="px-3 py-1.5 text-left font-semibold">SL</th>
                    <th className="px-3 py-1.5 text-left font-semibold">Row / File</th>
                    <th className="px-3 py-1.5 text-left font-semibold">Status</th>
                    <th className="px-3 py-1.5 text-left font-semibold">PO · SKU</th>
                    <th className="px-3 py-1.5 text-left font-semibold">Shipper</th>
                    <th className="px-3 py-1.5 text-left font-semibold">FR</th>
                    <th className="px-3 py-1.5 text-left font-semibold">Booking</th>
                    <th className="px-3 py-1.5 text-left font-semibold">GW in / bk</th>
                    <th className="px-3 py-1.5 text-left font-semibold">Ctn in / bk</th>
                    <th className="px-3 py-1.5 text-left font-semibold">Qty in / bk</th>
                    <th className="px-3 py-1.5 text-left font-semibold">Files</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleDocs.length === 0 ? (
                    <tr><td className="px-3 py-3 text-center text-slate-400" colSpan={12}>No documents match this filter{docSearch.trim() ? ` or “${docSearch.trim()}”` : ""}.</td></tr>
                  ) : null}
                  {visibleDocs.map((d) => (
                    <tr key={d.id} className="border-t border-slate-100">
                      <td className="px-2 py-1.5"><input type="checkbox" checked={selected.has(d.id)} onChange={() => toggleDoc(d.id)} aria-label={`Select ${d.name}`} /></td>
                      <td className="px-3 py-1.5 text-slate-500">{d.serial}</td>
                      <td className="px-3 py-1.5 max-w-[180px] truncate" title={d.name}>{d.name}</td>
                      <td className="px-3 py-1.5"><span className={`badge ${stateTone(d.state)}`}>{stateLabel(d.state)}</span></td>
                      <td className="px-3 py-1.5 font-mono">{d.poNumber || "—"} <span className="text-slate-400">{d.countryCode}</span></td>
                      <td className="px-3 py-1.5 max-w-[160px] truncate" title={d.shipper || ""}>{d.shipper || "—"}</td>
                      <td className="px-3 py-1.5 font-mono">{d.frCode || "—"}</td>
                      <td className="px-3 py-1.5 font-mono">{d.bookingRef || "—"}</td>
                      <td className="px-3 py-1.5">{d.extracted.grossWeight || "—"} / {d.booking.grossWeight || "—"}</td>
                      <td className="px-3 py-1.5">{d.extracted.cartons || "—"} / {d.booking.cartons || "—"}</td>
                      <td className="px-3 py-1.5">{d.extracted.quantity || "—"} / {d.booking.quantity || "—"}</td>
                      <td className="px-3 py-1.5"><DownloadLinks doc={d} canExport={canExport} canReview={canReview} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
