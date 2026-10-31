"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useCallback, useEffect, useRef, useState, useTransition } from "react";
import { processExpRowsAction, retryExpRowAction, updateExpRowAction } from "@/app/actions/exp";
import { fieldsForKind } from "@/server/exp-automation/types";
import { StopProcessButton } from "@/components/StopProcessButton";

export type ExpKind = "correction" | "duplicate" | "download";

export interface ExpRecentJob {
  id: string;
  kind: string;
  sourceName: string;
  total: number;
  matched: number;
  changed: number;
  partial: number;
  downloaded: number;
  failed: number;
  status: string;
  hasFile: boolean;
  createdAt: string;
}

interface RowView {
  id: string;
  rowNo: number;
  adscode: string;
  expSerial: string;
  expYear: string;
  expNo: string;
  invoiceNo: string;
  saveAs: string;
  status: string;
  step: string;
  error: string;
  retryCount: number;
  hasPdf: boolean;
  pdfPages: number;
  mismatched: { portalLabel: string; excel: string; portal: string }[];
  notes: string[];
  values: Record<string, string>;
  lastEvent: { step: string; status: string; message: string; at: string } | null;
}

interface JobStatus {
  id: string;
  kind: ExpKind;
  sheetName: string;
  sourceName: string;
  status: string;
  running: boolean;
  hasFile?: boolean;
  fileBytes?: number;
  counts: { total: number; processed: number; matched: number; changed: number; partial: number; downloaded: number; skipped: number; failed: number; remaining: number };
  events: { rowNo: number; step: string; status: string; message: string; at: string }[];
  rows: RowView[];
}

const TABS: { kind: ExpKind; label: string; blurb: string }[] = [
  { kind: "correction", label: "Issued EXP Correction", blurb: "Search each record and fill the Edit/Update EXP form from your Excel row. The form is never submitted — you review and submit it yourself." },
  { kind: "duplicate", label: "Duplicate EXP Reporting", blurb: "Search each record and fill the Export Acknowledgement form from your Excel row (same as Correction). The acknowledgement is never clicked — left ready for your review." },
  { kind: "download", label: "Download EXP", blurb: "Search each EXP by AD Code + Serial + Year, verify the EXP No, and download the EXP PDF named by your Save_As value." },
];

function statusTone(status: string): string {
  switch (status) {
    case "matched":
    case "downloaded": return "bg-green-50 text-green-700 border-green-200";
    case "filled":
    case "updated_verified": return "bg-emerald-50 text-emerald-700 border-emerald-200";
    case "running": return "bg-sky-50 text-sky-700 border-sky-200";
    case "queued":
    case "pending":
    case "skipped": return "bg-slate-50 text-slate-500 border-slate-200";
    case "partially_updated":
    case "not_found":
    case "mismatch":
    case "needs_auth": return "bg-amber-50 text-amber-700 border-amber-200";
    default: return "bg-rose-50 text-rose-700 border-rose-200";
  }
}

/** Operator-facing label for a row status. Correction + Duplicate share the same set. */
function statusLabel(status: string): string {
  switch (status) {
    case "filled": return "Form Filled";
    case "downloaded": return "Downloaded";
    case "not_found": return "Not found";
    case "needs_auth": return "Needs sign-in";
    case "pending": return "Pending";
    case "queued": return "Queued";
    case "running": return "Running";
    case "skipped": return "Skipped";
    case "failed": return "Failed";
    default: return status.replace(/_/g, " "); // legacy statuses from older runs
  }
}

const TERMINAL = new Set(["matched", "filled", "updated_verified", "partially_updated", "downloaded", "skipped", "not_found", "mismatch", "failed", "needs_auth"]);
const RETRYABLE = new Set(["not_found", "mismatch", "failed", "needs_auth", "partially_updated"]);
const EDITABLE = new Set(["pending", "skipped", "not_found", "mismatch", "failed", "needs_auth", "partially_updated"]);

function WorkflowPanel({ kind, liveEnabled, credsConfigured, onHistoryChange, openJobId, onOpened }: { kind: ExpKind; liveEnabled: boolean; credsConfigured: boolean; onHistoryChange: () => void; openJobId: string | null; onOpened: () => void }) {
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<JobStatus | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const fileRef = useRef<HTMLInputElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } }, []);
  const poll = useCallback(async (id: string) => {
    try {
      const r = await fetch(`/api/exp/${id}/status`, { cache: "no-store" });
      if (!r.ok) return;
      const data = (await r.json()) as JobStatus;
      setJob(data);
      // Once the job is no longer running, stop polling and refresh the
      // server-rendered Job History so its final counts/status show up.
      // (This never remounts the panel, so the preview + controls persist.)
      if (!data.running) { stopPolling(); onHistoryChange(); }
    } catch { /* keep polling */ }
  }, [stopPolling, onHistoryChange]);
  const startPolling = useCallback((id: string) => {
    stopPolling();
    void poll(id);
    pollRef.current = setInterval(() => void poll(id), 1500);
  }, [poll, stopPolling]);
  useEffect(() => () => stopPolling(), [stopPolling]);

  // Reopen a previously uploaded batch from Job History: load its rows, statuses
  // and logs from the DB (a single poll settles a finished job). Process-later
  // and retry then work on the restored rows without re-uploading the file.
  useEffect(() => {
    if (!openJobId) return;
    setJobId(openJobId);
    setJob(null);
    setSelected(new Set());
    setError(null);
    setNotice("Reopened a previous upload — its rows, statuses and logs are restored below.");
    startPolling(openJobId);
    onOpened();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openJobId]);

  async function onUpload() {
    setError(null); setNotice(null);
    const f = fileRef.current?.files?.[0];
    if (!f) { setError("Choose the .xlsx workbook for this workflow."); return; }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", f);
      fd.append("kind", kind);
      const r = await fetch("/api/exp/upload", { method: "POST", body: fd });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError(j.error || `Upload failed (${r.status}).`); return; }
      if (fileRef.current) fileRef.current.value = "";
      setJobId(j.jobId);
      setJob(null);
      setSelected(new Set());
      const parts = [`${j.total} row(s) parsed from “${j.sheetName}”`];
      if (j.invalid) parts.push(`${j.invalid} invalid (skipped)`);
      setNotice(parts.join(" · "));
      // Fetch the parsed rows so the preview table renders. The job is not
      // running yet (status "created"), so this single poll populates the
      // preview, then stops and refreshes Job History.
      startPolling(j.jobId);
    } finally {
      setUploading(false);
    }
  }

  function toggle(id: string) {
    setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }
  const selectableRows = (job?.rows ?? []).filter((r) => r.status !== "skipped");
  function toggleAll() {
    setSelected((s) => {
      if (s.size >= selectableRows.length && selectableRows.length > 0) return new Set();
      return new Set(selectableRows.map((r) => r.id));
    });
  }

  function process(rowIds?: string[]) {
    if (!jobId) return;
    setError(null); setNotice(null);
    startTransition(async () => {
      const res = await processExpRowsAction(jobId, rowIds);
      if (res.error) { setError(res.error); return; }
      setNotice(res.message ?? "Processing started.");
      setSelected(new Set());
      startPolling(jobId);
    });
  }
  function retry(rowId: string) {
    startTransition(async () => {
      const res = await retryExpRowAction(rowId);
      if (res.error) { setError(res.error); return; }
      if (jobId) startPolling(jobId);
    });
  }

  // --- inline row editing (before processing) ---
  const [editId, setEditId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const mapFields = fieldsForKind(kind);
  function openEdit(r: RowView) {
    const d: Record<string, string> = { __adscode: r.adscode, __expSerial: r.expSerial, __expYear: r.expYear, __expNo: r.expNo, __saveAs: r.saveAs };
    for (const f of mapFields) d[f.key] = r.values[f.key] ?? "";
    setDraft(d);
    setEditId(r.id);
  }
  function saveEdit(rowId: string) {
    const values: Record<string, string> = {};
    for (const f of mapFields) values[f.key] = draft[f.key] ?? "";
    const patch = { adscode: draft.__adscode, expSerial: draft.__expSerial, expYear: draft.__expYear, expNo: draft.__expNo, saveAs: draft.__saveAs, values };
    startTransition(async () => {
      const res = await updateExpRowAction(rowId, patch);
      if (res.error) { setError(res.error); return; }
      setEditId(null);
      if (jobId) startPolling(jobId);
    });
  }
  const setD = (k: string, v: string) => setDraft((d) => ({ ...d, [k]: v }));

  const c = job?.counts;
  const pct = c && c.total > 0 ? Math.round((c.processed / c.total) * 100) : 0;
  const isDownload = kind === "download";

  return (
    <div className="space-y-5">
      {!liveEnabled ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          Live EXP automation is <strong>off</strong>. Set <code>EXP_LIVE_ENABLED=true</code> (and <code>EXP_USERNAME</code> / <code>EXP_PASSWORD</code>) in
          <code> .env</code> to drive the real portal. You can still upload and preview; no result is ever fabricated.
        </div>
      ) : (
        <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300">
          Live automation is <strong>on</strong>. A visible browser opens on the server and drives the EXP portal one record at a time.
          Sign-in is {credsConfigured ? "configured" : <strong>not configured — set EXP_USERNAME/EXP_PASSWORD</strong>}.
          {!isDownload ? <> The form is <strong>filled from Excel and read back to confirm</strong>; the bot never clicks Update / Submit / Acknowledge.</> : null}
        </div>
      )}

      <div className="card p-5">
        <div className="flex flex-wrap items-end gap-4">
          <label className="flex-1">
            <span className="mb-1 block text-xs font-semibold text-slate-600 dark:text-slate-300">Workbook (.xlsx) <span className="text-rose-500">*</span></span>
            <input ref={fileRef} type="file" accept=".xlsx" className="w-full text-sm text-slate-600 file:mr-2 file:rounded file:border-0 file:bg-slate-100 file:px-3 file:py-1.5 dark:text-slate-300 dark:file:bg-slate-700 dark:file:text-slate-200" />
          </label>
          <button onClick={onUpload} disabled={uploading || pending} className="btn-primary text-sm disabled:opacity-40">
            {uploading ? "Parsing…" : "⇪ Upload & preview"}
          </button>
        </div>
        <p className="mt-2 text-xs text-slate-400">{TABS.find((t) => t.kind === kind)!.blurb}</p>
      </div>

      {uploading ? (
        <div className="flex items-center gap-2 rounded-md border border-sky-200 bg-sky-50 p-3 text-sm text-sky-800">
          <span className="spinner h-4 w-4" /> Uploading and parsing the workbook… reading every row and validating identifiers.
        </div>
      ) : null}

      {error ? <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{error}</div> : null}
      {notice ? <div className="rounded-md border border-sky-200 bg-sky-50 p-3 text-xs text-sky-800">{notice}</div> : null}

      {job ? (
        <div className="card p-5">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-slate-800">Progress</h3>
            <div className="flex items-center gap-2 text-xs">
              {isDownload && c && c.downloaded > 0 ? <a href={`/api/exp/${job.id}/zip`} className="btn-primary btn-xs">⬇ All PDFs ({c.downloaded}) ZIP</a> : null}
              {job.hasFile ? <a href={`/api/exp/${job.id}/file`} className="btn-ghost btn-xs" title="The original uploaded workbook (unchanged)">⬇ Original xlsx</a> : null}
              {job.hasFile ? <a href={`/api/exp/${job.id}/file?edited=1`} className="btn-ghost btn-xs" title="A workbook rebuilt from the current (edited) rows">⬇ Edited xlsx</a> : null}
              <a href={`/api/exp/${job.id}/report`} className="btn-ghost btn-xs">⬇ CSV report</a>
              <StopProcessButton scope="exp" id={job.id} running={job.running} pending={c?.remaining} onStopped={() => startPolling(job.id)} />
              {job.running ? <span className="inline-flex items-center gap-1 text-slate-500"><span className="spinner h-3 w-3" /> running</span> : job.status === "stopped" ? <span className="text-rose-600">stopped</span> : <span className="text-slate-400">idle</span>}
            </div>
          </div>

          {job.status === "created" ? (
            <div className="mb-3 rounded-md border border-amber-200 bg-amber-50 p-2 text-[11px] text-amber-800">
              {c?.total ?? 0} row(s) parsed and ready to review. <strong>Nothing runs until you start it</strong> — select rows and click
              {" "}<strong>Process selected</strong>, or <strong>Process all pending</strong> below.
            </div>
          ) : null}

          <div className="mb-2 h-2 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-700">
            <div className="h-full rounded-full bg-sky-500 transition-all" style={{ width: `${pct}%` }} />
          </div>
          {c ? (
            <div className="mb-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600 dark:text-slate-300">
              <span className="font-semibold text-slate-700 dark:text-slate-100">{pct}% complete</span>
              <span>{c.total} total</span>
              <span>{c.processed} processed</span>
              {!isDownload ? <span className="text-emerald-700">{c.changed} form filled</span> : null}
              {isDownload ? <span className="text-green-700">{c.downloaded} downloaded</span> : null}
              <span className="text-slate-400">{c.skipped} skipped</span>
              <span className="text-rose-700">{c.failed} failed</span>
              <span className="text-sky-700">{c.remaining} remaining</span>
            </div>
          ) : null}
          {(() => {
            // Current activity: the row the serialized driver is on right now.
            const cur = job.running ? job.rows.find((r) => r.status === "running") : null;
            if (!cur) return <div className="mb-4" />;
            const id = isDownload ? (cur.expNo || cur.saveAs) : `${cur.adscode} · ${cur.expSerial} · ${cur.expYear}`;
            return (
              <div className="mb-4 flex items-center gap-2 text-[11px] text-sky-700 dark:text-sky-300">
                <span className="spinner h-3 w-3" />
                <span>Row {cur.rowNo} ({id}){cur.step ? ` — ${cur.step}` : ""}</span>
              </div>
            );
          })()}

          <div className="mb-3 flex flex-wrap items-center gap-3">
            <button onClick={() => process(Array.from(selected))} disabled={pending || selected.size === 0} className="btn-primary btn-sm disabled:opacity-40">▶ Process selected ({selected.size})</button>
            <button onClick={() => process(undefined)} disabled={pending} className="btn-ghost btn-sm disabled:opacity-40">▶ Process all pending</button>
            <label className="ml-auto flex items-center gap-2 text-xs text-slate-500">
              <input type="checkbox" checked={selected.size >= selectableRows.length && selectableRows.length > 0} onChange={toggleAll} /> Select all
            </label>
          </div>

          <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-700">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                <tr>
                  <th className="th w-8"></th>
                  <th className="th text-left">#</th>
                  <th className="th text-left">{isDownload ? "EXP No / Save as" : "ADSCODE · Serial · Year"}</th>
                  <th className="th text-left">Status / step</th>
                  <th className="th text-left">{isDownload ? "PDF" : "Fields filled"}</th>
                  <th className="th text-left">Action</th>
                </tr>
              </thead>
              <tbody>
                {job.rows.map((r) => {
                  const err = TERMINAL.has(r.status) && (RETRYABLE.has(r.status) || (r.status === "downloaded" && !r.hasPdf));
                  const canEdit = EDITABLE.has(r.status) && !job.running;
                  return (
                    <Fragment key={r.id}>
                    <tr className="border-t border-slate-100 align-top dark:border-slate-700">
                      <td className="td">
                        {r.status !== "skipped" ? <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggle(r.id)} /> : null}
                      </td>
                      <td className="td text-slate-400">{r.rowNo}</td>
                      <td className="td font-mono">
                        {isDownload ? (
                          <><div>{r.expNo}</div><div className="text-slate-400">{r.saveAs}</div></>
                        ) : (
                          <><div>{r.adscode} · {r.expSerial} · {r.expYear}</div>{r.invoiceNo ? <div className="text-slate-400">inv {r.invoiceNo}</div> : null}</>
                        )}
                        {r.notes.length ? <div className="mt-0.5 text-[10px] text-amber-600">{r.notes.join(" ")}</div> : null}
                      </td>
                      <td className="td">
                        <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${statusTone(r.status)}`}>{statusLabel(r.status)}</span>
                        {r.step && !TERMINAL.has(r.status) ? <div className="mt-0.5 text-[11px] text-slate-400">{r.step}</div> : null}
                        {err && r.error ? <div className="mt-0.5 text-[11px] text-rose-600">{r.error}</div> : null}
                      </td>
                      <td className="td">
                        {isDownload ? (
                          r.status === "downloaded" && r.hasPdf ? (
                            <span className="flex gap-2">
                              <a href={`/api/exp/row/${r.id}/pdf`} target="_blank" rel="noreferrer" className="text-sky-700 hover:underline">👁</a>
                              <a href={`/api/exp/row/${r.id}/pdf?download=1`} className="text-sky-700 hover:underline">⬇</a>
                            </span>
                          ) : "—"
                        ) : r.mismatched.length ? (
                          <details>
                            <summary className="cursor-pointer text-emerald-700">{r.mismatched.length} field(s)</summary>
                            <ul className="mt-1 space-y-0.5 text-[10px] text-slate-500">
                              {r.mismatched.map((m, i) => (
                                <li key={i}><span className="font-semibold text-slate-600">{m.portalLabel}</span>: “{m.portal || "—"}” → “{m.excel}”</li>
                              ))}
                            </ul>
                          </details>
                        ) : r.status === "matched" ? <span className="text-slate-400">unchanged</span> : "—"}
                      </td>
                      <td className="td">
                        <div className="flex items-center gap-2">
                          {canEdit ? <button onClick={() => (editId === r.id ? setEditId(null) : openEdit(r))} disabled={pending} className="text-slate-600 hover:underline disabled:text-slate-300">{editId === r.id ? "✕ Close" : "✎ Edit"}</button> : null}
                          {err ? <button onClick={() => retry(r.id)} disabled={pending} className="text-sky-700 hover:underline disabled:text-slate-300">↻ Retry</button> : null}
                          {!canEdit && !err ? "—" : null}
                        </div>
                      </td>
                    </tr>
                    {editId === r.id ? (
                      <tr className="border-t border-slate-100 bg-slate-50/60 dark:border-slate-700 dark:bg-slate-800/40">
                        <td className="td" colSpan={6}>
                          <div className="space-y-2 p-1">
                            <div className="flex flex-wrap gap-2">
                              {isDownload ? (
                                <>
                                  <label className="text-[11px] text-slate-500">EXP No<input className="ml-1 w-56 rounded border border-slate-300 px-1 py-0.5 text-xs dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 font-mono" value={draft.__expNo ?? ""} onChange={(e) => setD("__expNo", e.target.value)} /></label>
                                  <label className="text-[11px] text-slate-500">Save as<input className="ml-1 w-40 rounded border border-slate-300 px-1 py-0.5 text-xs dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100" value={draft.__saveAs ?? ""} onChange={(e) => setD("__saveAs", e.target.value)} /></label>
                                </>
                              ) : (
                                <>
                                  <label className="text-[11px] text-slate-500">ADSCODE<input className="ml-1 w-28 rounded border border-slate-300 px-1 py-0.5 text-xs dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 font-mono" value={draft.__adscode ?? ""} onChange={(e) => setD("__adscode", e.target.value)} /></label>
                                  <label className="text-[11px] text-slate-500">EXP Serial<input className="ml-1 w-24 rounded border border-slate-300 px-1 py-0.5 text-xs dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 font-mono" value={draft.__expSerial ?? ""} onChange={(e) => setD("__expSerial", e.target.value)} /></label>
                                  <label className="text-[11px] text-slate-500">EXP Year<input className="ml-1 w-20 rounded border border-slate-300 px-1 py-0.5 text-xs dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 font-mono" value={draft.__expYear ?? ""} onChange={(e) => setD("__expYear", e.target.value)} /></label>
                                </>
                              )}
                            </div>
                            {mapFields.length ? (
                              <div className="grid grid-cols-2 gap-x-4 gap-y-1 md:grid-cols-3">
                                {mapFields.map((f) => (
                                  <label key={f.key} className="flex items-center justify-between gap-2 text-[11px] text-slate-500">
                                    <span className="truncate" title={f.needsConfirmation || f.portalLabel}>{f.portalLabel}{f.needsConfirmation ? " ⚠" : ""}</span>
                                    <input className="w-32 rounded border border-slate-300 px-1 py-0.5 text-xs dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100" value={draft[f.key] ?? ""} onChange={(e) => setD(f.key, e.target.value)} />
                                  </label>
                                ))}
                              </div>
                            ) : null}
                            <div className="flex items-center gap-2 pt-1">
                              <button onClick={() => saveEdit(r.id)} disabled={pending} className="btn-primary btn-xs disabled:opacity-40">Save row</button>
                              <button onClick={() => setEditId(null)} disabled={pending} className="btn-ghost btn-xs">Cancel</button>
                              <span className="text-[10px] text-slate-400">Saved to this row only — nothing is submitted to the portal.</span>
                            </div>
                          </div>
                        </td>
                      </tr>
                    ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>

          {job.events && job.events.length ? (
            <div className="mt-4">
              <div className="mb-1 flex items-center gap-2 text-xs font-semibold text-slate-700 dark:text-slate-200">
                Live log {job.running ? <span className="spinner h-3 w-3" /> : null}
              </div>
              <div className="max-h-48 space-y-0.5 overflow-auto rounded-lg border border-slate-200 bg-slate-50/60 p-2 font-mono text-[11px] leading-relaxed dark:border-slate-700 dark:bg-slate-800/60">
                {job.events.map((e, i) => (
                  <div key={i} className="flex gap-2">
                    <span className="shrink-0 text-slate-400">{e.at.slice(11, 19)}</span>
                    <span className="shrink-0 text-slate-500">row {e.rowNo}</span>
                    <span className={e.status === "ok" ? "text-green-700" : e.status === "failed" ? "text-rose-700" : "text-slate-600"}>
                      {e.step ? `${e.step}: ` : ""}{e.message}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function ExpAutomationManager({ liveEnabled, credsConfigured, recentJobs }: { liveEnabled: boolean; credsConfigured: boolean; recentJobs: ExpRecentJob[] }) {
  const router = useRouter();
  const [tab, setTab] = useState<ExpKind>("correction");
  const [historyFilter, setHistoryFilter] = useState<string>("all");
  const [openJobId, setOpenJobId] = useState<string | null>(null);

  const jobs = recentJobs.filter((j) => historyFilter === "all" || j.kind === historyFilter);

  function openJob(j: ExpRecentJob) {
    const k = j.kind as ExpKind;
    setTab(k);
    setOpenJobId(j.id);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200">
        {TABS.map((t) => (
          <button
            key={t.kind}
            onClick={() => setTab(t.kind)}
            className={`-mb-px border-b-2 px-4 py-2 text-sm font-semibold ${tab === t.kind ? "border-sky-500 text-sky-700 dark:text-sky-300" : "border-transparent text-slate-500 hover:text-slate-700"}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <WorkflowPanel key={tab} kind={tab} liveEnabled={liveEnabled} credsConfigured={credsConfigured} onHistoryChange={() => router.refresh()} openJobId={openJobId} onOpened={() => setOpenJobId(null)} />

      <div className="card">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
          <div className="text-sm font-semibold text-slate-700">Job history</div>
          <select value={historyFilter} onChange={(e) => setHistoryFilter(e.target.value)} className="rounded border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700">
            <option value="all">All workflows</option>
            <option value="correction">Correction</option>
            <option value="duplicate">Duplicate</option>
            <option value="download">Download</option>
          </select>
        </div>
        {jobs.length === 0 ? (
          <div className="p-4 text-sm text-slate-400">No EXP jobs yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-50">
                <tr>
                  <th className="th">Job</th><th className="th">Workflow</th><th className="th">File</th><th className="th">Rows</th>
                  <th className="th">Filled</th><th className="th">Downloaded</th><th className="th">Failed</th>
                  <th className="th">Status</th><th className="th">Created</th><th className="th">Open</th><th className="th">Files</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((j) => (
                  <tr key={j.id} className="border-t border-slate-50">
                    <td className="td font-mono">{j.id.slice(0, 8)}</td>
                    <td className="td capitalize">{j.kind}</td>
                    <td className="td text-slate-600">{j.sourceName || "—"}</td>
                    <td className="td">{j.total}</td>
                    <td className="td text-emerald-600 dark:text-emerald-400">{j.changed}</td>
                    <td className="td text-green-600 dark:text-green-400">{j.downloaded}</td>
                    <td className="td text-rose-600 dark:text-rose-400">{j.failed}</td>
                    <td className="td capitalize">{j.status.replace(/_/g, " ")}</td>
                    <td className="td text-slate-400">{j.createdAt}</td>
                    <td className="td"><button onClick={() => openJob(j)} className="text-sky-700 hover:underline dark:text-sky-400">↗ Open</button></td>
                    <td className="td">
                      <div className="flex gap-2">
                        {j.hasFile ? <a href={`/api/exp/${j.id}/file`} className="text-sky-700 hover:underline dark:text-sky-400" title="Original uploaded workbook">xlsx</a> : null}
                        {j.hasFile ? <a href={`/api/exp/${j.id}/file?edited=1`} className="text-sky-700 hover:underline dark:text-sky-400" title="Rebuilt from current edited rows">edited</a> : null}
                        <a href={`/api/exp/${j.id}/report`} className="text-sky-700 hover:underline dark:text-sky-400">CSV</a>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <p className="text-[11px] text-slate-400">
        Safety: the Correction and Duplicate workflows search and fill the portal form, then stop — the bot never clicks Update, Submit or
        Acknowledge. Review each prepared form in the visible browser and submit it yourself.{" "}
        <Link href="/modules/exp-automation" className="hidden">.</Link>
      </p>
    </div>
  );
}
