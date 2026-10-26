"use client";

import { useMemo, useState, useTransition } from "react";
import {
  scanFolderAction,
  renameOneAction,
  startRenameJobAction,
  type FolderScanView,
  type RenameItemView,
} from "@/app/actions/pdf-rename-folders";
import { RenameJobProgress } from "@/components/RenameJobProgress";

export interface RenameFolderInfo {
  name: string;
  fileCount: number;
}

const STATUS_STYLE: Record<string, string> = {
  planned: "bg-sky-100 text-sky-800",
  renamed: "bg-green-100 text-green-800",
  collision: "bg-amber-100 text-amber-800",
  needs_review: "bg-rose-100 text-rose-700",
  skipped: "bg-slate-100 text-slate-500",
};

function StatusChip({ item }: { item: RenameItemView }) {
  const label = item.applied ? "renamed" : item.status;
  return <span className={`inline-block rounded px-2 py-0.5 text-[11px] font-medium ${STATUS_STYLE[label] ?? "bg-slate-100 text-slate-600"}`}>{label.replace("_", " ")}</span>;
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
  const [busy, setBusy] = useState<string>("");
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  // Legacy quick preview (no job).
  const [view, setView] = useState<FolderScanView | null>(null);
  const [query, setQuery] = useState("");

  const selectFolder = (name: string) => {
    setActive(name);
    setJobId(null);
    setView(null);
    setMsg(null);
    setQuery("");
  };

  const runRenameAll = () =>
    start(async () => {
      setBusy("all");
      setMsg(null);
      const res = await startRenameJobAction(active);
      setBusy("");
      if (res.error) { setMsg({ tone: "err", text: res.error }); return; }
      if (res.jobId) {
        setJobId(res.jobId);
        setView(null);
        setMsg({ tone: "ok", text: res.alreadyRunning ? "A job for this folder is already running — showing its progress." : `Started: processing ${res.total ?? 0} PDF(s).` });
      }
    });

  const runScan = () =>
    start(async () => {
      setBusy("scan");
      setMsg(null);
      const res = await scanFolderAction(active);
      setBusy("");
      if (res.error) setMsg({ tone: "err", text: res.error });
      else {
        setView(res);
        setMsg({ tone: "ok", text: `Previewed ${res.summary?.total ?? 0} PDF(s): ${res.summary?.planned ?? 0} ready, ${res.summary?.collision ?? 0} duplicate, ${res.summary?.needsReview ?? 0} need review.` });
      }
    });

  const runRenameOne = (fileName: string) =>
    start(async () => {
      setBusy(fileName);
      const res = await renameOneAction(active, fileName);
      setBusy("");
      if (res.error) { setMsg({ tone: "err", text: res.error }); return; }
      const one = res.items?.[0];
      if (one) {
        setView((prev) => (!prev?.items ? res : { ...prev, items: prev.items.map((it) => (it.originalName === one.originalName ? one : it)) }));
        setMsg(one.applied ? { tone: "ok", text: `Renamed “${one.originalName}” → “${one.newName}”.` } : { tone: "err", text: `“${one.originalName}” not renamed: ${one.reason}` });
      }
    });

  const items = view?.items ?? [];
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((it) => `${it.originalName} ${it.invoiceNumber ?? ""} ${it.newName ?? ""}`.toLowerCase().includes(q));
  }, [items, query]);

  const fileUrl = (name: string, kind: "original" | "renamed", download = false) =>
    `/api/pdf-rename/file?folder=${encodeURIComponent(active)}&name=${encodeURIComponent(name)}&kind=${kind}${download ? "&download=1" : ""}`;

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

      {/* Folder picker + actions */}
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
              {busy === "all" ? "Starting…" : "▶ Rename All PDFs"}
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

      {/* The unified batch progress + review workbench for the active job */}
      {jobId ? <RenameJobProgress jobId={jobId} /> : null}

      {/* Advanced: legacy quick preview (no job, no rename) */}
      {!jobId ? (
        <details className="card p-4">
          <summary className="cursor-pointer text-sm font-semibold text-slate-700">Advanced: quick preview (read-only, no job)</summary>
          <div className="mt-3">
            <button onClick={runScan} disabled={pending} className="btn-ghost text-xs disabled:opacity-40">{busy === "scan" ? "Scanning…" : "🔍 Scan & preview"}</button>
            {view?.items ? (
              <div className="mt-3 overflow-x-auto">
                <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search filename / invoice…" className="mb-2 w-56 rounded-md border border-slate-200 px-2 py-1 text-xs" />
                <table className="w-full text-xs">
                  <thead className="bg-slate-50"><tr>
                    <th className="th">Original</th><th className="th">Invoice No.</th><th className="th">New name</th><th className="th">Type</th><th className="th">Via</th><th className="th">Status</th><th className="th">Notes</th><th className="th">Actions</th>
                  </tr></thead>
                  <tbody>
                    {filtered.map((it) => (
                      <tr key={it.originalName} className="border-t border-slate-100 align-top">
                        <td className="td font-mono">{it.originalName}</td>
                        <td className="td font-mono">{it.invoiceNumber ?? "—"}{it.countryToken ? <span className="text-slate-400"> · {it.countryToken}</span> : null}</td>
                        <td className="td font-mono">{it.newName ?? "—"}</td>
                        <td className="td">{it.docType}</td>
                        <td className="td">{it.source === "ocr" ? "OCR" : it.source === "text" ? "text" : "—"}</td>
                        <td className="td"><StatusChip item={it} /></td>
                        <td className="td max-w-[22rem] text-slate-500">{it.reason}</td>
                        <td className="td whitespace-nowrap">
                          <div className="flex items-center gap-2">
                            <a href={fileUrl(it.originalName, "original")} target="_blank" rel="noreferrer" className="text-sky-700 hover:underline">preview</a>
                            {it.status === "planned" ? (
                              <button onClick={() => runRenameOne(it.originalName)} disabled={pending} className="text-sky-700 hover:underline disabled:text-slate-300">{busy === it.originalName ? "…" : "rename one"}</button>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    ))}
                    {filtered.length === 0 ? <tr><td className="td text-slate-400" colSpan={8}>No files.</td></tr> : null}
                  </tbody>
                </table>
              </div>
            ) : null}
          </div>
        </details>
      ) : null}
    </div>
  );
}
