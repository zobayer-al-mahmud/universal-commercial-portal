"use client";

import { useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { useRouter } from "next/navigation";
import type { CutoffRow } from "./ShipmentScheduleCutoffs";

interface UploadResult {
  rowId: string;
  fileName: string;
  orderNoPrefix: string;
  marketCode: string;
  marketSubCode: string;
  matched: boolean;
  matchReason: string;
  bookingStatus: string;
  pdfPcs: number | null;
  cartons: number | null;
}

export function ShipmentScheduleUpload({ scheduleId, cutoffs }: { scheduleId: string; cutoffs: CutoffRow[] }) {
  const router = useRouter();
  const [cutoffId, setCutoffId] = useState<string>(cutoffs[0]?.id ?? "");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>("");
  const [results, setResults] = useState<UploadResult[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  function onFiles(fs: FileList | null) {
    if (!fs || fs.length === 0) return;
    const pdfs = Array.from(fs).filter((f) => f.name.toLowerCase().endsWith(".pdf"));
    setFiles((prev) => [...prev, ...pdfs]);
  }
  function onInputChange(e: ChangeEvent<HTMLInputElement>) {
    onFiles(e.target.files);
    if (inputRef.current) inputRef.current.value = "";
  }
  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    onFiles(e.dataTransfer.files);
  }

  function removeAt(idx: number) {
    setFiles((prev) => prev.filter((_, i) => i !== idx));
  }

  async function onProcess() {
    setError("");
    setResults([]);
    if (!cutoffId) return setError("Select a cut-off first.");
    if (files.length === 0) return setError("Add at least one PDF.");
    setBusy(true);
    try {
      const fd = new FormData();
      fd.set("cutoffId", cutoffId);
      for (const f of files) fd.append("files", f);
      const r = await fetch(`/api/shipment-schedule/${scheduleId}/upload`, { method: "POST", body: fd });
      const data = await r.json();
      if (!r.ok) {
        setError(data.error ?? "Upload failed.");
        return;
      }
      setResults(data.results ?? []);
      setFiles([]);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed.");
    } finally {
      setBusy(false);
    }
  }

  if (cutoffs.length === 0) {
    return (
      <div className="card p-5">
        <h3 className="mb-2 text-sm font-semibold text-slate-800">② Upload booking-confirmation PDFs</h3>
        <p className="text-xs text-amber-700">Add at least one cut-off above before uploading.</p>
      </div>
    );
  }

  return (
    <div className="card p-5">
      <h3 className="mb-1 text-sm font-semibold text-slate-800">② Upload booking-confirmation PDFs</h3>
      <p className="mb-3 text-xs text-slate-500">
        Select the cut-off, drop or browse the PDFs (any number), then press Process. The OrderNo from each
        PDF&apos;s filename is matched against the H&M Sales Contract POs; matched rows have Buyer Code, Cont.No.,
        Date, Style, FOB, Composition and PCS filled automatically.
      </p>

      <div className="mb-3 grid gap-3 sm:grid-cols-[220px_1fr]">
        <label className="block">
          <div className="mb-1 text-xs font-medium text-slate-600">Cut-off</div>
          <select
            value={cutoffId}
            onChange={(e) => setCutoffId(e.target.value)}
            className="input w-full"
          >
            {cutoffs.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}{c.date ? ` — ${c.date}` : ""}
              </option>
            ))}
          </select>
        </label>

        <div
          onDrop={onDrop}
          onDragOver={(e) => e.preventDefault()}
          className="flex min-h-[90px] items-center justify-center rounded-md border-2 border-dashed border-slate-300 bg-slate-50 p-3 text-xs text-slate-500"
        >
          <input
            ref={inputRef}
            type="file"
            multiple
            accept="application/pdf,.pdf"
            onChange={onInputChange}
            className="hidden"
            id="shipment-pdf-input"
          />
          <label htmlFor="shipment-pdf-input" className="cursor-pointer">
            <strong>Click to add PDFs</strong> or drag &amp; drop. Filename pattern: <span className="font-mono">&lt;OrderNo&gt; &lt;Market+Sub&gt;.pdf</span> (e.g. <span className="font-mono">569959 AUW118.pdf</span>).
          </label>
        </div>
      </div>

      {files.length > 0 ? (
        <div className="mb-3 rounded-md border border-slate-200 bg-white p-3">
          <div className="mb-2 text-xs font-medium text-slate-600">Pending ({files.length})</div>
          <ul className="divide-y divide-slate-100 text-xs">
            {files.map((f, i) => (
              <li key={i} className="flex items-center justify-between py-1">
                <span className="font-mono">{f.name}</span>
                <button className="text-rose-600 hover:underline" onClick={() => removeAt(i)}>remove</button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="flex items-center gap-3">
        <button className="btn-primary text-xs" onClick={onProcess} disabled={busy || files.length === 0}>
          {busy ? "Processing…" : `▶ Process ${files.length || ""} PDF(s)`}
        </button>
        {error ? <span className="text-xs text-rose-700">{error}</span> : null}
      </div>

      {results.length > 0 ? (
        <div className="mt-4">
          <div className="mb-2 text-xs font-medium text-slate-600">Just processed</div>
          <table className="w-full text-xs">
            <thead className="bg-slate-50">
              <tr>
                <th className="th">File</th>
                <th className="th">OrderNo</th>
                <th className="th">Market</th>
                <th className="th">Match</th>
                <th className="th">Booking</th>
                <th className="th">PCS</th>
                <th className="th">Cartons</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r) => (
                <tr key={r.rowId} className="border-t border-slate-100">
                  <td className="td font-mono">{r.fileName}</td>
                  <td className="td font-mono">{r.orderNoPrefix || "—"}</td>
                  <td className="td font-mono">
                    {r.marketSubCode || "—"}
                    {r.marketCode && r.marketCode !== r.marketSubCode ? ` (${r.marketCode})` : ""}
                  </td>
                  <td className="td">
                    <span
                      className={`badge ${
                        r.matched ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-800"
                      }`}
                    >
                      {r.matched ? "matched" : r.matchReason}
                    </span>
                  </td>
                  <td className="td">{r.bookingStatus || "—"}</td>
                  <td className="td">{r.pdfPcs ?? "—"}</td>
                  <td className="td">{r.cartons ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
