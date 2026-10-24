"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { combineAllRows, combineOneRow, saveMasterCells } from "@/app/actions/pdf-combiner";

export interface ManagerCol { name: string; index: number }
export interface ManagerRow { rowNo: number; cells: string[]; eligible: boolean; reason?: string }
export interface ManagerMaster {
  fileName: string; version: number; updatedAt: string; updatedBy: string; eligible: number; sheetName: string; headerRowNo: number;
}

export function PdfCombinerManager({
  master, cols, rows, rootConfigured, folderNames, configError,
}: {
  master: ManagerMaster | null;
  cols: ManagerCol[];
  rows: ManagerRow[];
  rootConfigured: boolean;
  folderNames: string[];
  configError?: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [edits, setEdits] = useState<Map<string, string>>(new Map()); // "rowNo:colIndex" -> value
  const [query, setQuery] = useState("");
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [busyRow, setBusyRow] = useState<number | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const key = (rowNo: number, col: number) => `${rowNo}:${col}`;
  const cellValue = (r: ManagerRow, col: ManagerCol) => {
    const e = edits.get(key(r.rowNo, col.index));
    return e !== undefined ? e : (r.cells[col.index - 1] ?? "");
  };
  const setCell = (rowNo: number, col: number, original: string, value: string) => {
    setEdits((prev) => {
      const next = new Map(prev);
      if (value === original) next.delete(key(rowNo, col));
      else next.set(key(rowNo, col), value);
      return next;
    });
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => `${r.rowNo} ${r.cells.join(" ")}`.toLowerCase().includes(q));
  }, [rows, query]);

  const dirty = edits.size > 0;

  const doSave = () =>
    start(async () => {
      setMsg(null);
      const payload = [...edits.entries()].map(([k, value]) => {
        const [rowNo, col] = k.split(":").map(Number);
        return { rowNo, col, value };
      });
      const res = await saveMasterCells(payload);
      if (res.error) setMsg({ tone: "err", text: res.error });
      else {
        setMsg({ tone: "ok", text: `Saved ${res.saved} change(s). Master is now v${res.version} · ${res.eligible} eligible row(s).` });
        setEdits(new Map());
        router.refresh();
      }
    });

  const doCombineAll = () =>
    start(async () => {
      setMsg(null);
      if (dirty) { setMsg({ tone: "err", text: "Save your edits first (or discard them) before combining." }); return; }
      const res = await combineAllRows();
      if (res.error) setMsg({ tone: "err", text: res.error });
      else if (res.runId) router.push(`/pdf-combiner/${res.runId}`);
    });

  const doCombineRow = (rowNo: number) =>
    start(async () => {
      setMsg(null);
      if (dirty) { setMsg({ tone: "err", text: "Save your edits first (or discard them) before combining." }); return; }
      setBusyRow(rowNo);
      const res = await combineOneRow(rowNo);
      setBusyRow(null);
      if (res.error) setMsg({ tone: "err", text: res.error });
      else if (res.runId) router.push(`/pdf-combiner/${res.runId}`);
    });

  const doReimport = () =>
    start(async () => {
      setMsg(null);
      const f = fileRef.current?.files?.[0];
      if (!f) { setMsg({ tone: "err", text: "Choose an .xlsx file to import." }); return; }
      const fd = new FormData();
      fd.append("master", f);
      const r = await fetch("/api/pdf-combiner/master/reimport", { method: "POST", body: fd });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) setMsg({ tone: "err", text: j.error || `Import failed (${r.status}).` });
      else {
        setMsg({ tone: "ok", text: `Imported "${j.fileName}" (v${j.version}) — ${j.eligible} eligible of ${j.totalRows} rows.` });
        if (fileRef.current) fileRef.current.value = "";
        setEdits(new Map());
        router.refresh();
      }
    });

  if (!rootConfigured) {
    return (
      <div className="card border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
        The server source folder is not configured. Set <code>PDF_COMBINER_ROOT</code> in <code>.env</code> to the Combiner Folders
        share, then restart the portal.
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {configError ? <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{configError}</div> : null}

      {/* Master header + actions */}
      <div className="card p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm">
            <div className="font-semibold text-slate-800">📊 {master?.fileName ?? "No active master"}</div>
            {master ? (
              <div className="text-xs text-slate-500">
                Sheet “{master.sheetName}” · v{master.version} · {master.eligible} eligible row(s) · updated {master.updatedAt} by {master.updatedBy}
              </div>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <a href="/api/pdf-combiner/master/download" className="btn-ghost text-xs">⬇ Download Excel</a>
            <button onClick={doSave} disabled={pending || !dirty} className="btn-ghost text-xs disabled:opacity-40">💾 Save edits{dirty ? ` (${edits.size})` : ""}</button>
            <button onClick={doCombineAll} disabled={pending || !master || master.eligible === 0} className="btn-primary text-xs disabled:opacity-40">▶ Combine All Rows</button>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
          <span className="text-xs text-slate-500">Re-import &amp; replace:</span>
          <input ref={fileRef} type="file" accept=".xlsx" className="text-xs file:mr-2 file:rounded file:border-0 file:bg-slate-100 file:px-2 file:py-1" />
          <button onClick={doReimport} disabled={pending} className="btn-ghost text-xs">⇪ Import</button>
          <span className="ml-auto text-xs text-slate-400">{folderNames.length} folder(s) on the share</span>
        </div>
        {msg ? <div className={`mt-3 text-sm ${msg.tone === "ok" ? "text-green-700" : "text-rose-600"}`}>{msg.text}</div> : null}
      </div>

      {/* Editable / searchable grid */}
      <div className="card">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
          <h3 className="text-sm font-semibold text-slate-700">Excel data — {master?.sheetName} ({rows.length} rows)</h3>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search rows…"
            className="w-48 rounded-md border border-slate-200 px-2 py-1 text-xs"
          />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-slate-50">
              <tr>
                <th className="th sticky left-0 bg-slate-50">Row</th>
                <th className="th">Eligible</th>
                {cols.map((c) => <th key={c.index} className="th whitespace-nowrap">{c.name}</th>)}
                <th className="th">Action</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.rowNo} className="border-t border-slate-100 align-top">
                  <td className="td sticky left-0 bg-white font-mono">{r.rowNo}</td>
                  <td className="td">
                    {r.eligible
                      ? <span className="badge bg-green-100 text-green-800">yes</span>
                      : <span className="badge bg-slate-100 text-slate-500" title={r.reason}>no</span>}
                  </td>
                  {cols.map((c) => {
                    const original = r.cells[c.index - 1] ?? "";
                    const val = cellValue(r, c);
                    const changed = edits.has(key(r.rowNo, c.index));
                    return (
                      <td key={c.index} className="td">
                        <input
                          value={val}
                          onChange={(e) => setCell(r.rowNo, c.index, original, e.target.value)}
                          className={`w-28 rounded border px-1 py-0.5 ${changed ? "border-amber-400 bg-amber-50" : "border-transparent hover:border-slate-200"}`}
                        />
                      </td>
                    );
                  })}
                  <td className="td whitespace-nowrap">
                    <button
                      onClick={() => doCombineRow(r.rowNo)}
                      disabled={pending || !r.eligible}
                      className="text-sky-700 hover:underline disabled:text-slate-300"
                      title={r.eligible ? "Combine this row" : r.reason}
                    >
                      {busyRow === r.rowNo ? "…" : "▶ Combine row"}
                    </button>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 ? (
                <tr><td className="td text-slate-400" colSpan={cols.length + 3}>No rows match “{query}”.</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <div className="border-t border-slate-100 px-4 py-2 text-xs text-slate-400">
          Edit any cell and click “Save edits” to update the master; then Combine. Changes are versioned and the original workbook
          structure is preserved. Eligible = has an invoice/serial key and at least one complete folder/file document slot.
        </div>
      </div>
    </div>
  );
}
