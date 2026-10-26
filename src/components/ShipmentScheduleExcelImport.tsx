"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

interface PreviewRow {
  orderNo: string;
  marketCode: string;
  style: string;
  invoiceNo: string;
  disposition: "new" | "duplicate" | "invalid";
  matched: boolean;
  note: string;
}
interface Preview {
  rows: PreviewRow[];
  counts: { total: number; new: number; duplicate: number; invalid: number; matched: number };
}

const dispTone: Record<PreviewRow["disposition"], string> = {
  new: "bg-green-100 text-green-800",
  duplicate: "bg-amber-100 text-amber-800",
  invalid: "bg-rose-100 text-rose-800",
};

export function ShipmentScheduleExcelImport({ scheduleId }: { scheduleId: string }) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  async function doPreview() {
    setMsg(null);
    setPreview(null);
    const f = fileRef.current?.files?.[0];
    if (!f) { setMsg({ tone: "err", text: "Choose an .xlsx file to import." }); return; }
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", f);
      fd.append("mode", "preview");
      const r = await fetch(`/api/shipment-schedule/${scheduleId}/import`, { method: "POST", body: fd });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setMsg({ tone: "err", text: j.error || `Preview failed (${r.status}).` }); return; }
      setPreview(j.preview as Preview);
    } finally {
      setBusy(false);
    }
  }

  async function doCommit() {
    setMsg(null);
    const f = fileRef.current?.files?.[0];
    if (!f) { setMsg({ tone: "err", text: "Choose the .xlsx file again to commit." }); return; }
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", f);
      fd.append("mode", "commit");
      const r = await fetch(`/api/shipment-schedule/${scheduleId}/import`, { method: "POST", body: fd });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setMsg({ tone: "err", text: j.error || `Import failed (${r.status}).` }); return; }
      setMsg({ tone: "ok", text: `Imported ${j.created} new row(s). Skipped ${j.skippedDuplicates} duplicate(s) and ${j.skippedInvalid} invalid.` });
      setPreview(null);
      if (fileRef.current) fileRef.current.value = "";
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card p-4">
      <h3 className="text-sm font-semibold text-slate-800">⇪ Import rows from Excel</h3>
      <p className="mt-1 text-xs text-slate-500">
        Upload an .xlsx in the exported layout (Buyer Code · Cont.No. · Date · OrderNo. · PCS · STYLE · FOB · … · INVOICE · Market+Sub ·
        Market · Mode). Rows are matched by Order No.; invalid numbers and duplicates are reported. Preview before committing.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input ref={fileRef} type="file" accept=".xlsx" className="text-xs file:mr-2 file:rounded file:border-0 file:bg-slate-100 file:px-2 file:py-1" />
        <button onClick={doPreview} disabled={busy} className="btn-ghost text-xs disabled:opacity-40">{busy ? "Working…" : "Preview import"}</button>
      </div>
      {msg ? <div className={`mt-3 text-sm ${msg.tone === "ok" ? "text-green-700" : "text-rose-600"}`}>{msg.text}</div> : null}

      {preview ? (
        <div className="mt-4">
          <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
            <span className="font-semibold text-slate-700">{preview.counts.total} rows</span>
            <span className="text-green-700">{preview.counts.new} new</span>
            <span className="text-amber-700">{preview.counts.duplicate} duplicate</span>
            <span className="text-rose-700">{preview.counts.invalid} invalid</span>
            <span className="text-slate-500">{preview.counts.matched} matched to a Sales Contract</span>
            <button onClick={doCommit} disabled={busy || preview.counts.new === 0} className="btn-primary btn-xs ml-auto disabled:opacity-40">
              {busy ? "Committing…" : `Commit ${preview.counts.new} new row(s)`}
            </button>
          </div>
          <div className="max-h-72 overflow-auto rounded-lg border border-slate-200">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-slate-50 text-slate-500">
                <tr>
                  <th className="th text-left">Order No.</th>
                  <th className="th text-left">Market</th>
                  <th className="th text-left">Style</th>
                  <th className="th text-left">Invoice</th>
                  <th className="th text-left">Disposition</th>
                  <th className="th text-left">Note</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((r, i) => (
                  <tr key={i} className="border-t border-slate-100">
                    <td className="td font-mono">{r.orderNo}</td>
                    <td className="td">{r.marketCode || "—"}</td>
                    <td className="td">{r.style || "—"}</td>
                    <td className="td">{r.invoiceNo || "—"}</td>
                    <td className="td"><span className={`badge ${dispTone[r.disposition]}`}>{r.disposition}</span>{r.matched ? <span className="ml-1 text-[10px] text-slate-400">SC✓</span> : null}</td>
                    <td className="td text-slate-500">{r.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-[11px] text-slate-400">Only rows marked <strong>new</strong> are inserted. Nothing is written until you click Commit.</p>
        </div>
      ) : null}
    </div>
  );
}
