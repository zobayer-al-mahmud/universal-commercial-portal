"use client";

/**
 * PDF File Rename — LOCAL-folder workflow (the user's own computer).
 *
 * Browser security: a web server cannot reach a folder on the user's PC. So this
 * flow is CLIENT-SIDE, and the OUTPUT method is chosen from the browser's own
 * capabilities (detected at mount — never by browser name):
 *   • Chrome/Edge (File System Access API, secure context): the native folder
 *     picker opens, each PDF is read locally and deep-analysed on the server
 *     (bytes only — same extraction/OCR/validation the server-folder job uses),
 *     then a renamed COPY is written directly into an "UCP Renamed" sub-folder of
 *     the chosen folder, mirroring the source folder structure. No ZIP download.
 *   • Firefox/Safari/other (or a non-secure context): a folder upload returns the
 *     renamed copies as an "UCP Renamed.zip" download — the best method those
 *     browsers support.
 * In EVERY mode the original PDFs are only read, never modified or overwritten;
 * invoice numbers are never invented (files that can't be read are left for manual
 * rename). Any modern browser can use the module.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const OUTPUT_SUBDIR = "UCP Renamed";
const SCAN_CONCURRENCY = 4;

// --- Rename-by field options (feature 1) -----------------------------------
type FieldKind = "invoice" | "fcr" | "container" | "exp" | "custom";
const RENAME_BY_OPTIONS: { value: FieldKind; label: string }[] = [
  { value: "invoice", label: "Invoice Number" },
  { value: "fcr", label: "FCR Number" },
  { value: "container", label: "Container Number" },
  { value: "exp", label: "EXP Number" },
  { value: "custom", label: "Custom Field" },
];
const FIELD_HEADER: Record<FieldKind, string> = {
  invoice: "Invoice No.", fcr: "FCR No.", container: "Container No.", exp: "EXP No.", custom: "Custom value",
};
const NOT_FOUND_LABEL: Record<FieldKind, string> = {
  invoice: "invoice number", fcr: "FCR number", container: "container number", exp: "EXP number", custom: "custom value",
};

/** One extracted field as returned by /api/pdf-rename/analyze. */
interface ServerFieldValue { value: string | null; key?: string | null; confidence: number; source: string; evidence?: string; label?: string; page?: number }
interface ServerFields {
  invoice: ServerFieldValue; fcr: ServerFieldValue; container: ServerFieldValue; exp: ServerFieldValue; custom: ServerFieldValue | null;
}
interface SelectedView {
  extractedValue: string | null; proposedName: string | null; decision: "RENAME" | "REVIEW";
  confidence: number; source: string; reviewReason: string; reasonText: string;
}

/** Re-derive the selected-field view from the already-scanned field set — so
 *  switching Invoice→FCR→Container→EXP never needs a re-scan. (Custom still needs
 *  a scan with its label; handled by the caller.) Mirrors the server's logic. */
function deriveSelected(fields: ServerFields | undefined, renameBy: FieldKind, minConf: number): SelectedView | null {
  if (!fields) return null;
  const review = (reason: string, text: string, val: string | null = null, conf = 0, src = "none"): SelectedView =>
    ({ extractedValue: val, proposedName: null, decision: "REVIEW", confidence: conf, source: src, reviewReason: reason, reasonText: text });
  if (renameBy === "invoice") {
    const f = fields.invoice;
    if (f?.key) return { extractedValue: f.value ?? null, proposedName: `${f.key}.pdf`, decision: "RENAME", confidence: f.confidence, source: f.source, reviewReason: "", reasonText: f.label ?? "" };
    return review("INVOICE_NUMBER_NOT_FOUND", "No credible invoice number was read from this PDF.");
  }
  const f = renameBy === "fcr" ? fields.fcr : renameBy === "container" ? fields.container : renameBy === "exp" ? fields.exp : fields.custom;
  if (!f || !f.value) return review(`${renameBy.toUpperCase()}_NOT_FOUND`, `No credible ${NOT_FOUND_LABEL[renameBy]} could be read from this PDF.`);
  const stem = toStem(f.value);
  if (!stem) return review(`${renameBy.toUpperCase()}_NOT_FOUND`, `No usable ${NOT_FOUND_LABEL[renameBy]} after cleaning the value.`);
  if (f.confidence > 0 && f.confidence < minConf)
    return review("LOW_CONFIDENCE", `${FIELD_HEADER[renameBy]} “${f.value}” read at ${Math.round(f.confidence * 100)}% (below the ${Math.round(minConf * 100)}% threshold).`, f.value, f.confidence, f.source);
  return { extractedValue: f.value, proposedName: `${stem}.pdf`, decision: "RENAME", confidence: f.confidence, source: f.source, reviewReason: "", reasonText: f.label ?? "" };
}

// --- Minimal File System Access API typings (not in all TS lib.dom versions) --
type FsPermissionState = "granted" | "denied" | "prompt";
interface FsWritable { write(data: BufferSource | Blob): Promise<void>; close(): Promise<void> }
interface FsFileHandle {
  kind: "file"; name: string; getFile(): Promise<File>; createWritable(): Promise<FsWritable>;
}
interface FsDirHandle {
  kind: "directory"; name: string;
  values(): AsyncIterableIterator<FsFileHandle | FsDirHandle>;
  getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<FsDirHandle>;
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<FsFileHandle>;
  removeEntry(name: string, opts?: { recursive?: boolean }): Promise<void>;
  // Permission API (Chromium): verify/request read-write access to the handle.
  queryPermission?(opts?: { mode?: "read" | "readwrite" }): Promise<FsPermissionState>;
  requestPermission?(opts?: { mode?: "read" | "readwrite" }): Promise<FsPermissionState>;
}
function getDirectoryPicker(): ((opts?: { mode?: "read" | "readwrite" }) => Promise<FsDirHandle>) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { showDirectoryPicker?: (opts?: { mode?: "read" | "readwrite" }) => Promise<FsDirHandle> };
  return typeof w.showDirectoryPicker === "function" ? w.showDirectoryPicker.bind(window) : null;
}
/** Why the native folder picker is unavailable, so the UI can say something true.
 *  Chromium only exposes showDirectoryPicker in a SECURE CONTEXT (https:// or
 *  localhost). Served over plain http:// on a LAN IP it is absent even in
 *  Chrome/Edge — that is a connection issue, not a browser-support one. */
function folderWriteUnavailableReason(): "" | "insecure-context" | "unsupported" {
  if (typeof window === "undefined") return "";
  if (getDirectoryPicker()) return "";
  return window.isSecureContext ? "unsupported" : "insecure-context";
}
/** Verify (and if needed request) read-write permission on a directory handle
 *  BEFORE writing. Returns false when the user denies — the caller then falls
 *  back to the ZIP download. Older implementations without the permission API
 *  are treated as granted (the readwrite picker already gated access). */
async function ensureWritePermission(handle: FsDirHandle): Promise<boolean> {
  try {
    if (typeof handle.queryPermission === "function") {
      if ((await handle.queryPermission({ mode: "readwrite" })) === "granted") return true;
    }
    if (typeof handle.requestPermission === "function") {
      return (await handle.requestPermission({ mode: "readwrite" })) === "granted";
    }
    return true;
  } catch {
    return false;
  }
}

interface Analysis {
  originalName: string;
  docType: string;
  invoiceNumber: string | null;
  extractedValue?: string | null; // value of the SELECTED field
  proposedName: string | null;
  confidence: number;
  decision: string; // RENAME | REVIEW
  reviewReason: string;
  reasonText: string;
  source: string;
  pages: number;
  renameBy?: FieldKind;
  minConfidence?: number;
  fields?: ServerFields | null; // every extracted field (for field switching + Excel)
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
  corrected?: boolean; // final name was set/confirmed by a manual rename
  handle?: FsFileHandle; // FS Access mode
  dir?: FsDirHandle; // the file's OWN parent directory (for in-place rename)
  file?: File; // upload fallback mode
  /** The custom label this row was scanned with (so a label change triggers a re-scan). */
  scannedCustomLabel?: string;
}
interface HistoryEntry { at: string; folder: string; total: number; renamed: number; review: number; failed: number; mode: string }
/** One manual correction, kept so the UI, the output folder and the log agree. */
interface CorrectionEntry { at: string; folder: string; path: string; from: string; to: string; action: string }

const HISTORY_KEY = "ucp.pdfrename.local.history";
const CORR_KEY = "ucp.pdfrename.local.corrections"; // folder\0path -> {invoice, finalName, at}
const CORRLOG_KEY = "ucp.pdfrename.local.corrections.log";

function loadHistory(): HistoryEntry[] {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]") as HistoryEntry[]; } catch { return []; }
}
function saveHistory(list: HistoryEntry[]) {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, 25))); } catch { /* storage may be unavailable */ }
}

type CorrMap = Record<string, { invoice: string; finalName: string; at: string }>;
const corrKey = (folder: string, path: string) => `${folder}\u0000${path}`;
function loadCorrections(): CorrMap {
  try { return JSON.parse(localStorage.getItem(CORR_KEY) || "{}") as CorrMap; } catch { return {}; }
}
function saveCorrections(map: CorrMap) {
  try { localStorage.setItem(CORR_KEY, JSON.stringify(map)); } catch { /* storage may be unavailable */ }
}
function loadCorrLog(): CorrectionEntry[] {
  try { return JSON.parse(localStorage.getItem(CORRLOG_KEY) || "[]") as CorrectionEntry[]; } catch { return []; }
}
function saveCorrLog(list: CorrectionEntry[]) {
  try { localStorage.setItem(CORRLOG_KEY, JSON.stringify(list.slice(0, 100))); } catch { /* storage may be unavailable */ }
}

/** Sanitise a user-typed invoice number into a safe filename stem (no path/illegal chars, no extension). */
function toStem(raw: string): string {
  return raw.trim().replace(/\.pdf$/i, "").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "").trim();
}

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
  const [unavailableReason, setUnavailableReason] = useState<"" | "insecure-context" | "unsupported">("");
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
  const [corrLog, setCorrLog] = useState<CorrectionEntry[]>([]);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  // Feature 1 — "Rename by" field selection.
  const [renameBy, setRenameBy] = useState<FieldKind>("invoice");
  const [customLabel, setCustomLabel] = useState("");
  const [customScanned, setCustomScanned] = useState(""); // custom label the rows were last scanned with
  // Feature 2 — Excel summary export in progress ("", "po", "bill-of-export", "fcr").
  const [exporting, setExporting] = useState("");
  const uploadRef = useRef<HTMLInputElement>(null);
  const lastField = useRef<{ by: FieldKind; label: string }>({ by: "invoice", label: "" });

  useEffect(() => {
    setMounted(true);
    setFsaPicker(() => getDirectoryPicker());
    setUnavailableReason(folderWriteUnavailableReason());
    setHistory(loadHistory());
    setCorrLog(loadCorrLog());
  }, []);

  const addLog = useCallback((s: string) => setLog((l) => [...l.slice(-199), `${new Date().toLocaleTimeString()}  ${s}`]), []);

  const reset = () => { setRows([]); setMsg(null); setLog([]); setProgress(null); setQuery(""); setFilter("all"); setEditingKey(null); };

  // --- Folder selection --------------------------------------------------
  const pickViaFsa = async () => {
    if (!fsaPicker) return;
    try {
      const handle = await fsaPicker({ mode: "readwrite" });
      reset();
      setDirHandle(handle);
      setFolderName(handle.name);
      const found = await collectHandles(handle);
      setRows(found.map((f, i) => ({ key: `h${i}:${f.path}`, path: f.path, size: 0, selected: true, state: "pending", handle: f.handle, dir: f.dir })));
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

  async function collectHandles(dir: FsDirHandle, base = "", out: { handle: FsFileHandle; dir: FsDirHandle; path: string }[] = []): Promise<{ handle: FsFileHandle; dir: FsDirHandle; path: string }[]> {
    for await (const entry of dir.values()) {
      if (entry.kind === "directory") {
        if (entry.name === OUTPUT_SUBDIR || entry.name.startsWith(".")) continue;
        await collectHandles(entry, base ? `${base}/${entry.name}` : entry.name, out);
      } else if (entry.name.toLowerCase().endsWith(".pdf")) {
        // Track the file's OWN parent directory so we can rename it IN PLACE
        // (a subfolder's file is renamed inside that subfolder).
        out.push({ handle: entry, dir, path: base ? `${base}/${entry.name}` : entry.name });
      }
    }
    return out.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
  }

  // --- Scan & preview ----------------------------------------------------
  async function analyzeOne(bytes: Blob, name: string): Promise<Analysis> {
    // Abort a stuck request so one slow/hung file can never freeze the scan
    // indefinitely — it fails, is logged, and the batch continues. The bound is
    // a little above the server's own 100s analysis backstop.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 115_000);
    try {
      const headers: Record<string, string> = {
        "x-filename": encodeURIComponent(name).replace(/%20/g, " "),
        "x-rename-by": renameBy,
      };
      if (renameBy === "custom" && customLabel.trim()) headers["x-custom-label"] = encodeURIComponent(customLabel.trim());
      const res = await fetch("/api/pdf-rename/analyze", { method: "POST", headers, body: bytes, signal: ctrl.signal });
      if (!res.ok) {
        const j = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error((j as { error?: string }).error || `HTTP ${res.status}`);
      }
      return (await res.json()) as Analysis;
    } catch (e) {
      if ((e as Error)?.name === "AbortError") throw new Error("Analysis timed out (the server did not respond in time).");
      throw e;
    } finally {
      clearTimeout(timer);
    }
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
          // Fresh analysis for THIS batch: clear any rename-output fields left
          // over from a previous run of these rows, so no stale "renamed"
          // name/flag survives into the newly-scanned state.
          next[i] = { ...r, ...a, state: "scanned", finalName: undefined, corrected: false, stateMsg: undefined, scannedCustomLabel: renameBy === "custom" ? customLabel.trim() : "" };
          if (a.decision === "RENAME" && a.proposedName) addLog(`✓ ${r.path} → ${a.proposedName} (${a.source}, ${Math.round((a.confidence || 0) * 100)}%)`);
          else addLog(`⚠ ${r.path} needs review: ${a.reviewReason || a.reasonText || "no invoice number found"}`);
        } catch (e) {
          next[i] = { ...r, decision: "REVIEW", reviewReason: "PDF_UNREADABLE_OR_CORRUPTED", reasonText: (e as Error).message, state: "scanned", proposedName: null, invoiceNumber: null, confidence: 0, finalName: undefined, corrected: false, stateMsg: undefined };
          addLog(`✗ FAILED ${r.path}: ${(e as Error).message}`);
        }
        done++;
        setProgress({ done, total });
        // Update the table frequently so progress + per-row status reflect reality
        // after every file (small batches never wait for a 5-file flush).
        if (done % 2 === 0 || done === total || total <= 10) setRows([...next]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(SCAN_CONCURRENCY, total) }, worker));
    // Re-apply manual corrections saved earlier for this folder. A correction
    // is shown as "renamed" ONLY when its corrected copy is actually present in
    // THIS folder's output sub-folder (verified on disk). Otherwise we keep the
    // user's chosen invoice number as a proposal ("will rename") but never claim
    // a rename that isn't there — so a previous batch's status can't leak in.
    const corr = loadCorrections();
    let restored = 0;
    let outRoot: FsDirHandle | null = null;
    if (dirHandle) { try { outRoot = await dirHandle.getDirectoryHandle(OUTPUT_SUBDIR); } catch { outRoot = null; } }
    for (let i = 0; i < next.length; i++) {
      const c = corr[corrKey(folderName, next[i].path)];
      if (!c) continue;
      // The corrected copy lives in the output folder under the file's own
      // sub-path; verify it is actually present there before claiming "renamed".
      const dirPart = next[i].path.includes("/") ? next[i].path.slice(0, next[i].path.lastIndexOf("/")) : "";
      const outSub = outRoot ? await getDirByPath(outRoot, dirPart, false) : null;
      const verified = outSub ? await exists(outSub, c.finalName) : false;
      if (verified) {
        next[i] = { ...next[i], invoiceNumber: c.invoice, proposedName: `${c.invoice}.pdf`, finalName: c.finalName, decision: "RENAME", state: "renamed", corrected: true, stateMsg: `manual → ${OUTPUT_SUBDIR}/${dirPart ? dirPart + "/" : ""}${c.finalName}` };
        restored++;
      } else {
        next[i] = { ...next[i], invoiceNumber: c.invoice, proposedName: `${c.invoice}.pdf`, finalName: undefined, decision: "RENAME", state: "scanned", corrected: false, stateMsg: undefined };
      }
    }
    setRows([...next]);
    setBusy("");
    setCustomScanned(renameBy === "custom" ? customLabel.trim() : "");
    const willRename = next.filter((r) => r.decision === "RENAME").length;
    const restoredNote = restored ? ` ${restored} manual correction(s) restored.` : "";
    addLog(`Scan complete: ${willRename} ready to rename, ${total - willRename} need review.${restoredNote} No files changed.`);
    setMsg({ tone: "ok", text: `Scanned ${total} PDF(s): ${willRename} ready, ${total - willRename} need review.${restoredNote} No files changed.` });
  };

  // --- Rename ------------------------------------------------------------
  const runRename = async (onlySelected: boolean) => {
    const targets = rows.map((r, i) => ({ r, i })).filter(({ r }) => r.state === "scanned" || r.state === "review" || r.state === "failed").filter(({ r }) => (onlySelected ? r.selected : true));
    if (targets.length === 0) { setMsg({ tone: "err", text: "Nothing to rename — scan first, then select files." }); return; }
    setBusy("rename");
    setMsg(null);

    // DIRECT FOLDER MODE (Chrome/Edge, secure context): write a renamed COPY of
    // each PDF into an "UCP Renamed" sub-folder of the chosen folder, mirroring the
    // source structure. Originals are never touched; no ZIP. Verify read-write
    // permission on the folder FIRST; if denied we stop and ask (never silently
    // download instead).
    if (dirHandle) {
      const granted = await ensureWritePermission(dirHandle);
      if (!granted) {
        setBusy("");
        addLog("Rename aborted — read/write permission to the folder was not granted.");
        setMsg({ tone: "err", text: "The browser did not grant write access to the folder. Choose the folder again and click “Allow”/“Edit files”, then rename." });
        return;
      }
      let outRoot: FsDirHandle;
      try {
        outRoot = await dirHandle.getDirectoryHandle(OUTPUT_SUBDIR, { create: true });
      } catch (e) {
        setBusy("");
        setMsg({ tone: "err", text: `Could not create the “${OUTPUT_SUBDIR}” output folder: ${(e as Error).message}` });
        return;
      }
      setProgress({ done: 0, total: targets.length });
      addLog(`Writing renamed copies into “${folderName}/${OUTPUT_SUBDIR}” (originals preserved; no ZIP).`);
      // Dedupe is PER output sub-folder: the same invoice name in two different
      // sub-folders must NOT be suffixed (they can't collide), only duplicates
      // within one sub-folder are de-collided.
      const claimedByDir = new Map<string, Set<string>>();
      const next = [...rows];
      let done = 0, renamed = 0, review = 0, failed = 0;
      for (const { r, i } of targets) {
        const leaf = r.path.split("/").pop() || r.path;
        try {
          if (!(r.decision === "RENAME" && r.proposedName) || !r.handle) {
            // Never invent a number — a file whose invoice could not be read is
            // left for manual rename and NOT copied automatically.
            next[i] = { ...r, state: "review", finalName: undefined, stateMsg: `${r.reviewReason || "needs review"} — not copied` };
            review++;
            addLog(`Needs review (not copied): ${leaf}`);
          } else {
            // Mirror the source sub-folder under the output root so structure is
            // preserved; dedupe within that sub-folder so no copy is overwritten.
            const dirPart = r.path.includes("/") ? r.path.slice(0, r.path.lastIndexOf("/")) : "";
            const outSub = (await getDirByPath(outRoot, dirPart, true))!;
            let claimed = claimedByDir.get(dirPart);
            if (!claimed) { claimed = new Set<string>(); claimedByDir.set(dirPart, claimed); }
            const finalName = await dedupeInDir(outSub, r.proposedName, "", claimed);
            await writeCopy(outSub, finalName, r.handle);
            const outPath = `${OUTPUT_SUBDIR}/${dirPart ? dirPart + "/" : ""}${finalName}`;
            // The row's own handle/path stay on the ORIGINAL (unchanged); only the
            // proposed/final name and status reflect the copy that was written.
            next[i] = { ...r, state: "renamed", finalName, stateMsg: `copy → ${outPath}` };
            renamed++;
            addLog(`Renamed copy: ${leaf} → ${outPath}`);
          }
        } catch (e) {
          failed++;
          next[i] = { ...r, state: "failed", stateMsg: (e as Error).message };
          addLog(`FAILED ${leaf}: ${(e as Error).message}`);
        }
        done++; setProgress({ done, total: targets.length }); setRows([...next]);
      }
      setBusy("");
      pushHistory({ folder: folderName, total: targets.length, renamed, review, failed, mode: `local (${OUTPUT_SUBDIR} folder)` });
      setMsg({ tone: "ok", text: `Done: ${renamed} renamed copy(ies) written to “${folderName}/${OUTPUT_SUBDIR}”, ${review} need review, ${failed} failed. Your originals are unchanged.` });
      return;
    }

    // No folder handle (Firefox/Safari, or a non-secure context): the page cannot
    // write to the user's disk, so renamed copies are returned as a ZIP download —
    // the best output method those browsers support.
    await zipFallback(targets, "local (ZIP download)");
  };

  /** Build a renamed-copies ZIP and download it (browsers without the File System
   *  Access API). Reads each file from its FS handle or its uploaded File, so it
   *  works regardless of how the folder was selected. Originals are never modified.
   *  Only files with a resolved invoice name are included (REVIEW files are left
   *  for manual rename — numbers are never invented). Entries are placed under an
   *  "UCP Renamed/…" path mirroring the source structure, deduped so nothing is
   *  overwritten inside the archive. */
  const zipFallback = async (targets: { r: Row; i: number }[], mode: string) => {
    try {
      const renameable = targets.filter(({ r }) => r.decision === "RENAME" && r.proposedName);
      const needReview = targets.length - renameable.length;
      if (renameable.length === 0) { setBusy(""); setMsg({ tone: "err", text: "No files are ready to rename — every selected file needs review." }); return; }
      addLog(`Building “${OUTPUT_SUBDIR}.zip” for ${renameable.length} file(s) (your originals are not modified).`);
      setProgress({ done: 0, total: renameable.length });
      const fd = new FormData();
      const names: Record<string, string> = {};
      const usedZip = new Set<string>();
      const relPath = (dirPart: string, nm: string) => `${OUTPUT_SUBDIR}/${dirPart ? dirPart + "/" : ""}${nm}`;
      let done = 0;
      for (const { r } of renameable) {
        const file = r.handle ? await r.handle.getFile() : r.file;
        if (!file) continue;
        const dirPart = r.path.includes("/") ? r.path.slice(0, r.path.lastIndexOf("/")) : "";
        const base = r.proposedName!;
        // Dedupe on the full relative output path so same-named files in different
        // sub-folders don't collide and no entry is overwritten in the archive.
        let leaf = base; let n = 2;
        while (usedZip.has(relPath(dirPart, leaf).toLowerCase())) { const d = base.lastIndexOf("."); leaf = `${base.slice(0, d)}-${n++}${base.slice(d)}`; }
        usedZip.add(relPath(dirPart, leaf).toLowerCase());
        // Key by the ORIGINAL path; value is the relative output path (keeps structure).
        names[r.path] = relPath(dirPart, leaf);
        fd.append("files", file, r.path);
        done++; setProgress({ done, total: renameable.length });
      }
      fd.append("names", JSON.stringify(names));
      const res = await fetch("/api/pdf-rename/rename-zip", { method: "POST", body: fd });
      if (!res.ok) { const j = await res.json().catch(() => ({ error: `HTTP ${res.status}` })); throw new Error((j as { error?: string }).error || `HTTP ${res.status}`); }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = `${OUTPUT_SUBDIR}.zip`; a.click(); URL.revokeObjectURL(url);
      // Reflect per-file status: exported rows → renamed; the rest stay as review.
      const inZip = new Set(renameable.map(({ r }) => r.key));
      setRows((rs) => rs.map((r) => (inZip.has(r.key) ? { ...r, state: "renamed" as RowState, finalName: r.proposedName ?? undefined, stateMsg: `exported to ${OUTPUT_SUBDIR}.zip` } : r)));
      setBusy("");
      pushHistory({ folder: folderName, total: targets.length, renamed: renameable.length, review: needReview, failed: 0, mode });
      setMsg({ tone: "ok", text: `Downloaded “${OUTPUT_SUBDIR}.zip” with ${renameable.length} renamed copy(ies)${needReview ? `; ${needReview} need review and were not included` : ""}. Your original files are unchanged.` });
    } catch (e) {
      setBusy(""); setMsg({ tone: "err", text: `ZIP build failed: ${(e as Error).message}` });
    }
  };

  async function exists(dir: FsDirHandle, name: string): Promise<boolean> {
    try { await dir.getFileHandle(name); return true; } catch { return false; }
  }
  /** Pick a collision-free name within `dir`. A file's OWN current name counts as
   *  free (so a no-op/re-rename keeps its name). `claimed` reserves names already
   *  assigned in this run. Never returns a name that would overwrite a DIFFERENT
   *  existing file — it appends `-2`, `-3`, … instead. */
  async function dedupeInDir(dir: FsDirHandle, name: string, exceptName: string, claimed: Set<string>): Promise<string> {
    const d = name.lastIndexOf("."); const stem = d > 0 ? name.slice(0, d) : name; const ext = d > 0 ? name.slice(d) : ".pdf";
    let candidate = name; let n = 2;
    const taken = async (c: string): Promise<boolean> => {
      if (c.toLowerCase() === exceptName.toLowerCase()) return false;
      if (claimed.has(c.toLowerCase())) return true;
      return exists(dir, c);
    };
    while (await taken(candidate)) candidate = `${stem}-${n++}${ext}`;
    claimed.add(candidate.toLowerCase());
    return candidate;
  }
  /** Resolve (optionally creating) a nested sub-directory by its "a/b/c" relative
   *  path within `root`, so the output folder mirrors the source structure. Empty
   *  path returns `root`; with create=false a missing segment returns null. */
  async function getDirByPath(root: FsDirHandle, rel: string, create: boolean): Promise<FsDirHandle | null> {
    if (!rel) return root;
    let cur: FsDirHandle = root;
    for (const seg of rel.split("/").filter(Boolean)) {
      try { cur = await cur.getDirectoryHandle(seg, { create }); }
      catch (e) { if (!create) return null; throw new Error(`Could not create sub-folder “${seg}”: ${(e as Error).message}`); }
    }
    return cur;
  }
  /** Write a renamed COPY of a source file into `dir` under `name`. The source
   *  (original) handle is only READ — never modified. PDF bytes are copied
   *  verbatim, preserving the content exactly. */
  async function writeCopy(dir: FsDirHandle, name: string, source: FsFileHandle): Promise<void> {
    const bytes = await (await source.getFile()).arrayBuffer();
    const nh = await dir.getFileHandle(name, { create: true });
    const w = await nh.createWritable();
    await w.write(bytes);
    await w.close();
  }

  const pushHistory = (e: Omit<HistoryEntry, "at">) => {
    setHistory((prev) => { const nextH = [{ at: new Date().toISOString(), ...e }, ...prev].slice(0, 25); saveHistory(nextH); return nextH; });
  };

  const recordCorrection = (path: string, invoice: string, finalName: string, action: string) => {
    const map = loadCorrections();
    map[corrKey(folderName, path)] = { invoice, finalName, at: new Date().toISOString() };
    saveCorrections(map);
    setCorrLog((prev) => {
      const nextL = [{ at: new Date().toISOString(), folder: folderName, path, from: path.split("/").pop() || path, to: finalName, action }, ...prev].slice(0, 100);
      saveCorrLog(nextL);
      return nextL;
    });
  };

  // --- Manual rename (per file, incl. REVIEW_REQUIRED) -------------------
  const manualRename = async (key: string, rawInvoice: string) => {
    const stem = toStem(rawInvoice);
    const row = rows.find((r) => r.key === key);
    if (!row) return;
    if (!stem) { setMsg({ tone: "err", text: "Enter an invoice number before saving." }); return; }
    const finalBase = `${stem}.pdf`;
    setBusy("rename");
    try {
      if (dirHandle && row.handle) {
        // Direct mode: write a corrected COPY into the output folder (the original
        // is left untouched), mirroring the file's sub-path.
        const granted = await ensureWritePermission(dirHandle);
        if (!granted) { setBusy(""); setMsg({ tone: "err", text: "The browser did not grant write access to the folder." }); return; }
        const outRoot = await dirHandle.getDirectoryHandle(OUTPUT_SUBDIR, { create: true });
        const dirPart = row.path.includes("/") ? row.path.slice(0, row.path.lastIndexOf("/")) : "";
        const outSub = (await getDirByPath(outRoot, dirPart, true))!;
        const finalName = await dedupeInDir(outSub, finalBase, "", new Set());
        await writeCopy(outSub, finalName, row.handle);
        const outPath = `${OUTPUT_SUBDIR}/${dirPart ? dirPart + "/" : ""}${finalName}`;
        const leaf = row.path.split("/").pop() || row.path;
        setRows((rs) => rs.map((r) => (r.key === key ? { ...r, state: "renamed", decision: "RENAME", invoiceNumber: stem, proposedName: finalBase, finalName, corrected: true, stateMsg: `manual → ${outPath}` } : r)));
        recordCorrection(row.path, stem, finalName, "manual rename (copy)");
        addLog(`Manual rename: ${leaf} → ${outPath}`);
        setMsg({ tone: "ok", text: `Wrote corrected copy: ${leaf} → ${outPath}. Original unchanged.` });
      } else {
        // Upload mode: no folder handle, so download the single corrected copy.
        const file = row.handle ? await row.handle.getFile() : row.file!;
        const bytes = await file.arrayBuffer();
        const blob = new Blob([bytes], { type: "application/pdf" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a"); a.href = url; a.download = finalBase; a.click(); URL.revokeObjectURL(url);
        setRows((rs) => rs.map((r) => (r.key === key ? { ...r, state: "renamed", decision: "RENAME", invoiceNumber: stem, proposedName: finalBase, finalName: finalBase, corrected: true, stateMsg: `manual → ${finalBase} (downloaded)` } : r)));
        recordCorrection(row.path, stem, finalBase, "manual rename (download)");
        addLog(`Manual rename (download): ${row.path} → ${finalBase}`);
        setMsg({ tone: "ok", text: `Downloaded corrected copy “${finalBase}”. Original unchanged.` });
      }
      setEditingKey(null);
    } catch (e) {
      setMsg({ tone: "err", text: `Manual rename failed: ${(e as Error).message}` });
    } finally {
      setBusy("");
    }
  };

  // Re-derive the selected-field view when "Rename by" changes. Invoice / FCR /
  // Container / EXP are all extracted in one scan, so switching among them needs
  // NO re-scan (instant, from the stored field set). Only Custom (server-side, by
  // label) needs a scan with its label — a mismatch is flagged RESCAN_REQUIRED.
  useEffect(() => {
    const prev = lastField.current;
    const label = customLabel.trim();
    const byChanged = prev.by !== renameBy;
    const labelChanged = prev.label !== label;
    lastField.current = { by: renameBy, label };
    if (!byChanged && !(renameBy === "custom" && labelChanged)) return; // irrelevant change
    setRows((rs) =>
      rs.map((r) => {
        if (!r.fields) return r; // not scanned yet
        const nextState: RowState = r.state === "pending" ? "pending" : "scanned";
        if (renameBy === "custom" && label !== (r.scannedCustomLabel ?? "")) {
          return { ...r, extractedValue: null, proposedName: null, decision: "REVIEW", reviewReason: "RESCAN_REQUIRED", reasonText: "Re-scan to extract this custom field.", finalName: undefined, corrected: false, stateMsg: undefined, state: nextState };
        }
        const sel = deriveSelected(r.fields as ServerFields, renameBy, r.minConfidence ?? 0.75);
        if (!sel) return r;
        return { ...r, extractedValue: sel.extractedValue, proposedName: sel.proposedName, decision: sel.decision, confidence: sel.confidence, source: sel.source, reviewReason: sel.reviewReason, reasonText: sel.reasonText, finalName: undefined, corrected: false, stateMsg: undefined, state: nextState };
      }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renameBy, customLabel]);

  // --- Excel summary export (feature 2) ----------------------------------
  const downloadSummary = async (report: "po" | "bill-of-export" | "fcr", label: string) => {
    const scannedRows = rows.filter((r) => r.state !== "pending" && r.fields !== undefined);
    if (scannedRows.length === 0) { setMsg({ tone: "err", text: "Scan a folder first — there are no extracted rows to summarise." }); return; }
    setExporting(report);
    try {
      const payload = {
        report,
        rows: scannedRows.map((r) => {
          const f = r.fields as ServerFields | null | undefined;
          const success = r.state === "renamed" || (r.decision === "RENAME" && Boolean(r.proposedName));
          return {
            file: r.path,
            invoiceNumber: f?.invoice?.key ?? f?.invoice?.value ?? r.invoiceNumber ?? null,
            fcrNumber: f?.fcr?.value ?? null,
            containerNumber: f?.container?.value ?? null,
            expNumber: f?.exp?.value ?? null,
            confidence: typeof r.confidence === "number" ? r.confidence : null,
            success,
            message: success ? (r.stateMsg || r.reasonText || "Extracted") : (r.reviewReason || r.reasonText || "Needs review"),
          };
        }),
      };
      const res = await fetch("/api/pdf-rename/summary", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      if (!res.ok) { const j = await res.json().catch(() => ({ error: `HTTP ${res.status}` })); throw new Error((j as { error?: string }).error || `HTTP ${res.status}`); }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const stamp = new Date().toISOString().slice(0, 10);
      const a = document.createElement("a"); a.href = url; a.download = `${label} - ${stamp}.xlsx`; a.click(); URL.revokeObjectURL(url);
      addLog(`Downloaded “${label}” Excel summary (${scannedRows.length} row(s)).`);
      setMsg({ tone: "ok", text: `Downloaded “${label}” summary with ${scannedRows.length} row(s).` });
    } catch (e) {
      setMsg({ tone: "err", text: `Could not build the ${label} summary: ${(e as Error).message}` });
    } finally {
      setExporting("");
    }
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
      return `${r.path} ${r.extractedValue ?? ""} ${r.invoiceNumber ?? ""} ${r.proposedName ?? ""}`.toLowerCase().includes(q);
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
              {unavailableReason === "unsupported" ? (
                <div className="mt-2 text-[11px] text-slate-400">
                  Direct folder writing runs in Chrome or Edge. In this browser the renamed copies download as “{OUTPUT_SUBDIR}.zip” instead.
                </div>
              ) : null}
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
          <div className="mb-3 flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-medium uppercase tracking-wide text-slate-400">Rename by</span>
              <select value={renameBy} onChange={(e) => setRenameBy(e.target.value as FieldKind)} disabled={busy !== ""} className="rounded border border-slate-200 px-2 py-1 text-xs disabled:opacity-50">
                {RENAME_BY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
            {renameBy === "custom" ? (
              <label className="flex flex-col gap-1">
                <span className="text-[11px] font-medium uppercase tracking-wide text-slate-400">Field label to extract</span>
                <input value={customLabel} onChange={(e) => setCustomLabel(e.target.value)} placeholder="e.g. HS CODE, Order No" className="w-56 rounded border border-slate-200 px-2 py-1 text-xs" />
              </label>
            ) : null}
            <span className="mb-1 text-[11px] text-slate-400">
              Files are renamed to the selected field&rsquo;s value.{renameBy === "custom" && !customLabel.trim() ? " Enter a field label, then Scan." : " Change the field, then Scan & Preview."}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={runScan} disabled={busy !== "" || total === 0 || (renameBy === "custom" && !customLabel.trim())} className="btn-ghost text-xs disabled:opacity-40">{busy === "scan" ? `Scanning… ${pct}%` : "🔍 Scan & Preview"}</button>
            <button onClick={() => runRename(true)} disabled={busy !== "" || !scanned || selectedCount === 0} className="btn-primary text-xs disabled:opacity-40">{busy === "rename" ? "Renaming…" : `▶ Rename Selected (${selectedCount})`}</button>
            <button onClick={() => runRename(false)} disabled={busy !== "" || !scanned} className="btn-ghost text-xs disabled:opacity-40">▶ Rename All</button>
            <span className="ml-auto text-[11px] text-slate-400">{dirHandle ? `Renamed copies are written to “${OUTPUT_SUBDIR}” inside the folder (originals preserved).` : fsaPicker ? "" : `Upload mode: renamed copies download as “${OUTPUT_SUBDIR}.zip”.`}</span>
          </div>
          {!scanned ? <div className="mt-2 text-[11px] text-slate-400">Actions become available after a folder is selected and scanned.</div> : null}
          {progress && busy ? (
            <div className="mt-3">
              <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${pct}%` }} /></div>
              <div className="mt-1 text-[11px] text-slate-500">{busy === "scan" ? "Scanning" : "Renaming"} {progress.done}/{progress.total} · {pct}%</div>
            </div>
          ) : null}
          {msg ? <div className={`mt-2 text-sm ${msg.tone === "ok" ? "text-emerald-700" : "text-rose-600"}`}>{msg.text}</div> : null}

          {scanned ? (
            <div className="mt-4 border-t border-slate-100 pt-3">
              <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-slate-400">Excel summary — one row per scanned PDF</div>
              <div className="flex flex-wrap items-center gap-2">
                <button onClick={() => downloadSummary("po", "PO Extraction")} disabled={busy !== "" || exporting !== ""} className="btn-ghost text-xs disabled:opacity-40">{exporting === "po" ? "Building…" : "⬇ PO Extraction"}</button>
                <button onClick={() => downloadSummary("bill-of-export", "Bill Of Export Data")} disabled={busy !== "" || exporting !== ""} className="btn-ghost text-xs disabled:opacity-40">{exporting === "bill-of-export" ? "Building…" : "⬇ Bill Of Export Data"}</button>
                <button onClick={() => downloadSummary("fcr", "FCR Extraction")} disabled={busy !== "" || exporting !== ""} className="btn-ghost text-xs disabled:opacity-40">{exporting === "fcr" ? "Building…" : "⬇ FCR Extraction"}</button>
                <span className="ml-auto text-[11px] text-slate-400">Columns match the reference templates; blank where a value was not extracted, Success=false for failed rows.</span>
              </div>
            </div>
          ) : null}
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
                <th className="px-3 py-1.5 text-left font-semibold">{FIELD_HEADER[renameBy]}</th>
                <th className="px-3 py-1.5 text-left font-semibold">Proposed name</th>
                <th className="px-3 py-1.5 text-left font-semibold">Conf.</th>
                <th className="px-3 py-1.5 text-left font-semibold">Via</th>
                <th className="px-3 py-1.5 text-left font-semibold">Status</th>
                <th className="px-3 py-1.5 text-left font-semibold">Manual rename</th>
              </tr></thead>
              <tbody>
                {filtered.map((r) => (
                  <tr key={r.key} className="border-t border-slate-100">
                    <td className="px-3 py-1.5"><input type="checkbox" checked={r.selected} onChange={(e) => toggleOne(r.key, e.target.checked)} aria-label={`Select ${r.path}`} /></td>
                    <td className="px-3 py-1.5 font-mono max-w-[240px] truncate" title={r.path}>{r.path}</td>
                    <td className="px-3 py-1.5 font-mono">{r.extractedValue ?? r.invoiceNumber ?? "—"}</td>
                    <td className="px-3 py-1.5 font-mono">{r.finalName || r.proposedName || "—"}</td>
                    <td className="px-3 py-1.5">{r.confidence ? `${Math.round(r.confidence * 100)}%` : "—"}</td>
                    <td className="px-3 py-1.5">{!r.source || r.source === "none" ? "—" : r.source}</td>
                    <td className="px-3 py-1.5">
                      {r.state === "pending" ? <span className="text-slate-400">—</span>
                        : r.state === "renamed" ? <span className="badge bg-emerald-50 text-emerald-700 ring-1 ring-emerald-600/15" title={r.stateMsg}>{r.corrected ? "renamed ✎" : "renamed"}</span>
                        : r.state === "failed" ? <span className="badge bg-rose-50 text-rose-700 ring-1 ring-rose-600/15" title={r.stateMsg}>failed</span>
                        : r.decision === "RENAME" && r.proposedName ? <span className="badge bg-emerald-50 text-emerald-700 ring-1 ring-emerald-600/15">will rename</span>
                        : <span className="badge bg-amber-50 text-amber-700 ring-1 ring-amber-600/20" title={r.reasonText}>{r.reviewReason || "review"}</span>}
                    </td>
                    <td className="px-3 py-1.5">
                      {editingKey === r.key ? (
                        <div className="flex items-center gap-1.5">
                          <input autoFocus value={editValue} onChange={(e) => setEditValue(e.target.value)}
                            onKeyDown={(e) => { if (e.key === "Enter") manualRename(r.key, editValue); if (e.key === "Escape") setEditingKey(null); }}
                            placeholder="invoice no." className="w-24 rounded border border-slate-300 px-1.5 py-0.5 font-mono text-[11px]" />
                          <span className="font-mono text-[11px] text-slate-400">{toStem(editValue) ? `${toStem(editValue)}.pdf` : ""}</span>
                          <button onClick={() => manualRename(r.key, editValue)} disabled={busy !== "" || !toStem(editValue)} className="text-[11px] font-medium text-emerald-700 hover:underline disabled:opacity-40">Save</button>
                          <button onClick={() => setEditingKey(null)} className="text-[11px] text-slate-400 hover:underline">Cancel</button>
                        </div>
                      ) : r.state === "pending" ? (
                        <span className="text-slate-300">—</span>
                      ) : (
                        <button onClick={() => { setEditingKey(r.key); setEditValue(r.extractedValue || r.invoiceNumber || ""); setMsg(null); }} className="text-[11px] font-medium text-ananta hover:underline">✎ Rename</button>
                      )}
                    </td>
                  </tr>
                ))}
                {filtered.length === 0 ? <tr><td className="px-3 py-3 text-slate-400" colSpan={8}>No files match.</td></tr> : null}
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

      {/* Manual corrections log (this browser) */}
      {corrLog.length > 0 ? (
        <div className="card p-4">
          <div className="mb-1 flex items-center gap-2">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="text-slate-400" aria-hidden><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5Z" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
            <div className="text-sm font-semibold text-slate-800">Manual Corrections</div>
          </div>
          <p className="mb-3 text-xs text-slate-500">Invoice numbers you set by hand (stored in this browser; the output folder already holds the renamed copy).</p>
          <div className="overflow-x-auto">
            <table className="w-full whitespace-nowrap text-xs">
              <thead className="bg-slate-50 text-slate-500"><tr>
                <th className="px-3 py-1.5 text-left font-semibold">Date</th>
                <th className="px-3 py-1.5 text-left font-semibold">Folder</th>
                <th className="px-3 py-1.5 text-left font-semibold">Original</th>
                <th className="px-3 py-1.5 text-left font-semibold">New name</th>
                <th className="px-3 py-1.5 text-left font-semibold">Action</th>
              </tr></thead>
              <tbody>
                {corrLog.map((c, i) => (
                  <tr key={i} className="border-t border-slate-100">
                    <td className="px-3 py-1.5 text-slate-600">{c.at.slice(0, 16).replace("T", " ")}</td>
                    <td className="px-3 py-1.5 max-w-[160px] truncate" title={c.folder}>{c.folder}</td>
                    <td className="px-3 py-1.5 font-mono max-w-[200px] truncate" title={c.path}>{c.from}</td>
                    <td className="px-3 py-1.5 font-mono text-emerald-700">{c.to}</td>
                    <td className="px-3 py-1.5 text-slate-500">{c.action}</td>
                  </tr>
                ))}
              </tbody>
            </table>
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
