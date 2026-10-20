"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import { uploadBookingBatchAction, type UploadState } from "@/app/actions/booking-batch";

const DEFAULT_COMPANY = "ANANTA GARMENTS LIMITED";
const DEFAULT_BUYER = "H&M HENNES & MAURITZ GBC AB";

function Submit({ count }: { count: number }) {
  const { pending } = useFormStatus();
  return (
    <button className="btn-primary" disabled={pending || count === 0}>
      {pending ? "Uploading & processing…" : count > 0 ? `Upload & process ${count} PDF${count > 1 ? "s" : ""}` : "Select PDFs to start"}
    </button>
  );
}

export function BookingBatchUpload() {
  const [state, action] = useFormState<UploadState, FormData>(uploadBookingBatchAction, {});
  const [files, setFiles] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const addFiles = (list: FileList | null) => {
    if (!list) return;
    const pdfs = Array.from(list).filter((f) => /\.pdf$/i.test(f.name));
    // De-dupe by name+size in the picker; the server de-dupes by content hash.
    const merged = [...files];
    for (const f of pdfs) if (!merged.some((m) => m.name === f.name && m.size === f.size)) merged.push(f);
    setFiles(merged);
    syncInput(merged);
  };

  // Keep a hidden <input type=file> in sync so the files post with the form.
  const syncInput = (list: File[]) => {
    if (!inputRef.current) return;
    const dt = new DataTransfer();
    for (const f of list) dt.items.add(f);
    inputRef.current.files = dt.files;
  };

  const removeAt = (i: number) => {
    const next = files.filter((_, idx) => idx !== i);
    setFiles(next);
    syncInput(next);
  };

  return (
    <div className="space-y-4">
      <form action={action} className="card space-y-4 p-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label">Company (default)</label>
            <input name="company" className="input" defaultValue={DEFAULT_COMPANY} />
          </div>
          <div>
            <label className="label">Buyer</label>
            <input name="buyer" className="input" defaultValue={DEFAULT_BUYER} />
          </div>
        </div>

        <div
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => { e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files); }}
          onClick={() => inputRef.current?.click()}
          className={`flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed px-6 py-10 text-center transition ${
            dragging ? "border-ananta bg-sky-50" : "border-slate-300 bg-slate-50 hover:bg-slate-100"
          }`}
        >
          <div className="text-3xl text-slate-400">⬆</div>
          <p className="mt-2 text-sm font-medium text-slate-700">Drag &amp; drop packing-list PDFs here, or click to browse</p>
          <p className="mt-1 text-xs text-slate-400">Multiple files · 10–15+ per batch · PDF only</p>
          <input ref={inputRef} type="file" name="files" accept="application/pdf,.pdf" multiple className="hidden" onChange={(e) => addFiles(e.target.files)} />
        </div>

        {files.length > 0 ? (
          <div className="rounded-md border border-slate-200">
            <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2 text-xs font-semibold text-slate-600">
              <span>{files.length} file{files.length > 1 ? "s" : ""} selected</span>
              <button type="button" className="text-rose-600 hover:underline" onClick={() => { setFiles([]); syncInput([]); }}>Clear</button>
            </div>
            <ul className="max-h-48 overflow-y-auto">
              {files.map((f, i) => (
                <li key={`${f.name}-${i}`} className="flex items-center justify-between px-3 py-1.5 text-xs">
                  <span className="truncate text-slate-700">{f.name}</span>
                  <span className="ml-3 shrink-0 text-slate-400">{(f.size / 1024).toFixed(0)} KB</span>
                  <button type="button" className="ml-3 shrink-0 text-slate-400 hover:text-rose-600" onClick={() => removeAt(i)}>✕</button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <p className="text-xs text-slate-400">
          Originals are stored unchanged. Each PDF is extracted (Gross Weight, Total Cartons, Total Quantity, PO, country),
          searched on the Damco Shipper Portal ({/* mode is shown on the batch page */}current integration mode), matched, and —
          only when all three values match and the booking is CONFIRMED — a verified PDF is produced. Live portal actions are gated.
        </p>
        <Submit count={files.length} />
      </form>

      {state.error ? <div className="card p-4 text-sm text-rose-600">{state.error}</div> : null}
      {state.batchId ? (
        <div className="card p-5 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">Batch created:</span>
            <Link href={`/booking/${state.batchId}`} className="font-mono text-ananta hover:underline">{state.batchId.slice(0, 10)}</Link>
            <span className="badge bg-green-100 text-green-800">{state.accepted} accepted</span>
            {state.duplicates ? <span className="badge bg-slate-100 text-slate-600">{state.duplicates} duplicate(s) skipped</span> : null}
            {state.rejected && state.rejected.length ? <span className="badge bg-rose-100 text-rose-700">{state.rejected.length} rejected</span> : null}
          </div>
          {state.rejected && state.rejected.length ? (
            <ul className="ml-4 mt-2 list-disc text-xs text-rose-600">
              {state.rejected.map((r, i) => <li key={i}>{r.name}: {r.reason}</li>)}
            </ul>
          ) : null}
          <Link href={`/booking/${state.batchId}`} className="btn-primary mt-3 text-xs">Open batch dashboard →</Link>
        </div>
      ) : null}
    </div>
  );
}
