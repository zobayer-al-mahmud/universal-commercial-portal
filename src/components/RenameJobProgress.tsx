"use client";

/**
 * PDF File Rename — one unified batch progress indicator + review workbench.
 * Polls /api/pdf-rename/job/[jobId]/status and shows a single overall bar (no
 * per-file bars), live counts + log, a "Needs review" section with evidence and
 * manual correction, a searchable all-files table, and a report download.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { retryRenameItemAction, correctRenameItemAction, resumeRenameJobAction } from "@/app/actions/pdf-rename-folders";

interface Candidate { value: string; label: string; page: number; method: string; confidence: number; evidence: string }
interface JobItem {
  id: string; serial: number; originalName: string; state: string; docType: string;
  invoiceNumber: string; countryToken: string | null; newName: string | null;
  source: string; method: string; confidence: number; pages: number;
  reviewReason: string; reasonText: string; candidates: Candidate[]; correctedBy: string | null; hasOutput: boolean;
  events: { stage: string; status: string; message: string; at: string }[];
}
interface StatusPayload {
  jobId: string; folder: string; status: string; running: boolean; currentActivity: string;
  minConfidence: number; ocrEnabled: boolean; startedAt: string | null;
  totals: { total: number; processed: number; renamed: number; review: number; failed: number; remaining: number };
  items: JobItem[];
}

const REVIEW_STATES = new Set(["REVIEW_REQUIRED", "FAILED"]);

function stateTone(s: string): string {
  if (s === "RENAMED") return "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-600/15";
  if (s === "REVIEW_REQUIRED") return "bg-amber-50 text-amber-700 ring-1 ring-amber-600/20";
  if (s === "FAILED") return "bg-rose-50 text-rose-700 ring-1 ring-rose-600/15";
  if (s === "PROCESSING") return "bg-sky-50 text-sky-700 ring-1 ring-sky-600/15";
  return "bg-slate-100 text-slate-600";
}

function ReviewItem({ item, onChanged }: { item: JobItem; onChanged: () => void }) {
  const [pending, start] = useTransition();
  const [value, setValue] = useState(item.invoiceNumber || item.candidates[0]?.value || "");
  const [msg, setMsg] = useState<string | null>(null);

  const retry = () => start(async () => { const fd = new FormData(); fd.set("itemId", item.id); await retryRenameItemAction(fd); setTimeout(onChanged, 700); });
  const correct = () => start(async () => {
    const fd = new FormData(); fd.set("itemId", item.id); fd.set("invoiceNumber", value);
    const res = await correctRenameItemAction(fd);
    setMsg(res.message);
    if (res.ok) setTimeout(onChanged, 700);
  });

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-slate-400">#{item.serial}</span>
            <span className="truncate font-mono text-sm text-slate-800">{item.originalName}</span>
          </div>
          <div className="mt-1 text-xs text-slate-500">{item.docType} · {item.pages} page(s){item.source ? ` · via ${item.source}` : ""}</div>
        </div>
        <span className={`badge ${stateTone(item.state)}`}>{item.reviewReason || item.state}</span>
      </div>

      <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">{item.reasonText || "Needs review."}</div>

      {item.candidates.length > 0 ? (
        <div className="mt-2 overflow-x-auto rounded-lg border border-slate-200">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-slate-500"><tr>
              <th className="px-2 py-1 text-left font-semibold">Candidate</th><th className="px-2 py-1 text-left font-semibold">Label</th>
              <th className="px-2 py-1 text-left font-semibold">Pg</th><th className="px-2 py-1 text-left font-semibold">Via</th>
              <th className="px-2 py-1 text-left font-semibold">Conf</th><th className="px-2 py-1 text-left font-semibold">Evidence</th>
            </tr></thead>
            <tbody>
              {item.candidates.map((c, i) => (
                <tr key={i} className="border-t border-slate-100">
                  <td className="px-2 py-1 font-mono">{c.value}</td><td className="px-2 py-1">{c.label}</td>
                  <td className="px-2 py-1">{c.page}</td><td className="px-2 py-1">{c.method}</td>
                  <td className="px-2 py-1">{Math.round(c.confidence * 100)}%</td>
                  <td className="px-2 py-1 max-w-[18rem] truncate text-slate-500" title={c.evidence}>{c.evidence}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="Correct invoice number" className="w-48 rounded border border-slate-300 px-2 py-1 text-xs font-mono" />
        <button onClick={correct} disabled={pending || !value.trim()} className="btn-primary text-xs disabled:opacity-40">{pending ? "…" : "✓ Rename with this"}</button>
        <button onClick={retry} disabled={pending} className="btn-ghost text-xs">↻ Retry extraction</button>
        {msg ? <span className="text-xs text-slate-600">{msg}</span> : null}
      </div>
    </div>
  );
}

export function RenameJobProgress({ jobId, onDone }: { jobId: string; onDone?: () => void }) {
  const [data, setData] = useState<StatusPayload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<string>("all");
  const [showLog, setShowLog] = useState(false);
  const [resuming, startResume] = useTransition();
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stop = useCallback(() => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } }, []);
  const poll = useCallback(async () => {
    try {
      const r = await fetch(`/api/pdf-rename/job/${jobId}/status`, { cache: "no-store" });
      if (!r.ok) { setErr(`Status ${r.status}`); return; }
      const p = (await r.json()) as StatusPayload;
      setData(p); setErr(null);
      if (!p.running) { stop(); onDone?.(); }
    } catch (e) { setErr(e instanceof Error ? e.message : "poll failed"); }
  }, [jobId, stop, onDone]);

  useEffect(() => {
    void poll();
    pollRef.current = setInterval(() => void poll(), 1500);
    return () => stop();
  }, [poll, stop]);

  const restart = useCallback(() => { if (!pollRef.current) pollRef.current = setInterval(() => void poll(), 1500); void poll(); }, [poll]);

  if (!data) return <div className="card flex items-center gap-3 p-5 text-sm text-slate-500"><span className="spinner" /> Loading job…</div>;

  const t = data.totals;
  const pct = t.total > 0 ? Math.round((t.processed / t.total) * 100) : 0;
  const review = data.items.filter((i) => REVIEW_STATES.has(i.state));
  const log = data.items.flatMap((i) => i.events.map((e) => ({ ...e, serial: i.serial }))).sort((a, b) => a.at.localeCompare(b.at)).slice(-200);
  const items = data.items;
  const filtered = items.filter((i) => {
    if (filter !== "all" && i.state !== filter) return false;
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return `${i.originalName} ${i.invoiceNumber} ${i.newName ?? ""}`.toLowerCase().includes(q);
  });
  const resumeJob = () => startResume(async () => { const fd = new FormData(); fd.set("jobId", jobId); await resumeRenameJobAction(fd); restart(); });

  return (
    <div className="space-y-4">
      <div className="card p-5">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-slate-800">Batch progress — {data.folder}</h3>
          <div className="flex items-center gap-2 text-xs">
            {!data.running && (t.failed > 0 || t.review > 0) ? <button onClick={resumeJob} disabled={resuming} className="btn-ghost btn-xs">{resuming ? "…" : "↻ Resume / retry"}</button> : null}
            <a href={`/api/pdf-rename/job/${jobId}/report`} className="btn-ghost btn-xs">⬇ Report (CSV)</a>
            {data.running ? <span className="inline-flex items-center gap-1 text-slate-500"><span className="spinner h-3 w-3" /> live</span> : <span className="text-slate-400">done</span>}
          </div>
        </div>
        <div className="mb-2 h-2.5 w-full overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${pct}%` }} /></div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          <span className="font-semibold text-slate-700">{t.total} total</span>
          <span className="text-emerald-700">{t.renamed} renamed</span>
          <span className="text-amber-700">{t.review} review</span>
          <span className="text-rose-700">{t.failed} failed</span>
          <span className="text-slate-500">{t.remaining} remaining</span>
          <span className="ml-auto text-slate-500">{t.processed}/{t.total} · {pct}%</span>
        </div>
        {data.running ? <div className="mt-2 text-xs text-slate-500">{data.currentActivity}</div> : null}
        <div className="mt-3 border-t border-slate-100 pt-2">
          <button onClick={() => setShowLog((v) => !v)} className="text-xs text-slate-400 hover:text-slate-600">{showLog ? "Hide log" : `Show log (${log.length})`}</button>
          {showLog ? (
            <div className="mt-2 max-h-64 space-y-1 overflow-y-auto rounded-lg border border-slate-100 bg-slate-50/60 p-3 text-[11px]">
              {log.length === 0 ? <div className="text-slate-400">No events yet.</div> : log.map((e, i) => (
                <div key={i} className="flex gap-2">
                  <span className="shrink-0 text-slate-400">{e.at.slice(11, 19)}</span>
                  <span className="shrink-0 font-mono text-slate-400">#{e.serial}</span>
                  <span className={`shrink-0 font-medium ${e.status === "failed" ? "text-rose-600" : e.status === "ok" ? "text-emerald-600" : "text-slate-500"}`}>{e.stage}</span>
                  <span className="text-slate-600">{e.message}</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      {err ? <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">Poll error: {err}</div> : null}

      {review.length > 0 ? (
        <div className="card p-5">
          <h3 className="mb-3 text-sm font-semibold text-slate-800">Needs review ({review.length})</h3>
          <div className="space-y-3">{review.map((it) => <ReviewItem key={it.id} item={it} onChanged={restart} />)}</div>
        </div>
      ) : null}

      <div className="card p-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-slate-800">All files ({items.length})</h3>
          <div className="flex items-center gap-2">
            <select value={filter} onChange={(e) => setFilter(e.target.value)} className="rounded border border-slate-200 px-2 py-1 text-xs">
              <option value="all">All states</option><option value="RENAMED">Renamed</option><option value="REVIEW_REQUIRED">Review</option><option value="FAILED">Failed</option><option value="PENDING">Pending</option>
            </select>
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search…" className="w-48 rounded border border-slate-200 px-2 py-1 text-xs" />
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full whitespace-nowrap text-xs">
            <thead className="bg-slate-50 text-slate-500"><tr>
              <th className="px-3 py-1.5 text-left font-semibold">#</th><th className="px-3 py-1.5 text-left font-semibold">Original</th>
              <th className="px-3 py-1.5 text-left font-semibold">Invoice</th><th className="px-3 py-1.5 text-left font-semibold">New name</th>
              <th className="px-3 py-1.5 text-left font-semibold">Via</th><th className="px-3 py-1.5 text-left font-semibold">Conf</th>
              <th className="px-3 py-1.5 text-left font-semibold">State</th><th className="px-3 py-1.5 text-left font-semibold">Notes</th>
            </tr></thead>
            <tbody>
              {filtered.map((it) => (
                <tr key={it.id} className="border-t border-slate-100">
                  <td className="px-3 py-1.5 text-slate-400">{it.serial}</td>
                  <td className="px-3 py-1.5 font-mono max-w-[200px] truncate" title={it.originalName}>{it.originalName}</td>
                  <td className="px-3 py-1.5 font-mono">{it.invoiceNumber || "—"}</td>
                  <td className="px-3 py-1.5 font-mono">{it.newName || "—"}</td>
                  <td className="px-3 py-1.5">{it.source || "—"}</td>
                  <td className="px-3 py-1.5">{it.confidence ? `${Math.round(it.confidence * 100)}%` : "—"}</td>
                  <td className="px-3 py-1.5"><span className={`badge ${stateTone(it.state)}`}>{it.state}</span></td>
                  <td className="px-3 py-1.5 max-w-[22rem] truncate text-slate-500" title={it.reasonText}>{it.reviewReason ? `${it.reviewReason}: ` : ""}{it.reasonText}</td>
                </tr>
              ))}
              {filtered.length === 0 ? <tr><td className="px-3 py-3 text-slate-400" colSpan={8}>No files match.</td></tr> : null}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
