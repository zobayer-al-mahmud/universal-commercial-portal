"use client";

import { useMemo, useState, useTransition } from "react";
import {
  scanFolderAction,
  renameAllAction,
  renameOneAction,
  type FolderScanView,
  type RenameItemView,
} from "@/app/actions/pdf-rename-folders";

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
  const [view, setView] = useState<FolderScanView | null>(null);
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<string>(""); // "", "scan", "all", or a file name
  const [query, setQuery] = useState("");
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  const selectFolder = (name: string) => {
    setActive(name);
    setView(null);
    setMsg(null);
    setQuery("");
  };

  const runScan = () =>
    start(async () => {
      setBusy("scan");
      setMsg(null);
      const res = await scanFolderAction(active);
      setBusy("");
      if (res.error) setMsg({ tone: "err", text: res.error });
      else {
        setView(res);
        setMsg({ tone: "ok", text: `Scanned ${res.summary?.total ?? 0} PDF(s): ${res.summary?.planned ?? 0} ready, ${res.summary?.collision ?? 0} duplicate, ${res.summary?.needsReview ?? 0} need review.` });
      }
    });

  const runRenameAll = () =>
    start(async () => {
      setBusy("all");
      setMsg(null);
      const res = await renameAllAction(active);
      setBusy("");
      if (res.error) setMsg({ tone: "err", text: res.error });
      else {
        setView(res);
        const a = res.applied;
        setMsg({ tone: "ok", text: `Renamed ${a?.renamed ?? 0} file(s) into “${outputSubdir}”. ${a?.targetExists ?? 0} already existed, ${res.summary?.collision ?? 0} duplicate, ${res.summary?.needsReview ?? 0} need review.` });
      }
    });

  const runRenameOne = (fileName: string) =>
    start(async () => {
      setBusy(fileName);
      setMsg(null);
      const res = await renameOneAction(active, fileName);
      setBusy("");
      if (res.error) {
        setMsg({ tone: "err", text: res.error });
        return;
      }
      // Merge the single result into the current view (if any).
      const one = res.items?.[0];
      if (one) {
        setView((prev) => {
          if (!prev?.items) return res;
          return { ...prev, items: prev.items.map((it) => (it.originalName === one.originalName ? one : it)) };
        });
        setMsg(
          one.applied
            ? { tone: "ok", text: `Renamed “${one.originalName}” → “${one.newName}”.` }
            : { tone: "err", text: `“${one.originalName}” not renamed: ${one.reason}` },
        );
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

      {/* Folder picker */}
      <div className="card p-4">
        <div className="mb-3 text-sm font-semibold text-slate-800">Dedicated folders</div>
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
            <button onClick={runScan} disabled={pending} className="btn-ghost text-xs disabled:opacity-40">
              {busy === "scan" ? "Scanning…" : "🔍 Scan & preview"}
            </button>
            <button onClick={runRenameAll} disabled={pending} className="btn-primary text-xs disabled:opacity-40">
              {busy === "all" ? "Renaming…" : "▶ Rename All PDFs"}
            </button>
            <a href={`/api/pdf-rename/zip?folder=${encodeURIComponent(active)}`} className="btn-ghost text-xs">⬇ Download renamed (ZIP)</a>
            <span className="ml-auto text-[11px] text-slate-400">
              Output → <code>{active}/{outputSubdir}/</code> · OCR {ocrEnabled ? "enabled" : "disabled"}
            </span>
          </div>
        ) : null}
        {msg ? <div className={`mt-3 text-sm ${msg.tone === "ok" ? "text-green-700" : "text-rose-600"}`}>{msg.text}</div> : null}
        {!ocrEnabled ? (
          <div className="mt-2 text-[11px] text-slate-400">
            Scanned PDFs (no embedded text) are routed to manual review while OCR is off. Set <code>OCR_ENABLED=true</code> to extract them automatically.
          </div>
        ) : null}
      </div>

      {/* Results */}
      {view?.items ? (
        <div className="card">
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
            <h3 className="text-sm font-semibold text-slate-700">
              {active} — {items.length} file(s)
            </h3>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search filename / invoice…"
              className="w-56 rounded-md border border-slate-200 px-2 py-1 text-xs"
            />
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-50">
                <tr>
                  <th className="th">Original filename</th>
                  <th className="th">Invoice No.</th>
                  <th className="th">New filename</th>
                  <th className="th">Type</th>
                  <th className="th">Read via</th>
                  <th className="th">Status</th>
                  <th className="th">Notes</th>
                  <th className="th">Actions</th>
                </tr>
              </thead>
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
                        {it.applied && it.newName ? (
                          <a href={fileUrl(it.newName, "renamed", true)} className="text-sky-700 hover:underline">⬇ renamed</a>
                        ) : null}
                        {(it.status === "planned" || it.status === "collision") ? (
                          <button
                            onClick={() => runRenameOne(it.originalName)}
                            disabled={pending || it.status === "collision"}
                            title={it.status === "collision" ? "Resolve the duplicate invoice first" : "Rename this one PDF"}
                            className="text-sky-700 hover:underline disabled:text-slate-300"
                          >
                            {busy === it.originalName ? "…" : "rename one"}
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
                {filtered.length === 0 ? (
                  <tr><td className="td text-slate-400" colSpan={8}>{items.length === 0 ? "No files." : `No files match “${query}”.`}</td></tr>
                ) : null}
              </tbody>
            </table>
          </div>
          <div className="border-t border-slate-100 px-4 py-2 text-[11px] text-slate-400">
            Renaming copies the file to <code>{active}/{outputSubdir}/&lt;invoice&gt;.pdf</code> — the original and its page layout are never changed, and an
            existing target is never overwritten. Duplicate invoice numbers and unreadable files are flagged for manual review, not renamed.
          </div>
        </div>
      ) : null}
    </div>
  );
}
