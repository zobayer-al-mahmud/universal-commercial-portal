"use client";

import { useState } from "react";

/**
 * Shared toolbar: shows selected count + "Download selected ZIP" button.
 * POSTs the given ids to `endpoint`, treats the response as a .zip Blob, and
 * triggers the browser's Save-As with `fileNameBase_<yyyy-mm-dd>.zip`.
 *
 * Used by the Sales Contract / Shipment Schedule cut-off / Customs Invoice
 * list pages so one selection pattern works everywhere (user rule 2026-10-28).
 */
export function BulkDownloadBar({
  endpoint,
  bodyKey,
  ids,
  totalCount,
  onSelectAll,
  onClear,
  allSelected,
  disabled,
  fileNameBase,
  label = "⬇ Download selected ZIP",
  className = "",
}: {
  endpoint: string;
  bodyKey: string;                // request field name — "ids" or "cutoffIds"
  ids: string[];
  totalCount: number;
  onSelectAll: () => void;
  onClear: () => void;
  allSelected: boolean;
  disabled?: boolean;
  fileNameBase?: string;
  label?: string;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function run() {
    if (ids.length === 0 || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [bodyKey]: ids }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(text || `Request failed with ${res.status}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const stamp = new Date().toISOString().slice(0, 10);
      a.download = `${fileNameBase ?? "selected"}_${stamp}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Download failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`flex flex-wrap items-center gap-2 ${className}`}>
      <button type="button" className="btn-ghost text-xs" onClick={onSelectAll} disabled={disabled || totalCount === 0}>
        {allSelected ? "Clear all" : `Select all (${totalCount})`}
      </button>
      <span className="text-[11px] text-slate-500">{ids.length} selected</span>
      <button
        type="button"
        className="btn-primary text-xs"
        onClick={run}
        disabled={disabled || busy || ids.length === 0}
        title={ids.length === 0 ? "Pick at least one row to download" : "Download selected rows as a ZIP of .xlsx files"}
      >
        {busy ? "Zipping…" : label}
      </button>
      {ids.length > 0 ? (
        <button type="button" className="text-xs text-slate-400 hover:text-slate-700" onClick={onClear}>
          Clear
        </button>
      ) : null}
      {err ? <span className="text-xs text-rose-600">{err}</span> : null}
    </div>
  );
}
