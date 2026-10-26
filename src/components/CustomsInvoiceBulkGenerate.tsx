"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

interface RowResult {
  orderNo: string;
  invoiceId: string;
  created: boolean;
  templateFile: string | null;
  mode: "template" | "fresh";
  note: string;
}
interface Summary {
  runId: string;
  created: number;
  updated: number;
  noTemplate: number;
  failed: number;
  zipBytes: number;
  rows: RowResult[];
  rejected: { row: number; reason: string }[];
}

export function CustomsInvoiceBulkGenerate() {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);

  async function run() {
    setError(null);
    setSummary(null);
    const f = fileRef.current?.files?.[0];
    if (!f) { setError("Choose an .xlsx file of invoice rows."); return; }
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", f);
      const r = await fetch("/api/customs-invoice/bulk", { method: "POST", body: fd });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError(j.error || `Generation failed (${r.status}).`); return; }
      setSummary(j as Summary);
      router.refresh(); // new invoices now appear in the list
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card p-4">
      <h3 className="text-sm font-semibold text-slate-800">⚡ Bulk generate from Excel</h3>
      <p className="mt-1 text-xs text-slate-500">
        Upload an .xlsx with one invoice per row (needs an <strong>Order No.</strong> column and a <strong>Country/Market</strong> code column;
        other columns like Invoice No, Qty, Unit Price, HS Code, weights are mapped when present). Each row is saved as an invoice and
        generated with the template matching its country code. Download them all as a ZIP.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input ref={fileRef} type="file" accept=".xlsx" className="text-xs file:mr-2 file:rounded file:border-0 file:bg-slate-100 file:px-2 file:py-1" />
        <button onClick={run} disabled={busy} className="btn-primary text-xs disabled:opacity-40">{busy ? "Generating…" : "Generate invoices"}</button>
      </div>
      {error ? <div className="mt-3 text-sm text-rose-600">{error}</div> : null}

      {summary ? (
        <div className="mt-4">
          <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
            <span className="text-green-700">{summary.created} created</span>
            <span className="text-sky-700">{summary.updated} updated</span>
            <span className="text-amber-700">{summary.noTemplate} no-template</span>
            <span className="text-rose-700">{summary.failed} failed</span>
            {summary.rejected.length > 0 ? <span className="text-slate-500">{summary.rejected.length} rows skipped</span> : null}
            {summary.created + summary.updated > 0 ? (
              <a href={`/api/customs-invoice/bulk/${summary.runId}/zip`} className="btn-primary btn-xs ml-auto">⬇ Download All (ZIP)</a>
            ) : null}
          </div>
          <div className="max-h-72 overflow-auto rounded-lg border border-slate-200">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-slate-50 text-slate-500">
                <tr><th className="th text-left">Order No.</th><th className="th text-left">Template</th><th className="th text-left">Result</th><th className="th text-left">Note</th><th className="th"></th></tr>
              </thead>
              <tbody>
                {summary.rows.map((r, i) => (
                  <tr key={i} className="border-t border-slate-100">
                    <td className="td font-mono">{r.orderNo}</td>
                    <td className="td">{r.templateFile ? <span className="text-slate-600">{r.templateFile}</span> : <span className="badge bg-amber-100 text-amber-800">no template</span>}</td>
                    <td className="td">{r.invoiceId ? (r.created ? <span className="text-green-700">created</span> : <span className="text-sky-700">updated</span>) : <span className="text-rose-600">failed</span>}</td>
                    <td className="td text-slate-500">{r.note || "—"}</td>
                    <td className="td">{r.invoiceId ? <Link href={`/customs-invoice/${r.invoiceId}`} className="text-sky-700 hover:underline">open →</Link> : null}</td>
                  </tr>
                ))}
                {summary.rejected.map((r, i) => (
                  <tr key={`rej-${i}`} className="border-t border-slate-100 bg-rose-50/40">
                    <td className="td text-slate-400" colSpan={5}>Skipped: {r.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </div>
  );
}
