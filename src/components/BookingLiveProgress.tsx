"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { BOOKING_STEPS, type StepPhase } from "@/server/booking-correction/progress";
import { retryBookingDocAction } from "@/app/actions/booking-batch";

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
  bookingRef: string;
  finalStatus: string;
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
  totals: { total: number; completed: number; review: number; failed: number };
  docs: DocStatus[];
}

const TERMINAL_ERROR = new Set(["MISMATCH", "STATUS_MISMATCH", "SEARCH_FAILED", "DOWNLOAD_FAILED", "FAILED", "NEEDS_REVIEW", "PORTAL_AUTH_REQUIRED"]);

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

function StepDot({ phase, index }: { phase: StepPhase; index: number }) {
  if (phase === "done") {
    return <span className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500 text-[11px] text-white">✓</span>;
  }
  if (phase === "error") {
    return <span className="flex h-5 w-5 items-center justify-center rounded-full bg-rose-500 text-[11px] text-white">✕</span>;
  }
  if (phase === "running") {
    return <span className="flex h-5 w-5 items-center justify-center rounded-full bg-sky-500 text-[11px] text-white"><span className="h-2 w-2 animate-ping rounded-full bg-white" /></span>;
  }
  return <span className="flex h-5 w-5 items-center justify-center rounded-full bg-slate-200 text-[11px] text-slate-500">{index + 1}</span>;
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

function DocCard({ doc, batchId, canExport, canRetry, onRetried }: { doc: DocStatus; batchId: string; canExport: boolean; canRetry: boolean; onRetried: () => void }) {
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const isError = doc.stage.phase === "error";
  const isDone = doc.stage.phase === "done";

  function retry() {
    const fd = new FormData();
    fd.set("docId", doc.id);
    fd.set("batchId", batchId);
    startTransition(async () => {
      await retryBookingDocAction(fd);
      setTimeout(onRetried, 700);
    });
  }

  return (
    <div className="card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-slate-400">#{doc.serial}</span>
            <span className="truncate text-sm font-semibold text-slate-800">{doc.name}</span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
            {doc.poNumber ? <span>PO <span className="font-mono text-slate-700">{doc.poNumber}</span></span> : null}
            {doc.countryCode ? <span>SKU <span className="font-mono text-slate-700">{doc.countryCode}</span></span> : null}
            {doc.bookingRef ? <span>Booking <span className="font-mono text-slate-700">{doc.bookingRef}</span></span> : null}
          </div>
        </div>
        <span className={`badge ${stateTone(doc.state)}`}>{stateLabel(doc.state)}</span>
      </div>

      {/* 10-stage indicator */}
      <ol className="mt-4 grid gap-1.5 sm:grid-cols-2">
        {BOOKING_STEPS.map((step, i) => {
          const phase = doc.stage?.steps?.[i] ?? "pending";
          return (
            <li key={step} className="flex items-center gap-2 text-sm">
              <StepDot phase={phase} index={i} />
              <span className={phase === "pending" ? "text-slate-400" : phase === "error" ? "font-medium text-rose-700" : "text-slate-700"}>{step}</span>
            </li>
          );
        })}
      </ol>

      {/* Error / warning */}
      {isError && (doc.error || doc.warning) ? (
        <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">{doc.error || doc.warning}</div>
      ) : null}
      {!isError && doc.warning ? (
        <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">{doc.warning}</div>
      ) : null}

      {/* Value comparison */}
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

      {/* Actions */}
      <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
        {doc.hasPortalPdf && canExport ? (
          <>
            <a href={`/api/booking/doc/${doc.id}/portal`} target="_blank" rel="noreferrer" className="font-medium text-ananta hover:underline">👁 Preview Damco PDF</a>
            <a href={`/api/booking/doc/${doc.id}/portal?download=1`} className="font-medium text-ananta hover:underline">⬇ Download</a>
          </>
        ) : null}
        {doc.hasGeneratedPdf && canExport ? (
          <a href={`/api/booking/doc/${doc.id}/generated`} target="_blank" rel="noreferrer" className="text-slate-500 hover:underline">UCP summary PDF</a>
        ) : null}
        {doc.hasOriginal && canExport ? (
          <a href={`/api/booking/doc/${doc.id}/original`} target="_blank" rel="noreferrer" className="text-slate-500 hover:underline">Original upload</a>
        ) : null}
        {canRetry && (isError || isDone) ? (
          <button onClick={retry} disabled={pending} className="btn-ghost btn-xs ml-auto">
            {pending ? "Retrying…" : "↻ Retry"}
          </button>
        ) : null}
        <button onClick={() => setOpen((o) => !o)} className="text-slate-400 hover:text-slate-600">
          {open ? "Hide log" : "Show log"}
        </button>
      </div>

      {open ? (
        <div className="mt-3 max-h-56 space-y-1 overflow-y-auto rounded-lg border border-slate-100 bg-slate-50/60 p-3 text-[11px]">
          {(doc.events?.length ?? 0) === 0 ? <div className="text-slate-400">No events yet.</div> : (doc.events ?? []).map((e, i) => (
            <div key={i} className="flex gap-2">
              <span className="shrink-0 text-slate-400">{e.at.slice(11, 19)}</span>
              <span className={`shrink-0 font-medium ${e.status === "failed" ? "text-rose-600" : e.status === "ok" ? "text-emerald-600" : "text-slate-500"}`}>{e.step}</span>
              <span className="text-slate-600">{e.message}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function BookingLiveProgress({
  batchId,
  canExport,
  canRetry,
  initialRunning,
}: {
  batchId: string;
  canExport: boolean;
  canRetry: boolean;
  initialRunning: boolean;
}) {
  const [data, setData] = useState<StatusPayload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

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
      if (!payload.running) stop();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "poll failed");
    }
  }, [batchId, stop]);

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

  if (!data) {
    return (
      <div className="card flex items-center gap-3 p-5 text-sm text-slate-500">
        <span className="spinner" /> Loading live progress…
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {data.liveMessage ? (
        <div className={`rounded-lg border px-3 py-2 text-xs ${data.liveStatus === "blocked" ? "border-amber-200 bg-amber-50 text-amber-800" : data.liveStatus === "failed" ? "border-rose-200 bg-rose-50 text-rose-700" : "border-ananta-100 bg-ananta-50 text-ananta-800"}`}>
          <strong>Automation:</strong> {data.liveStatus ?? data.status} · {data.liveMessage}
          {data.running ? <span className="ml-2 inline-flex items-center gap-1 text-slate-500"><span className="spinner h-3 w-3" /> live</span> : null}
        </div>
      ) : null}
      {err ? <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">Progress poll error: {err}</div> : null}

      <div className="grid gap-4">
        {data.docs.map((doc) => (
          <DocCard key={doc.id} doc={doc} batchId={batchId} canExport={canExport} canRetry={canRetry} onRetried={restart} />
        ))}
      </div>
    </div>
  );
}
