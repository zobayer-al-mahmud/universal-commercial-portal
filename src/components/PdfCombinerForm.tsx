"use client";

import Link from "next/link";
import { useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import { runPdfCombineAction, type PdfCombineState } from "@/app/actions/pdf-combiner";

function RunButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button className="btn-primary" disabled={pending || disabled}>
      {pending ? "Combining PDFs…" : "▶ Run"}
    </button>
  );
}

export function PdfCombinerForm({ folders, maxFolders, rootConfigured }: { folders: string[]; maxFolders: number; rootConfigured: boolean }) {
  const [state, action] = useFormState<PdfCombineState, FormData>(runPdfCombineAction, {});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [master, setMaster] = useState<string>("");

  const toggle = (name: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else if (next.size < maxFolders) next.add(name);
      return next;
    });

  if (!rootConfigured) {
    return (
      <div className="card border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
        The server source folder is not configured. Set <code>PDF_COMBINER_ROOT</code> in <code>.env</code> to the folder that holds
        the source folders, then restart the portal.
      </div>
    );
  }

  return (
    <form action={action} className="card space-y-5 p-5">
      <div>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-800">① Master Excel</h3>
          <a href="/api/pdf-combiner/template" className="text-xs text-sky-700 hover:underline">⬇ Download master template</a>
        </div>
        <input
          type="file"
          name="master"
          accept=".xlsx,.csv"
          required
          onChange={(e) => setMaster(e.target.files?.[0]?.name ?? "")}
          className="block w-full text-sm text-slate-600 file:mr-3 file:rounded-md file:border-0 file:bg-slate-100 file:px-3 file:py-2 file:text-sm"
        />
        <p className="mt-1 text-xs text-slate-400">
          One row = one combined PDF. Column A “Output PDF Name” (optional), then File 1, File 2, … merged left → right.
        </p>
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-800">② Select folders</h3>
          <div className="flex items-center gap-3 text-xs">
            <span className="text-slate-500">{selected.size} selected{maxFolders ? ` (max ${maxFolders})` : ""}</span>
            <button type="button" className="text-sky-700 hover:underline" onClick={() => setSelected(new Set(folders.slice(0, maxFolders)))}>All</button>
            <button type="button" className="text-sky-700 hover:underline" onClick={() => setSelected(new Set())}>None</button>
          </div>
        </div>
        {folders.length === 0 ? (
          <p className="text-sm text-slate-400">No folders found in the server source root.</p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {folders.map((f) => (
              <label
                key={f}
                className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm ${selected.has(f) ? "border-ananta bg-green-50 text-slate-800" : "border-slate-200 text-slate-600 hover:bg-slate-50"}`}
              >
                <input type="checkbox" name="folders" value={f} checked={selected.has(f)} onChange={() => toggle(f)} />
                <span className="truncate">📁 {f}</span>
              </label>
            ))}
          </div>
        )}
        <p className="mt-1 text-xs text-slate-400">Files are searched inside each selected folder, including all nested sub-folders.</p>
      </div>

      <div className="flex items-center gap-3">
        <RunButton disabled={!master || selected.size === 0} />
        {state.error ? <span className="text-sm text-rose-600">{state.error}</span> : null}
        {state.runId ? (
          <span className="text-sm text-green-700">
            Done — <Link href={`/pdf-combiner/${state.runId}`} className="underline">view results &amp; download</Link>
          </span>
        ) : null}
      </div>
    </form>
  );
}
