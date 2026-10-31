"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { startContainerBatchAction, retryContainerAction } from "@/app/actions/container";
import { StopProcessButton } from "@/components/StopProcessButton";

export interface RecentSearch {
  id: string;
  containerNo: string;
  portalContainerNo: string | null;
  positionLocation: string | null;
  shipmentRef: string | null;
  status: string;
  hasPdf: boolean;
  createdAt: string;
}

interface BatchContainer {
  id: string;
  containerNo: string;
  status: string;
  step: string;
  location: string | null;
  hasPdf: boolean;
  pdfPages: number;
  error: string;
}

interface BatchStatus {
  batchId: string;
  total: number;
  running: boolean;
  stopped?: boolean;
  counts: { total: number; done: number; verified: number; failed: number; running: number; queued: number; stopped?: number };
  containers: BatchContainer[];
}

const TERMINAL = new Set(["completed", "not_found", "mismatch", "failed", "needs_auth"]);

function statusTone(status: string): string {
  if (status === "completed") return "bg-green-50 text-green-700 border-green-200";
  if (status === "running") return "bg-sky-50 text-sky-700 border-sky-200";
  if (status === "queued") return "bg-slate-50 text-slate-500 border-slate-200";
  if (status === "needs_auth" || status === "not_found" || status === "mismatch") return "bg-amber-50 text-amber-700 border-amber-200";
  return "bg-rose-50 text-rose-700 border-rose-200";
}

export function ContainerSearchManager({
  recent,
  liveEnabled,
  authConfigured,
}: {
  recent: RecentSearch[];
  liveEnabled: boolean;
  authConfigured: boolean;
}) {
  const [text, setText] = useState("");
  const [force, setForce] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [batch, setBatch] = useState<BatchStatus | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }, []);

  const poll = useCallback(async (id: string) => {
    try {
      const r = await fetch(`/api/container/batch/${id}/status`, { cache: "no-store" });
      if (!r.ok) return;
      const data = (await r.json()) as BatchStatus;
      setBatch(data);
      if (!data.running) stopPolling();
    } catch { /* keep polling */ }
  }, [stopPolling]);

  const startPolling = useCallback((id: string) => {
    stopPolling();
    void poll(id);
    pollRef.current = setInterval(() => void poll(id), 1500);
  }, [poll, stopPolling]);

  useEffect(() => () => stopPolling(), [stopPolling]);

  function begin(id: string, msg: string | null) {
    setBatchId(id);
    setBatch(null);
    setNotice(msg);
    startPolling(id);
  }

  function onSubmitText(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    if (!text.trim()) { setError("Enter one or more container numbers (one per line)."); return; }
    startTransition(async () => {
      const res = await startContainerBatchAction(text, force);
      if ("error" in res && res.error) { setError(res.error); return; }
      if (!("error" in res)) {
        const parts = [`${res.created} container(s) queued`];
        if (res.invalid.length) parts.push(`${res.invalid.length} invalid skipped`);
        if (res.duplicates.length) parts.push(`${res.duplicates.length} duplicate(s) removed`);
        begin(res.batchId, parts.join(" · "));
      }
    });
  }

  async function onUpload() {
    setError(null);
    setNotice(null);
    const f = fileRef.current?.files?.[0];
    if (!f) { setError("Choose an .xlsx file of container numbers."); return; }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", f);
      if (force) fd.append("force", "1");
      const r = await fetch("/api/container/batch/upload", { method: "POST", body: fd });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError(j.error || `Import failed (${r.status}).`); return; }
      if (fileRef.current) fileRef.current.value = "";
      const parts = [`${j.created} container(s) queued`];
      if (j.invalid?.length) parts.push(`${j.invalid.length} invalid skipped`);
      if (j.duplicates?.length) parts.push(`${j.duplicates.length} duplicate(s) removed`);
      begin(j.batchId, parts.join(" · "));
    } finally {
      setUploading(false);
    }
  }

  function retry(rowId: string) {
    startTransition(async () => {
      await retryContainerAction(rowId);
      if (batchId) startPolling(batchId);
    });
  }

  const counts = batch?.counts;
  const pct = counts && counts.total > 0 ? Math.round((counts.done / counts.total) * 100) : 0;

  return (
    <div className="space-y-6">
      {!liveEnabled ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          Live automation is <strong>off</strong>. Set <code>CONTAINER_LIVE_ENABLED=true</code> in <code>.env</code> (and, for sign-in,
          <code> CTG_PORT_USERNAME</code> / <code>CTG_PORT_PASSWORD</code>) to run real searches. No results are ever fabricated.
        </div>
      ) : (
        <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
          Live automation is <strong>on</strong>. A visible browser opens on the server and drives the CTG Port search, one container at a
          time. Sign-in is{authConfigured ? " configured" : " not configured (the container search is public, so it runs without login)"}.
          The container location is determined through the portal workflow — you no longer need to enter it.
        </div>
      )}

      <form onSubmit={onSubmitText} className="card p-5">
        <label className="block">
          <span className="mb-1 block text-xs font-semibold text-slate-600">Container numbers <span className="text-rose-500">*</span></span>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={5}
            placeholder={"One per line, e.g.\nTLLU4872965\nMSKU1234567\nMRKU7654321"}
            className="w-full rounded-md border border-slate-200 px-3 py-2 font-mono text-sm uppercase"
          />
        </label>
        <div className="mt-4 flex flex-wrap items-center gap-4">
          <button type="submit" disabled={pending || uploading} className="btn-primary text-sm disabled:opacity-40">
            {pending ? "Starting…" : "🔎 Search Containers"}
          </button>
          <span className="text-xs text-slate-400">or</span>
          <label className="flex items-center gap-2 text-xs text-slate-600">
            <span className="font-semibold">Import .xlsx:</span>
            <input ref={fileRef} type="file" accept=".xlsx" className="text-xs file:mr-2 file:rounded file:border-0 file:bg-slate-100 file:px-2 file:py-1" />
          </label>
          <button type="button" onClick={onUpload} disabled={pending || uploading} className="btn-ghost text-xs disabled:opacity-40">
            {uploading ? "Importing…" : "⇪ Import & search"}
          </button>
          <label className="ml-auto flex items-center gap-2 text-xs text-slate-500">
            <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} /> Re-run even if already verified
          </label>
        </div>
        <p className="mt-2 text-xs text-slate-400">
          Each valid container is searched on the real CTG Port portal and its verified result page is captured as a PDF. One PDF per
          matched container — nothing is fabricated. Invalid or duplicate numbers are reported and skipped.
        </p>
      </form>

      {error ? <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{error}</div> : null}
      {notice ? <div className="rounded-md border border-sky-200 bg-sky-50 p-3 text-xs text-sky-800">{notice}</div> : null}

      {batchId && batch ? (
        <div className="card p-5">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-slate-800">Bulk progress</h3>
            <div className="flex items-center gap-2 text-xs">
              {counts && counts.verified > 0 ? (
                <a href={`/api/container/batch/${batchId}/zip`} className="btn-primary btn-xs">⬇ Download All ({counts.verified}) ZIP</a>
              ) : null}
              <StopProcessButton scope="container" id={batchId} running={batch.running} pending={counts ? counts.queued + counts.running : undefined} onStopped={() => startPolling(batchId)} />
              {batch.running ? <span className="inline-flex items-center gap-1 text-slate-500"><span className="spinner h-3 w-3" /> running</span> : batch.stopped ? <span className="text-rose-600">stopped</span> : <span className="text-slate-400">done</span>}
            </div>
          </div>

          {/* Overall progress bar */}
          <div className="mb-2 h-2 w-full overflow-hidden rounded-full bg-slate-100">
            <div className="h-full rounded-full bg-sky-500 transition-all" style={{ width: `${pct}%` }} />
          </div>
          {counts ? (
            <div className="mb-4 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600">
              <span>{counts.total} total</span>
              <span className="text-emerald-700">{counts.verified} verified</span>
              <span className="text-rose-700">{counts.failed} failed</span>
              <span className="text-sky-700">{counts.running} running</span>
              <span className="text-slate-400">{counts.queued} queued</span>
            </div>
          ) : null}

          <div className="overflow-x-auto rounded-lg border border-slate-200">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-slate-500">
                <tr>
                  <th className="th text-left">Container</th>
                  <th className="th text-left">Status / step</th>
                  <th className="th text-left">Location</th>
                  <th className="th text-left">PDF</th>
                  <th className="th text-left">Action</th>
                </tr>
              </thead>
              <tbody>
                {batch.containers.map((c) => {
                  const terminalErr = TERMINAL.has(c.status) && !(c.status === "completed" && c.hasPdf);
                  return (
                    <tr key={c.id} className="border-t border-slate-100 align-top">
                      <td className="td font-mono">{c.containerNo}</td>
                      <td className="td">
                        <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold capitalize ${statusTone(c.status)}`}>{c.status.replace("_", " ")}</span>
                        {c.step && !TERMINAL.has(c.status) ? <div className="mt-0.5 text-[11px] text-slate-400">{c.step}</div> : null}
                        {terminalErr && c.error ? <div className="mt-0.5 text-[11px] text-rose-600">{c.error}</div> : null}
                      </td>
                      <td className="td text-slate-500">{c.location || "—"}</td>
                      <td className="td">
                        {c.status === "completed" && c.hasPdf ? (
                          <span className="flex gap-2">
                            <a href={`/api/container/${c.id}/pdf`} target="_blank" rel="noreferrer" className="text-sky-700 hover:underline">👁</a>
                            <a href={`/api/container/${c.id}/pdf?download=1`} className="text-sky-700 hover:underline">⬇</a>
                          </span>
                        ) : "—"}
                      </td>
                      <td className="td">
                        {terminalErr ? (
                          <button onClick={() => retry(c.id)} disabled={pending} className="text-sky-700 hover:underline disabled:text-slate-300">↻ Retry</button>
                        ) : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      <div className="card">
        <div className="border-b border-slate-100 px-4 py-3 text-sm font-semibold text-slate-700">Recent container searches</div>
        {recent.length === 0 ? (
          <div className="p-4 text-sm text-slate-400">No searches yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-50">
                <tr>
                  <th className="th">Container</th><th className="th">Location</th>
                  <th className="th">Status</th><th className="th">PDF</th><th className="th">When</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((s) => (
                  <tr key={s.id} className="border-t border-slate-50">
                    <td className="td font-mono">{s.portalContainerNo || s.containerNo}</td>
                    <td className="td text-slate-500">{s.positionLocation || "—"}</td>
                    <td className="td"><span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold capitalize ${statusTone(s.status)}`}>{s.status.replace("_", " ")}</span></td>
                    <td className="td">{s.hasPdf ? <a href={`/api/container/${s.id}/pdf?download=1`} className="text-sky-700 hover:underline">⬇</a> : "—"}</td>
                    <td className="td text-slate-400">{s.createdAt}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
