"use client";

/**
 * PDF File Rename — folder selection, deep Scan & Preview, bulk rename job, and
 * persisted Rename History. Layout follows the approved mockup (drop-zone →
 * stat tiles → actions → history) in UCP's light brand theme.
 *
 * Every action calls the real backend:
 *  - validateFolderAction  → confirm a server folder path + PDF count
 *  - previewFolderAction   → deep read-only preview (invoice #, proposed name, confidence, status)
 *  - startRenameJobAction  → background DB-backed bulk rename → one unified RenameJobProgress
 *  - listRenameJobsAction  → persisted history (view details / report / resume)
 *
 * Folder selection is SERVER-SIDE: the backend only reads folders under the
 * configured rename root on the UCP server — never the user's local computer.
 */

import { useMemo, useState, useTransition } from "react";
import {
  validateFolderAction,
  previewFolderAction,
  startRenameJobAction,
  listRenameJobsAction,
  resumeRenameJobAction,
  type PreviewView,
  type JobHistoryRow,
} from "@/app/actions/pdf-rename-folders";
import { RenameJobProgress } from "@/components/RenameJobProgress";

export interface RenameFolderInfo {
  name: string;
  fileCount: number;
}

type Preview = NonNullable<PreviewView["preview"]>;

const STATUS_TONE: Record<string, string> = {
  completed: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-600/15",
  partial: "bg-amber-50 text-amber-700 ring-1 ring-amber-600/20",
  processing: "bg-sky-50 text-sky-700 ring-1 ring-sky-600/15",
  queued: "bg-slate-100 text-slate-600",
  paused: "bg-slate-100 text-slate-600",
  failed: "bg-rose-50 text-rose-700 ring-1 ring-rose-600/15",
};

function FolderIcon() {
  return (
    <svg width="34" height="34" viewBox="0 0 24 24" fill="none" className="mx-auto text-ananta" aria-hidden>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}

function Stat({ label, value, accent }: { label: string; value: string | number; accent: string }) {
  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
      <div className="p-3">
        <div className="text-[11px] font-medium uppercase tracking-wide text-slate-400">{label}</div>
        <div className="mt-1 text-2xl font-semibold text-slate-800">{value}</div>
      </div>
      <div className={`h-1 w-full ${accent}`} />
    </div>
  );
}

function fmtDate(iso: string): string {
  return iso.slice(0, 16).replace("T", " ");
}

export function PdfRenameManager({
  folders,
  rootConfigured,
  rootPath,
  ocrEnabled,
  outputSubdir,
  recentJobs,
  configError,
}: {
  folders: RenameFolderInfo[];
  rootConfigured: boolean;
  rootPath: string;
  ocrEnabled: boolean;
  outputSubdir: string;
  recentJobs: JobHistoryRow[];
  configError?: string;
}) {
  const [folder, setFolder] = useState<string>(folders[0]?.name ?? "");
  const [picking, setPicking] = useState(false);
  const [confirmed, setConfirmed] = useState<{ folder: string; count: number } | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [history, setHistory] = useState<JobHistoryRow[]>(recentJobs ?? []);
  const [hQuery, setHQuery] = useState("");
  const [hFilter, setHFilter] = useState("all");
  const [busy, setBusy] = useState<"" | "validate" | "preview" | "start">("");
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  const refreshHistory = () => start(async () => { const r = await listRenameJobsAction(); setHistory(r.jobs); });

  const doValidate = (): Promise<boolean> =>
    new Promise((resolve) =>
      start(async () => {
        setBusy("validate");
        const res = await validateFolderAction(folder.trim());
        setBusy("");
        if (!res.ok) { setConfirmed(null); setMsg({ tone: "err", text: res.error ?? "Folder not accessible." }); resolve(false); return; }
        setConfirmed({ folder: res.folder ?? folder.trim(), count: res.count ?? 0 });
        setPicking(false);
        setMsg({ tone: "ok", text: `Folder ready: ${res.count ?? 0} PDF(s) on the UCP server.` });
        resolve(true);
      }),
    );

  const doPreview = () =>
    start(async () => {
      if (!confirmed && !(await doValidate())) return;
      setBusy("preview");
      setMsg(null);
      const res = await previewFolderAction(folder.trim());
      setBusy("");
      if (res.error) { setMsg({ tone: "err", text: res.error }); return; }
      if (res.preview) {
        setPreview(res.preview);
        setJobId(null);
        setMsg({ tone: "ok", text: `Previewed ${res.preview.total} PDF(s): ${res.preview.willRename} ready to rename, ${res.preview.needsReview} need review. No files changed.` });
      }
    });

  const doRenameAll = () =>
    start(async () => {
      if (!confirmed && !(await doValidate())) return;
      setBusy("start");
      setMsg(null);
      const res = await startRenameJobAction(folder.trim());
      setBusy("");
      if (res.error) { setMsg({ tone: "err", text: res.error }); return; }
      if (res.jobId) {
        setJobId(res.jobId);
        setPreview(null);
        setMsg({ tone: "ok", text: res.alreadyRunning ? "A job for this folder is already running — showing its progress." : `Started: processing ${res.total ?? 0} PDF(s).` });
        setTimeout(refreshHistory, 800);
      }
    });

  const viewJob = (id: string) => { setJobId(id); setPreview(null); setMsg(null); window.scrollTo({ top: 0, behavior: "smooth" }); };
  const resumeHistoryJob = (id: string) => start(async () => { const fd = new FormData(); fd.set("jobId", id); await resumeRenameJobAction(fd); setJobId(id); setTimeout(refreshHistory, 1000); });

  const selectedJob = jobId ? history.find((j) => j.id === jobId) ?? null : null;
  const dash = "—";
  const totalPdfs = preview?.total ?? confirmed?.count ?? selectedJob?.total ?? dash;
  const renamedCount = selectedJob?.renamed ?? dash;
  const reviewCount = preview?.needsReview ?? selectedJob?.review ?? dash;

  const filteredHistory = useMemo(() => {
    const q = hQuery.trim().toLowerCase();
    return history.filter((j) => {
      if (hFilter !== "all" && j.status !== hFilter) return false;
      if (!q) return true;
      return `${j.folder} ${j.id} ${j.createdBy}`.toLowerCase().includes(q);
    });
  }, [history, hQuery, hFilter]);

  if (!rootConfigured) {
    return (
      <div className="card border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
        The rename source folder is not configured. Set <code>PDF_RENAME_ROOT</code> in <code>.env</code> to the
        “PDF File Rename” directory on the UCP server, then restart the portal.
      </div>
    );
  }

  const pv = preview;

  return (
    <div className="space-y-5">
      {configError ? <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{configError}</div> : null}

      {/* 1. Main card: folder drop-zone + stat tiles + actions */}
      <div className="card space-y-4 p-5">
        {/* Drop-zone */}
        <div className="rounded-xl border-2 border-dashed border-slate-200 bg-slate-50/60 p-7 text-center">
          <FolderIcon />
          <div className="mt-2 text-sm font-semibold text-slate-800">Select a folder</div>
          <p className="mx-auto mt-1 max-w-md text-xs text-slate-500">
            Choose a folder on the <strong>UCP server</strong> that contains PDFs, then scan its contents before renaming.
            This reads the server filesystem — not your own computer.
          </p>

          {!picking && !confirmed ? (
            <button onClick={() => { setPicking(true); setMsg(null); }} className="btn-primary mt-3 rounded-full px-5 text-xs">Select Folder</button>
          ) : null}

          {picking ? (
            <div className="mx-auto mt-3 flex max-w-lg flex-wrap items-stretch justify-center gap-2">
              <input
                list="rename-folder-suggestions"
                value={folder}
                onChange={(e) => setFolder(e.target.value)}
                placeholder="e.g. FCR EXTRACT & RENAME"
                className="min-w-[16rem] flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm"
                autoFocus
              />
              <datalist id="rename-folder-suggestions">
                {folders.map((f) => <option key={f.name} value={f.name}>{f.fileCount} PDF(s)</option>)}
              </datalist>
              <button onClick={doValidate} disabled={pending || !folder.trim()} className="btn-primary text-xs disabled:opacity-40">{busy === "validate" ? "Checking…" : "Use this folder"}</button>
              <button onClick={() => setPicking(false)} className="btn-ghost text-xs">Cancel</button>
            </div>
          ) : null}

          {confirmed && !picking ? (
            <div className="mx-auto mt-3 flex max-w-lg items-center justify-center gap-2 text-xs">
              <span className="rounded-md bg-white px-3 py-1.5 font-medium text-slate-700 ring-1 ring-slate-200">📁 {confirmed.folder || "(root)"} · {confirmed.count} PDF(s)</span>
              <button onClick={() => { setPicking(true); }} className="text-sky-700 hover:underline">Change</button>
            </div>
          ) : null}

          <div className="mt-3 text-[11px] text-slate-400">PDF files only · Preserve original PDF content</div>
        </div>

        {/* Stat tiles (always visible) */}
        <div className="grid grid-cols-3 gap-3">
          <Stat label="Total PDFs" value={totalPdfs} accent="bg-slate-300" />
          <Stat label="Renamed" value={renamedCount} accent="bg-emerald-400" />
          <Stat label="Need review" value={reviewCount} accent="bg-rose-400" />
        </div>

        {/* Actions */}
        <div className="border-t border-slate-100 pt-3">
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={doPreview} disabled={pending || !confirmed} className="btn-ghost text-xs disabled:opacity-40">{busy === "preview" ? "Scanning…" : "🔍 Scan & Preview"}</button>
            <button onClick={doRenameAll} disabled={pending || !confirmed} className="btn-primary text-xs disabled:opacity-40">{busy === "start" ? "Starting…" : "▶ Rename All PDFs"}</button>
            {confirmed ? <a href={`/api/pdf-rename/zip?folder=${encodeURIComponent(confirmed.folder)}`} className="btn-ghost text-xs">⬇ Download renamed (ZIP)</a> : null}
            <span className="ml-auto text-[11px] text-slate-400">Server root: <code>{rootPath || "—"}</code> · OCR {ocrEnabled ? "enabled" : "disabled"}</span>
          </div>
          <div className="mt-2 text-[11px] text-slate-400">
            {confirmed ? "Scan previews without changing files; Rename All runs a background job." : "Actions become available after a folder is selected and scanned."}
          </div>
          {msg ? <div className={`mt-2 text-sm ${msg.tone === "ok" ? "text-emerald-700" : "text-rose-600"}`}>{msg.text}</div> : null}
          {!ocrEnabled ? (
            <div className="mt-1 text-[11px] text-slate-400">Scanned PDFs (no embedded text) route to review while OCR is off. Set <code>OCR_ENABLED=true</code> to extract them automatically.</div>
          ) : null}
        </div>
      </div>

      {/* 2. Scan & Preview table (read-only, before renaming) */}
      {pv ? (
        <div className="card p-4">
          <div className="mb-3 text-sm font-semibold text-slate-800">Preview — {pv.folder || "(root)"} <span className="font-normal text-slate-400">(no files changed)</span></div>
          <div className="overflow-x-auto">
            <table className="w-full whitespace-nowrap text-xs">
              <thead className="bg-slate-50 text-slate-500"><tr>
                <th className="px-3 py-1.5 text-left font-semibold">Original filename</th>
                <th className="px-3 py-1.5 text-left font-semibold">Invoice No.</th>
                <th className="px-3 py-1.5 text-left font-semibold">Proposed name</th>
                <th className="px-3 py-1.5 text-left font-semibold">Conf.</th>
                <th className="px-3 py-1.5 text-left font-semibold">Via</th>
                <th className="px-3 py-1.5 text-left font-semibold">Validation</th>
              </tr></thead>
              <tbody>
                {pv.items.map((it) => (
                  <tr key={it.originalName} className="border-t border-slate-100">
                    <td className="px-3 py-1.5 font-mono max-w-[220px] truncate" title={it.originalName}>{it.originalName}</td>
                    <td className="px-3 py-1.5 font-mono">{it.invoiceNumber || "—"}</td>
                    <td className="px-3 py-1.5 font-mono">{it.proposedName || "—"}</td>
                    <td className="px-3 py-1.5">{it.confidence ? `${Math.round(it.confidence * 100)}%` : "—"}</td>
                    <td className="px-3 py-1.5">{it.source === "none" ? "—" : it.source}</td>
                    <td className="px-3 py-1.5">
                      {it.decision === "RENAME"
                        ? <span className="badge bg-emerald-50 text-emerald-700 ring-1 ring-emerald-600/15">will rename</span>
                        : <span className="badge bg-amber-50 text-amber-700 ring-1 ring-amber-600/20" title={it.reasonText}>{it.reviewReason || "review"}</span>}
                    </td>
                  </tr>
                ))}
                {pv.items.length === 0 ? <tr><td className="px-3 py-3 text-slate-400" colSpan={6}>No PDFs in this folder.</td></tr> : null}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {/* 3. The single unified batch progress + review workbench for the active job */}
      {jobId ? <RenameJobProgress jobId={jobId} onDone={refreshHistory} /> : null}

      {/* 4. Rename History (persisted jobs) */}
      <div className="card p-4">
        <div className="mb-1 flex items-center gap-2">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="text-slate-400" aria-hidden><path d="M3 12a9 9 0 1 0 3-6.7M3 4v4h4M12 7v5l3 2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
          <div className="text-sm font-semibold text-slate-800">Rename History</div>
        </div>
        <p className="mb-3 text-xs text-slate-500">Previous and current batch jobs — search, open details, download a report, or retry failures.</p>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <select value={hFilter} onChange={(e) => setHFilter(e.target.value)} className="rounded border border-slate-200 px-2 py-1 text-xs">
            <option value="all">All</option>
            <option value="completed">Completed</option>
            <option value="partial">Partial</option>
            <option value="processing">In progress</option>
            <option value="failed">Failed</option>
          </select>
          <input value={hQuery} onChange={(e) => setHQuery(e.target.value)} placeholder="Search by folder, job ID, or user…" className="w-64 rounded border border-slate-200 px-2 py-1 text-xs" />
          <button onClick={refreshHistory} disabled={pending} className="btn-ghost btn-xs">↻ Refresh</button>
        </div>
        {filteredHistory.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-200 p-5 text-center text-sm text-slate-400">
            {history.length === 0 ? "No rename jobs yet — select a folder and run “Rename All PDFs”." : "No jobs match the filter."}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full whitespace-nowrap text-xs">
              <thead className="bg-slate-50 text-slate-500"><tr>
                <th className="px-3 py-1.5 text-left font-semibold">Date / Job</th>
                <th className="px-3 py-1.5 text-left font-semibold">Folder</th>
                <th className="px-3 py-1.5 text-left font-semibold">Total</th>
                <th className="px-3 py-1.5 text-left font-semibold">Result (renamed / review / failed)</th>
                <th className="px-3 py-1.5 text-left font-semibold">Status</th>
                <th className="px-3 py-1.5 text-left font-semibold">Action</th>
              </tr></thead>
              <tbody>
                {filteredHistory.map((j) => (
                  <tr key={j.id} className="border-t border-slate-100">
                    <td className="px-3 py-1.5"><div className="text-slate-600">{fmtDate(j.createdAt)}</div><div className="font-mono text-[11px] text-slate-400">{j.id.slice(0, 8)}</div></td>
                    <td className="px-3 py-1.5 max-w-[220px] truncate" title={j.folder}>{j.folder || "(root)"}</td>
                    <td className="px-3 py-1.5">{j.total}</td>
                    <td className="px-3 py-1.5"><span className="text-emerald-700">{j.renamed}</span> / <span className="text-amber-700">{j.review}</span> / <span className="text-rose-700">{j.failed}</span></td>
                    <td className="px-3 py-1.5"><span className={`badge ${STATUS_TONE[j.status] ?? "bg-slate-100 text-slate-600"}`}>{j.status}</span></td>
                    <td className="px-3 py-1.5">
                      <div className="flex items-center gap-2">
                        <button onClick={() => viewJob(j.id)} className="text-sky-700 hover:underline">View details</button>
                        <a href={`/api/pdf-rename/job/${j.id}/report`} className="text-sky-700 hover:underline">Report</a>
                        {j.review + j.failed > 0 && j.status !== "processing" ? (
                          <button onClick={() => resumeHistoryJob(j.id)} disabled={pending} className="text-sky-700 hover:underline disabled:text-slate-300">Retry failures</button>
                        ) : null}
                      </div>
                    </td>
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
