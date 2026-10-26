"use client";

/**
 * PDF File Rename — LOCAL-folder workflow (the user's own computer).
 *
 * Browser security: a web server cannot reach a folder on the user's PC. So this
 * flow is CLIENT-SIDE. On Chromium (File System Access API) we open the native
 * folder picker, read each PDF locally, deep-analyze it on the server (bytes
 * only — same extraction/OCR/validation the server-folder job uses), then write
 * the renamed COPIES back into an "UCP Renamed" sub-folder of the chosen folder
 * (originals preserved, never overwritten). Where the API is unavailable we fall
 * back to a folder upload that returns a ZIP of the renamed copies to download.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const OUTPUT_SUBDIR = "UCP Renamed";
const SCAN_CONCURRENCY = 4;

// --- Minimal File System Access API typings (not in all TS lib.dom versions) --
interface FsWritable { write(data: BufferSource | Blob): Promise<void>; close(): Promise<void> }
interface FsFileHandle { kind: "file"; name: string; getFile(): Promise<File>; createWritable(): Promise<FsWritable> }
interface FsDirHandle {
  kind: "directory"; name: string;
  values(): AsyncIterableIterator<FsFileHandle | FsDirHandle>;
  getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<FsDirHandle>;
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<FsFileHandle>;
}
function getDirectoryPicker(): ((opts?: { mode?: "read" | "readwrite" }) => Promise<FsDirHandle>) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { showDirectoryPicker?: (opts?: { mode?: "read" | "readwrite" }) => Promise<FsDirHandle> };
  return typeof w.showDirectoryPicker === "function" ? w.showDirectoryPicker.bind(window) : null;
}

interface Analysis {
  originalName: string;
  docType: string;
  invoiceNumber: string | null;
  proposedName: string | null;
  confidence: number;
  decision: string; // RENAME | REVIEW
  reviewReason: string;
  reasonText: string;
  source: string;
  pages: number;
}
type RowState = "pending" | "scanned" | "renamed" | "review" | "failed";
interface Row extends Partial<Analysis> {
  key: string;
  path: string;
  size: number;
  selected: boolean;
  state: RowState;
  finalName?: string;
  stateMsg?: string;
  handle?: FsFileHandle; // FS Access mode
  file?: File; // upload fallback mode
}
interface HistoryEntry { at: string; folder: string; total: number; renamed: number; review: number; failed: number; mode: string }

const HISTORY_KEY = "ucp.pdfrename.local.history";

function loadHistory(): HistoryEntry[] {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]") as HistoryEntry[]; } catch { return []; }
}
function saveHistory(list: HistoryEntry[]) {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, 25))); } catch { /* storage may be unavailable */ }
}
function reviewName(): string { return `REVIEW_REQUIRED_${Math.random().toString(16).slice(2, 8)}.pdf`; }

function Stat({ label, value, accent }: { label: string; value: string | number; accent: string }) {
  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
      <div className="p-3"><div className="text-[11px] font-medium uppercase tracking-wide text-slate-400">{label}</div><div className="mt-1 text-2xl font-semibold text-slate-800">{value}</div></div>
      <div className={`h-1 w-full ${accent}`} />
    </div>
  );
}

export function LocalFolderRename() {
  // Client-only values (File System Access support + localStorage history) are
  // resolved AFTER mount so the server render and first client render match
  // (avoids a hydration mismatch). `mounted` gates the support-dependent UI.
  const [mounted, setMounted] = useState(false);
  const [fsaPicker, setFsaPicker] = useState<ReturnType<typeof getDirectoryPicker>>(null);
  const [dirHandle, setDirHandle] = useState<FsDirHandle | null>(null);
  const [folderName, setFolderName] = useState<string>("");
  const [rows, setRows] = useState<Row[]>([]);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [busy, setBusy] = useState<"" | "scan" | "rename">("");
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const uploadRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setMounted(true);
    setFsaPicker(() => getDirectoryPicker());
    setHistory(loadHistory());
  }, []);

  const addLog = useCallback((s: string) => setLog((l) => [...l.slice(-199), `${new Date().toLocaleTimeString()}  ${s}`]), []);

  const reset = () => { setRows([]); setMsg(null); setLog([]); setProgress(null); setQuery(""); setFilter("all"); };

  // --- Folder selection --------------------------------------------------
  const pickViaFsa = async () => {
    if (!fsaPicker) return;
    try {
      const handle = await fsaPicker({ mode: "readwrite" });
      reset();
      setDirHandle(handle);
      setFolderName(handle.name);
      const found = await collectHandles(handle);
      setRows(found.map((f, i) => ({ key: `h${i}:${f.path}`, path: f.path, size: 0, selected: true, state: "pending", handle: f.handle })));
      addLog(`Selected folder “${handle.name}” — ${found.length} PDF(s) found on your computer.`);
      setMsg({ tone: "ok", text: `“${handle.name}” selected: ${found.length} PDF(s). Click Scan & Preview.` });
    } catch (e) {
      if ((e as Error)?.name !== "AbortError") setMsg({ tone: "err", text: `Could not open the folder: ${(e as Error).message}` });
    }
  };

  const pickViaUpload = (files: FileList | null) => {
    if (!files) return;
    const pdfs = Array.from(files).filter((f) => f.name.toLowerCase().endsWith(".pdf") && !f.webkitRelativePath.includes(`/${OUTPUT_SUBDIR}/`));
    reset();
    setDirHandle(null);
    const first = pdfs[0]?.webkitRelativePath?.split("/")[0] ?? "Selected folder";
    setFolderName(first);
    setRows(pdfs.map((f, i) => ({ key: `u${i}:${f.webkitRelativePath || f.name}`, path: f.webkitRelativePath || f.name, size: f.size, selected: true, state: "pending", file: f })));
    addLog(`Selected folder “${first}” — ${pdfs.length} PDF(s) (upload mode).`);
    setMsg({ tone: "ok", text: `“${first}” selected: ${pdfs.length} PDF(s). Click Scan & Preview.` });
  };

  async function collectHandles(dir: FsDirHandle, base = "", out: { handle: FsFileHandle; path: string }[] = []): Promise<{ handle: FsFileHandle; path: string }[]> {
    for await (const entry of dir.values()) {
      if (entry.kind === "directory") {
        if (entry.name === OUTPUT_SUBDIR || entry.name.startsWith(".")) continue;
        await collectHandles(entry, base ? `${base}/${entry.name}` : entry.name, out);
      } else if (entry.name.toLowerCase().endsWith(".pdf")) {
        out.push({ handle: entry, path: base ? `${base}/${entry.name}` : entry.name });
      }
    }
    return out.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
  }

  // --- Scan & preview ----------------------------------------------------
  async function analyzeOne(bytes: Blob, name: string): Promise<Analysis> {
    const res = await fetch("/api/pdf-rename/analyze", { method: "POST", headers: { "x-filename": encodeURIComponent(name).replace(/%20/g, " ") }, body: bytes });
    if (!res.ok) {
      const j = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error((j as { error?: string }).error || `HTTP ${res.status}`);
    }
    return (await res.json()) as Analysis;
  }

  const runScan = async () => {
    if (rows.length === 0) return;
    setBusy("scan");
    setMsg(null);
    const total = rows.length;
    setProgress({ done: 0, total });
    addLog(`Scanning ${total} PDF(s) — deep extraction + OCR on the server (bytes only).`);
    let done = 0;
    const next = [...rows];
    const idxQueue = next.map((_, i) => i);
    let cursor = 0;
    const worker = async () => {
      while (cursor < idxQueue.length) {
        const i = idxQueue[cursor++];
        const r = next[i];
        try {
          const blob = r.handle ? await r.handle.getFile() : r.file!;
          const a = await analyzeOne(blob, r.path.split("/").pop() || r.path);
          next[i] = { ...r, ...a, state: "scanned" };
        } catch (e) {
          next[i] = { ...r, decision: "REVIEW", reviewReason: "PDF_UNREADABLE_OR_CORRUPTED", reasonText: (e as Error).message, state: "scanned", proposedName: null, invoiceNumber: null, confidence: 0 };
        }
        done++;
        setProgress({ done, total });
        if (done % 5 === 0 || done === total) setRows([...next]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(SCAN_CONCURRENCY, total) }, worker));
    setRows([...next]);
    setBusy("");
    const willRename = next.filter((r) => r.decision === "RENAME").length;
    addLog(`Scan complete: ${willRename} ready to rename, ${total - willRename} need review. No files changed.`);
    setMsg({ tone: "ok", text: `Scanned ${total} PDF(s): ${willRename} ready, ${total - willRename} need review. No files changed.` });
  };

  // --- Rename ------------------------------------------------------------
  const runRename = async (onlySelected: boolean) => {
    const targets = rows.map((r, i) => ({ r, i })).filter(({ r }) => r.state === "scanned" || r.state === "review" || r.state === "failed").filter(({ r }) => (onlySelected ? r.selected : true));
    if (targets.length === 0) { setMsg({ tone: "err", text: "Nothing to rename — scan first, then select files." }); return; }
    setBusy("rename");
    setMsg(null);

    if (dirHandle) {
      // FS Access: write renamed copies into the output sub-folder on the user's disk.
      setProgress({ done: 0, total: targets.length });
      addLog(`Renaming ${targets.length} file(s) into “${folderName}/${OUTPUT_SUBDIR}/” (copies; originals preserved).`);
      let out: FsDirHandle;
      try { out = await dirHandle.getDirectoryHandle(OUTPUT_SUBDIR, { create: true }); }
      catch (e) { setBusy(""); setMsg({ tone: "err", text: `Could not create the output folder: ${(e as Error).message}` }); return; }
      const used = new Set<string>();
      const next = [...rows];
      let done = 0, renamed = 0, review = 0, failed = 0;
      for (const { r, i } of targets) {
        try {
          const file = r.handle ? await r.handle.getFile() : r.file!;
          const bytes = await file.arrayBuffer();
          let finalName: string; let state: RowState;
          if (r.decision === "RENAME" && r.proposedName) {
            finalName = await dedupeName(out, r.proposedName, used);
            state = "renamed"; renamed++;
          } else {
            finalName = await dedupeName(out, reviewName(), used);
            state = "review"; review++;
          }
          await writeInto(out, finalName, bytes);
          next[i] = { ...r, state, finalName, stateMsg: state === "renamed" ? `→ ${finalName}` : `${r.reviewReason || "review"} → ${finalName}` };
          addLog(`${state === "renamed" ? "Renamed" : "Flagged"} ${r.path} → ${finalName}`);
        } catch (e) {
          failed++;
          next[i] = { ...r, state: "failed", stateMsg: (e as Error).message };
          addLog(`FAILED ${r.path}: ${(e as Error).message}`);
        }
        done++; setProgress({ done, total: targets.length }); setRows([...next]);
      }
      setBusy("");
      pushHistory({ folder: folderName, total: targets.length, renamed, review, failed, mode: "local (write-back)" });
      setMsg({ tone: "ok", text: `Done: ${renamed} renamed, ${review} review, ${failed} failed → “${folderName}/${OUTPUT_SUBDIR}/”. Originals untouched.` });
      return;
    }

    // Upload fallback: package renamed copies into a ZIP for download.
    try {
      addLog(`Building a renamed ZIP for ${targets.length} file(s) (upload mode — your originals are not modified).`);
      const fd = new FormData();
      const names: Record<string, string> = {};
      const usedZip = new Set<string>();
      for (const { r } of targets) {
        if (!r.file) continue;
        const base = r.decision === "RENAME" && r.proposedName ? r.proposedName : reviewName();
        let nm = base; let n = 2;
        while (usedZip.has(nm.toLowerCase())) { const d = base.lastIndexOf("."); nm = `${base.slice(0, d)}-${n++}${base.slice(d)}`; }
        usedZip.add(nm.toLowerCase());
        names[r.file.name] = nm;
        fd.append("files", r.file, r.file.name);
      }
      fd.append("names", JSON.stringify(names));
      const res = await fetch("/api/pdf-rename/rename-zip", { method: "POST", body: fd });
      if (!res.ok) { const j = await res.json().catch(() => ({ error: `HTTP ${res.status}` })); throw new Error((j as { error?: string }).error || `HTTP ${res.status}`); }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = "UCP Renamed.zip"; a.click(); URL.revokeObjectURL(url);
      setBusy("");
      const renamed = targets.filter(({ r }) => r.decision === "RENAME").length;
      pushHistory({ folder: folderName, total: targets.length, renamed, review: targets.length - renamed, failed: 0, mode: "local (ZIP download)" });
      setMsg({ tone: "ok", text: `Downloaded “UCP Renamed.zip” with ${targets.length} renamed copy(ies). Your original files are unchanged.` });
    } catch (e) {
      setBusy(""); setMsg({ tone: "err", text: `ZIP build failed: ${(e as Error).message}` });
    }
  };

  async function exists(dir: FsDirHandle, name: string): Promise<boolean> {
    try { await dir.getFileHandle(name); return true; } catch { return false; }
  }
  async function dedupeName(dir: FsDirHandle, name: string, used: Set<string>): Promise<string> {
    const d = name.lastIndexOf("."); const stem = d > 0 ? name.slice(0, d) : name; const ext = d > 0 ? name.slice(d) : ".pdf";
    let candidate = name; let n = 2;
    while (used.has(candidate.toLowerCase()) || (await exists(dir, candidate))) candidate = `${stem}-${n++}${ext}`;
    used.add(candidate.toLowerCase());
    return candidate;
  }
  async function writeInto(dir: FsDirHandle, name: string, data: ArrayBuffer): Promise<void> {
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(data);
    await w.close();
  }

  const pushHistory = (e: Omit<HistoryEntry, "at">) => {
    setHistory((prev) => { const nextH = [{ at: new Date().toISOString(), ...e }, ...prev].slice(0, 25); saveHistory(nextH); return nextH; });
  };

  // --- Derived ------------------------------------------------------------
  const scanned = rows.some((r) => r.state !== "pending");
  const total = rows.length;
  const renamedCount = rows.filter((r) => r.state === "renamed").length;
  const reviewCount = rows.filter((r) => r.state === "review" || (r.state === "scanned" && r.decision === "REVIEW")).length;
  const selectedCount = rows.filter((r) => r.selected).length;
  const allSelected = total > 0 && selectedCount === total;
  const pct = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (filter === "rename" && r.decision !== "RENAME") return false;
      if (filter === "review" && r.decision !== "REVIEW") return false;
      if (filter === "renamed" && r.state !== "renamed") return false;
      if (!q) return true;
      return `${r.path} ${r.invoiceNumber ?? ""} ${r.proposedName ?? ""}`.toLowerCase().includes(q);
    });
  }, [rows, query, filter]);

  const toggleAll = (on: boolean) => setRows((rs) => rs.map((r) => ({ ...r, selected: on })));
  const toggleOne = (key: string, on: boolean) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, selected: on } : r)));

  return (
    <div className="space-y-5">
      {/* Folder selection */}
      <div className="card space-y-4 p-5">
        <div className="rounded-xl border-2 border-dashed border-slate-200 bg-slate-50/60 p-7 text-center">
          <svg width="34" height="34" viewBox="0 0 24 24" fill="none" className="mx-auto text-ananta" aria-hidden><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /></svg>
          <div className="mt-2 text-sm font-semibold text-slate-800">Select a folder on your computer</div>
          <p className="mx-auto mt-1 max-w-md text-xs text-slate-500">
            Choose any local folder containing PDFs — other drives and network-mapped folders too, subject to your OS permissions. Files stay on your computer; only the bytes needed to read the invoice number are sent for extraction.
          </p>
          {!mounted ? (
            <button disabled className="btn-primary mt-3 rounded-full px-5 text-xs opacity-60">📁 Select Local Folder</button>
          ) : fsaPicker ? (
            <button onClick={pickViaFsa} className="btn-primary mt-3 rounded-full px-5 text-xs">📁 Browse / Select Local Folder</button>
          ) : (
            <div className="mt-3">
              <button onClick={() => uploadRef.current?.click()} className="btn-primary rounded-full px-5 text-xs">📁 Select Local Folder</button>
              <input ref={uploadRef} type="file" className="hidden" multiple onChange={(e) => pickViaUpload(e.target.files)}
                // @ts-expect-error non-standard directory attributes for folder upload
                webkitdirectory="" directory="" />
              <div className="mt-2 text-[11px] text-amber-600">Your browser doesn’t support in-place folder writes; renamed files are provided as a ZIP download instead.</div>
            </div>
          )}
          {folderName ? <div className="mx-auto mt-3 inline-flex items-center gap-2 rounded-md bg-white px-3 py-1.5 text-xs font-medium text-slate-700 ring-1 ring-slate-200">📂 {folderName} · {total} PDF(s)</div> : null}
          <div className="mt-3 text-[11px] text-slate-400">PDF files only · Preserve original PDF content</div>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <Stat label="Total PDFs" value={total || "—"} accent="bg-slate-300" />
          <Stat label="Renamed" value={scanned ? renamedCount : "—"} accent="bg-emerald-400" />
          <Stat label="Need review" value={scanned ? reviewCount : "—"} accent="bg-rose-400" />
        </div>

        <div className="border-t border-slate-100 pt-3">
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={runScan} disabled={busy !== "" || total === 0} className="btn-ghost text-xs disabled:opacity-40">{busy === "scan" ? `Scanning… ${pct}%` : "🔍 Scan & Preview"}</button>
            <button onClick={() => runRename(true)} disabled={busy !== "" || !scanned || selectedCount === 0} className="btn-primary text-xs disabled:opacity-40">{busy === "rename" ? "Renaming…" : `▶ Rename Selected (${selectedCount})`}</button>
            <button onClick={() => runRename(false)} disabled={busy !== "" || !scanned} className="btn-ghost text-xs disabled:opacity-40">▶ Rename All</button>
            <span className="ml-auto text-[11px] text-slate-400">{dirHandle ? "Renamed copies write into an “UCP Renamed” sub-folder; originals preserved." : fsaPicker ? "" : "Upload mode: renamed copies download as a ZIP."}</span>
          </div>
          {!scanned ? <div className="mt-2 text-[11px] text-slate-400">Actions become available after a folder is selected and scanned.</div> : null}
          {progress && busy ? (
            <div className="mt-3">
              <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${pct}%` }} /></div>
              <div className="mt-1 text-[11px] text-slate-500">{busy === "scan" ? "Scanning" : "Renaming"} {progress.done}/{progress.total} · {pct}%</div>
            </div>
          ) : null}
          {msg ? <div className={`mt-2 text-sm ${msg.tone === "ok" ? "text-emerald-700" : "text-rose-600"}`}>{msg.text}</div> : null}
        </div>
      </div>

      {/* Files table */}
      {total > 0 ? (
        <div className="card p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm font-semibold text-slate-800">Files ({filtered.length}{filtered.length !== total ? ` of ${total}` : ""})</div>
            <div className="flex items-center gap-2">
              <select value={filter} onChange={(e) => setFilter(e.target.value)} className="rounded border border-slate-200 px-2 py-1 text-xs">
                <option value="all">All</option><option value="rename">Will rename</option><option value="review">Needs review</option><option value="renamed">Renamed</option>
              </select>
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search filename / invoice…" className="w-56 rounded border border-slate-200 px-2 py-1 text-xs" />
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full whitespace-nowrap text-xs">
              <thead className="bg-slate-50 text-slate-500"><tr>
                <th className="px-3 py-1.5 text-left"><input type="checkbox" checked={allSelected} onChange={(e) => toggleAll(e.target.checked)} aria-label="Select all" /></th>
                <th className="px-3 py-1.5 text-left font-semibold">File</th>
                <th className="px-3 py-1.5 text-left font-semibold">Invoice No.</th>
                <th className="px-3 py-1.5 text-left font-semibold">Proposed name</th>
                <th className="px-3 py-1.5 text-left font-semibold">Conf.</th>
                <th className="px-3 py-1.5 text-left font-semibold">Via</th>
                <th className="px-3 py-1.5 text-left font-semibold">Status</th>
              </tr></thead>
              <tbody>
                {filtered.map((r) => (
                  <tr key={r.key} className="border-t border-slate-100">
                    <td className="px-3 py-1.5"><input type="checkbox" checked={r.selected} onChange={(e) => toggleOne(r.key, e.target.checked)} aria-label={`Select ${r.path}`} /></td>
                    <td className="px-3 py-1.5 font-mono max-w-[240px] truncate" title={r.path}>{r.path}</td>
                    <td className="px-3 py-1.5 font-mono">{r.invoiceNumber || "—"}</td>
                    <td className="px-3 py-1.5 font-mono">{r.finalName || r.proposedName || "—"}</td>
                    <td className="px-3 py-1.5">{r.confidence ? `${Math.round(r.confidence * 100)}%` : "—"}</td>
                    <td className="px-3 py-1.5">{!r.source || r.source === "none" ? "—" : r.source}</td>
                    <td className="px-3 py-1.5">
                      {r.state === "pending" ? <span className="text-slate-400">—</span>
                        : r.state === "renamed" ? <span className="badge bg-emerald-50 text-emerald-700 ring-1 ring-emerald-600/15" title={r.stateMsg}>renamed</span>
                        : r.state === "failed" ? <span className="badge bg-rose-50 text-rose-700 ring-1 ring-rose-600/15" title={r.stateMsg}>failed</span>
                        : r.decision === "RENAME" ? <span className="badge bg-emerald-50 text-emerald-700 ring-1 ring-emerald-600/15">will rename</span>
                        : <span className="badge bg-amber-50 text-amber-700 ring-1 ring-amber-600/20" title={r.reasonText}>{r.reviewReason || "review"}</span>}
                    </td>
                  </tr>
                ))}
                {filtered.length === 0 ? <tr><td className="px-3 py-3 text-slate-400" colSpan={7}>No files match.</td></tr> : null}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {/* Live log */}
      {log.length > 0 ? (
        <div className="card p-4">
          <div className="mb-2 text-sm font-semibold text-slate-800">Processing log</div>
          <div className="max-h-56 space-y-0.5 overflow-y-auto rounded-lg border border-slate-100 bg-slate-50/60 p-3 font-mono text-[11px] text-slate-600">
            {log.slice().reverse().map((l, i) => <div key={i}>{l}</div>)}
          </div>
        </div>
      ) : null}

      {/* History (this browser) */}
      <div className="card p-4">
        <div className="mb-1 flex items-center gap-2">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="text-slate-400" aria-hidden><path d="M3 12a9 9 0 1 0 3-6.7M3 4v4h4M12 7v5l3 2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
          <div className="text-sm font-semibold text-slate-800">Rename History</div>
        </div>
        <p className="mb-3 text-xs text-slate-500">Recent local rename runs (stored in this browser).</p>
        {history.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-200 p-5 text-center text-sm text-slate-400">No local runs yet — select a folder and rename.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full whitespace-nowrap text-xs">
              <thead className="bg-slate-50 text-slate-500"><tr>
                <th className="px-3 py-1.5 text-left font-semibold">Date</th><th className="px-3 py-1.5 text-left font-semibold">Folder</th>
                <th className="px-3 py-1.5 text-left font-semibold">Result (renamed / review / failed)</th><th className="px-3 py-1.5 text-left font-semibold">Mode</th>
              </tr></thead>
              <tbody>
                {history.map((h, i) => (
                  <tr key={i} className="border-t border-slate-100">
                    <td className="px-3 py-1.5 text-slate-600">{h.at.slice(0, 16).replace("T", " ")}</td>
                    <td className="px-3 py-1.5 max-w-[220px] truncate" title={h.folder}>{h.folder}</td>
                    <td className="px-3 py-1.5"><span className="text-emerald-700">{h.renamed}</span> / <span className="text-amber-700">{h.review}</span> / <span className="text-rose-700">{h.failed}</span></td>
                    <td className="px-3 py-1.5 text-slate-500">{h.mode}</td>
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
