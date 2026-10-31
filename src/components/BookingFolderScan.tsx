"use client";

import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { useRouter } from "next/navigation";

const LS_PATH_KEY = "ucp.shipmentSchedule.bookingScan.folderPath";
const LS_PICKED_LABEL_KEY = "ucp.shipmentSchedule.bookingScan.lastPickedLabel";

interface ScanItem {
  fileName: string;
  action: "hydrated" | "skipped_already_extracted" | "unmatched" | "parse_failed";
  reason: string;
  rowId?: string;
  scheduleId?: string;
  cutoffId?: string;
  orderNoPrefix: string;
  marketCode: string;
  marketSubCode: string;
  pdfFob: number | null;
  rowFob: number | null;
  fobMatches: boolean | null;
  bcn: string;
  bookingRef: string;
  bookingStatus: string;
}

interface ScanResult {
  folderPath: string;
  pdfsFound: number;
  skippedAlreadyExtracted: number;
  matchedAndHydrated: number;
  unmatched: number;
  parseFailed: number;
  items: ScanItem[];
}

export function BookingFolderScan() {
  const router = useRouter();
  const [folderPath, setFolderPath] = useState<string>("");
  const [lastPickedLabel, setLastPickedLabel] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<ScanResult | null>(null);
  const pickerRef = useRef<HTMLInputElement>(null);

  // Sticky folder selection (user rule 2026-10-28): the folder stays across
  // reloads until the user types a different path or picks another folder.
  // The pick-folder label can be shown as a hint but the browser does not let
  // us re-open the same OS folder picker programmatically, so re-scanning a
  // picked folder requires the user to click "Pick Folder" again.
  useEffect(() => {
    try {
      const p = localStorage.getItem(LS_PATH_KEY);
      if (p) setFolderPath(p);
      const l = localStorage.getItem(LS_PICKED_LABEL_KEY);
      if (l) setLastPickedLabel(l);
    } catch { /* localStorage unavailable (private mode) — ignore */ }
  }, []);
  function persistPath(next: string) {
    setFolderPath(next);
    try { localStorage.setItem(LS_PATH_KEY, next); } catch { /* ignore */ }
  }
  function persistPickedLabel(next: string) {
    setLastPickedLabel(next);
    try { localStorage.setItem(LS_PICKED_LABEL_KEY, next); } catch { /* ignore */ }
  }

  // Scan a folder by server-side path (user typed "D:\...").
  async function onScanPath() {
    setError(""); setResult(null);
    if (!folderPath.trim()) { setError("Enter a folder path first."); return; }
    setBusy(true);
    try {
      const r = await fetch("/api/shipment-schedule/scan-folder", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ folderPath: folderPath.trim() }),
      });
      const data = await r.json();
      if (!r.ok) { setError(data.error ?? "Scan failed."); return; }
      setResult(data as ScanResult);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Scan failed.");
    } finally {
      setBusy(false);
    }
  }

  // Scan a folder the user picked in-browser (no server-side path visibility).
  async function onPickedFolder(e: ChangeEvent<HTMLInputElement>) {
    const chosen = Array.from(e.target.files ?? []);
    if (chosen.length === 0) return;
    const pdfs = chosen.filter((f) => f.name.toLowerCase().endsWith(".pdf"));
    if (pdfs.length === 0) { setError("That folder had no .pdf files."); return; }
    // Derive a label like "<folder-name> (12 files)" from the first PDF's path.
    const rel = (pdfs[0] as unknown as { webkitRelativePath?: string }).webkitRelativePath || "";
    const folderName = rel.split("/")[0] || rel.split("\\")[0] || "picked-folder";
    const label = `${folderName} (${pdfs.length} PDF${pdfs.length === 1 ? "" : "s"})`;
    persistPickedLabel(label);
    setError(""); setResult(null); setBusy(true);
    try {
      const fd = new FormData();
      fd.set("folderLabel", label);
      for (const f of pdfs) fd.append("files", f);
      const r = await fetch("/api/shipment-schedule/scan-upload", { method: "POST", body: fd });
      const data = await r.json();
      if (!r.ok) { setError(data.error ?? "Scan failed."); return; }
      setResult(data as ScanResult);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Scan failed.");
    } finally {
      setBusy(false);
      if (pickerRef.current) pickerRef.current.value = "";
    }
  }

  return (
    <div className="card p-5">
      <div className="mb-2">
        <h3 className="text-sm font-semibold text-slate-800">📂 Scan Booking-Confirmation Folder</h3>
        <p className="text-xs text-slate-500">
          Pick a folder of booking-confirmation PDFs. Already-extracted PDFs are skipped. Each new PDF is matched to its week + cut-off by
          <span className="font-mono"> OrderNo</span> and <span className="font-mono">Market Code</span> (from the Sales Contract auto-routed row),
          then the booking fields (BCN, BRef, status, ports, mode, gross weight, cartons, CBM, SKU) hydrate into that row.
          FOB is checked as the 4<sup>th</sup> key — a mismatch is logged, not blocked.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          value={folderPath}
          onChange={(e) => persistPath(e.target.value)}
          placeholder="e.g. D:\booking-confirmations\week-27"
          className="input flex-1 font-mono text-xs"
        />
        <button className="btn-primary text-xs" onClick={onScanPath} disabled={busy || !folderPath.trim()}>
          {busy ? "Scanning…" : "🔎 Scan Path"}
        </button>
        <span className="text-xs text-slate-400">or</span>
        <button
          className="btn-ghost text-xs"
          onClick={() => pickerRef.current?.click()}
          disabled={busy}
          title="Open the browser folder picker — handy when the folder isn't on this machine's disk"
        >
          📁 Pick Folder…
        </button>
        {/* webkitdirectory lets the user select a whole folder; the browser
            then streams every file (we filter to .pdf) up to the upload endpoint. */}
        <input
          ref={pickerRef}
          type="file"
          /* @ts-expect-error — webkitdirectory is non-standard but widely supported */
          webkitdirectory=""
          directory=""
          multiple
          className="hidden"
          onChange={onPickedFolder}
        />
      </div>
      <p className="mt-2 text-[11px] text-slate-500">
        <strong>Scan Path</strong> reads the folder directly from the server&apos;s disk — fastest when the PDFs live on this machine.
        <strong> Pick Folder</strong> opens the browser folder picker and uploads the PDFs — use this when the folder sits on your own computer.
      </p>

      {(folderPath || lastPickedLabel) ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
          <span>Remembered:</span>
          {folderPath ? (
            <span className="rounded bg-slate-100 px-2 py-0.5 font-mono text-slate-700">path: {folderPath}</span>
          ) : null}
          {lastPickedLabel ? (
            <span className="rounded bg-slate-100 px-2 py-0.5 text-slate-700">last picked: {lastPickedLabel}</span>
          ) : null}
          <button
            type="button"
            className="text-rose-600 hover:underline"
            onClick={() => {
              persistPath("");
              persistPickedLabel("");
            }}
          >
            clear
          </button>
        </div>
      ) : null}

      {error ? <p className="mt-2 text-xs text-rose-700">{error}</p> : null}

      {result ? (
        <div className="mt-4 space-y-1 text-xs">
          <div className="text-slate-600">
            {result.pdfsFound} PDF(s) found in <span className="font-mono">{result.folderPath}</span>
          </div>
          <div className="text-green-700">{result.matchedAndHydrated} hydrated</div>
          <div className="text-slate-500">{result.skippedAlreadyExtracted} skipped (already extracted)</div>
          {result.unmatched > 0 ? (
            <div className="text-amber-800">{result.unmatched} unmatched</div>
          ) : null}
          {result.parseFailed > 0 ? (
            <div className="text-rose-700">{result.parseFailed} parse failed</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
