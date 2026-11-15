"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { searchCatalogAction, openCatalogUdAction } from "@/app/actions/ud-automation";

interface CatalogRow {
  trackingNo: string;
  udDate: string;
  udDateIso: string;
  hasRecord: boolean;
}

interface ImportReport {
  imported: number;
  updated: number;
  unchanged: number;
  duplicates: number;
  malformed: number;
  otherFactory: number;
  otherFactoryCounts: { factoryId: string; rows: number }[];
  duplicateRows: { trackingNo: string; line: number; firstSeenLine: number }[];
  malformedRows: { line: number; raw: string; reason: string }[];
}

/**
 * Factory-scoped UD catalog: import the BGMEA UD list, then search a UD number and
 * open its workflow. Everything here is scoped to the selected factory.
 */
export function UdCatalogPanel({ factoryId, factoryLabel, count }: { factoryId: string; factoryLabel: string; count: number }) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);

  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<CatalogRow[]>([]);
  const [searching, startSearch] = useTransition();
  const [opening, startOpen] = useTransition();
  const [error, setError] = useState("");

  const [uploading, setUploading] = useState(false);
  const [report, setReport] = useState<ImportReport | null>(null);

  // Load the latest catalog whenever the query changes (debounced).
  useEffect(() => {
    const t = setTimeout(() => {
      startSearch(async () => {
        const res = await searchCatalogAction({ factoryId, query });
        if ("error" in res) setError(res.error ?? "Search failed.");
        else setRows(res.rows ?? []);
      });
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [factoryId, query]);

  async function uploadFile(file: File) {
    setError("");
    setReport(null);
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("factoryId", factoryId);
      fd.append("file", file);
      const res = await fetch("/api/ud/catalog", { method: "POST", body: fd });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error || "Import failed.");
        return;
      }
      setReport(json.report as ImportReport);
      setQuery("");
      startSearch(async () => {
        const r = await searchCatalogAction({ factoryId, query: "" });
        if (!("error" in r)) setRows(r.rows ?? []);
      });
      router.refresh();
    } catch {
      setError("Import failed. Check the file and try again.");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  function open(trackingNo: string) {
    setError("");
    startOpen(async () => {
      const res = await openCatalogUdAction({ factoryId, trackingNo });
      if ("error" in res) {
        setError(res.error);
        return;
      }
      router.push(`/ud-automation/${res.id}?factory=${factoryId}`);
    });
  }

  return (
    <div className="card p-5">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-800">UD catalog</h3>
        <span className="text-xs text-slate-400">{count} UD{count === 1 ? "" : "s"} for this factory</span>
      </div>
      <p className="mb-3 mt-1 text-sm text-slate-500">
        Import the BGMEA UD list for {factoryLabel}, then search a UD number and open its workflow. Rows for other factories are reported but not imported here.
      </p>

      {/* Import */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <input
          ref={fileRef}
          type="file"
          accept=".txt,.csv,.tsv"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void uploadFile(f);
          }}
        />
        <button type="button" className="btn-ghost btn-sm" disabled={uploading} onClick={() => fileRef.current?.click()}>
          {uploading ? "Importing…" : "Import UD list (.txt / .csv / .tsv)"}
        </button>
      </div>

      {error ? <div className="mb-3 rounded-md border border-rose-200 bg-rose-50 p-2 text-sm text-rose-700">{error}</div> : null}

      {report ? (
        <div className="mb-4 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
          <div className="font-medium">
            Imported {report.imported} new{report.updated ? `, updated ${report.updated}` : ""}{report.unchanged ? `, ${report.unchanged} unchanged` : ""}.
          </div>
          {(report.duplicates || report.malformed || report.otherFactory) ? (
            <ul className="mt-1 list-disc pl-5 text-emerald-800">
              {report.duplicates ? <li>{report.duplicates} duplicate row(s) in the file (imported once).</li> : null}
              {report.malformed ? <li>{report.malformed} malformed row(s) skipped and reported below.</li> : null}
              {report.otherFactory ? (
                <li>
                  {report.otherFactory} row(s) for other factories ignored
                  {report.otherFactoryCounts.length ? ` (${report.otherFactoryCounts.map((o) => `${o.factoryId}: ${o.rows}`).join(", ")})` : ""} — import those from their own workspace.
                </li>
              ) : null}
            </ul>
          ) : null}
          {report.malformedRows.length ? (
            <details className="mt-2">
              <summary className="cursor-pointer text-emerald-800">Show malformed rows</summary>
              <ul className="mt-1 max-h-40 overflow-auto text-xs text-slate-600">
                {report.malformedRows.map((m) => (
                  <li key={m.line}>Line {m.line}: {m.reason}</li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      ) : null}

      {/* Search + list */}
      <div className="mb-2">
        <label className="label">Search UD number</label>
        <input className="input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="e.g. UD4148 or 2026" />
      </div>

      <div className="max-h-72 overflow-auto rounded-md border border-slate-100">
        {rows.length === 0 ? (
          <div className="p-4 text-center text-sm text-slate-400">
            {count === 0 ? "No catalog yet — import the UD list above." : searching ? "Searching…" : "No matching UD numbers."}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50/70">
              <tr>
                <th className="th">UD number</th>
                <th className="th">UD date</th>
                <th className="th"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((r) => (
                <tr key={r.trackingNo} className="hover:bg-slate-50/60">
                  <td className="td font-mono text-xs">{r.trackingNo}</td>
                  <td className="td text-xs text-slate-500">{r.udDate || "—"}</td>
                  <td className="td text-right">
                    <button type="button" className="btn-ghost btn-sm" disabled={opening} onClick={() => open(r.trackingNo)}>
                      {r.hasRecord ? "Resume" : "Open"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
