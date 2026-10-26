"use client";

/**
 * PDF File Rename — folder selection + bulk "Rename All PDFs" entry point.
 *
 * Picking a folder and clicking "Rename All PDFs" starts a DB-backed background
 * job (deep extraction, cross-validation, safe rename) and renders the single
 * unified batch progress + review workbench (`RenameJobProgress`). There are no
 * per-file progress bars and no legacy preview/CSV-plan panels here — the job UI
 * is the whole workflow.
 */

import { useState, useTransition } from "react";
import { startRenameJobAction } from "@/app/actions/pdf-rename-folders";
import { RenameJobProgress } from "@/components/RenameJobProgress";

export interface RenameFolderInfo {
  name: string;
  fileCount: number;
}

export function PdfRenameManager({
  folders,
  rootConfigured,
  ocrEnabled,
  outputSubdir,
  configError,
}: {
  folders: RenameFolderInfo[];
  rootConfigured: boolean;
  ocrEnabled: boolean;
  outputSubdir: string;
  configError?: string;
}) {
  const [active, setActive] = useState<string>(folders[0]?.name ?? "");
  const [jobId, setJobId] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  const selectFolder = (name: string) => {
    setActive(name);
    setJobId(null);
    setMsg(null);
  };

  const runRenameAll = () =>
    start(async () => {
      setBusy(true);
      setMsg(null);
      const res = await startRenameJobAction(active);
      setBusy(false);
      if (res.error) { setMsg({ tone: "err", text: res.error }); return; }
      if (res.jobId) {
        setJobId(res.jobId);
        setMsg({ tone: "ok", text: res.alreadyRunning ? "A job for this folder is already running — showing its progress." : `Started: processing ${res.total ?? 0} PDF(s).` });
      }
    });

  if (!rootConfigured) {
    return (
      <div className="card border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
        The rename source folder is not configured. Set <code>PDF_RENAME_ROOT</code> in <code>.env</code> to the
        “PDF File Rename” directory, then restart the portal.
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {configError ? <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{configError}</div> : null}

      {/* Folder picker + bulk action */}
      <div className="card p-4">
        <div className="mb-3 text-sm font-semibold text-slate-800">Select folder</div>
        <div className="flex flex-wrap gap-2">
          {folders.map((f) => (
            <button
              key={f.name}
              onClick={() => selectFolder(f.name)}
              className={`rounded-md border px-3 py-2 text-left text-xs ${active === f.name ? "border-ananta bg-sky-50 text-sky-900" : "border-slate-200 hover:border-slate-300"}`}
            >
              <div className="font-medium">{f.name}</div>
              <div className="text-[11px] text-slate-500">{f.fileCount} PDF(s)</div>
            </button>
          ))}
          {folders.length === 0 ? <div className="text-sm text-slate-400">No folders found under the rename root.</div> : null}
        </div>
        {active ? (
          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
            <button onClick={runRenameAll} disabled={pending} className="btn-primary text-xs disabled:opacity-40">
              {busy ? "Starting…" : "▶ Rename All PDFs"}
            </button>
            <a href={`/api/pdf-rename/zip?folder=${encodeURIComponent(active)}`} className="btn-ghost text-xs">⬇ Download renamed (ZIP)</a>
            <span className="ml-auto text-[11px] text-slate-400">
              Output → <code>{active}/{outputSubdir}/</code> · OCR {ocrEnabled ? "enabled" : "disabled"} · deep extraction + review
            </span>
          </div>
        ) : null}
        {msg ? <div className={`mt-3 text-sm ${msg.tone === "ok" ? "text-green-700" : "text-rose-600"}`}>{msg.text}</div> : null}
        {!ocrEnabled ? (
          <div className="mt-2 text-[11px] text-slate-400">
            Scanned PDFs (no embedded text) are routed to review while OCR is off. Set <code>OCR_ENABLED=true</code> to extract them automatically.
          </div>
        ) : null}
      </div>

      {/* The single unified batch progress + review workbench for the active job. */}
      {jobId ? <RenameJobProgress jobId={jobId} /> : null}
    </div>
  );
}
