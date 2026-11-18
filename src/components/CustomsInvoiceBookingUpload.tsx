"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

/**
 * Bulk booking-PDF uploader shown on the Customs Invoice list page
 * (user rule 2026-11-12). Multiple PDFs at once; each is parsed, matched by
 * `<orderNo> <marketSubCode>.pdf` filename to existing ShipmentScheduleRow(s),
 * and only the PDF-derived fields get written. Invoices auto-sync on next
 * open — this uploader doesn't create schedules or rows.
 *
 * Shows a per-file outcome table after the upload so the operator can see
 * what matched, what was skipped, and which invoices now have fresh data.
 */
interface FileResult {
  filename: string;
  outcome: "matched" | "skipped_no_invoice" | "skipped_bad_filename" | "skipped_empty_pdf" | "error";
  reason?: string;
  orderNoPrefix: string;
  marketSubCode: string;
  updatedInvoiceIds: string[];
  filledFields: Record<string, string | number>;
}

interface UploadResponse {
  ok: boolean;
  totalFiles: number;
  matched: number;
  skipped: number;
  errors: number;
  files: FileResult[];
  error?: string;
}

export function CustomsInvoiceBookingUpload() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [resp, setResp] = useState<UploadResponse | null>(null);
  const [error, setError] = useState<string>("");
  const [dragActive, setDragActive] = useState(false);

  const upload = async (files: FileList | File[]) => {
    const list = Array.from(files).filter((f) => /\.pdf$/i.test(f.name));
    if (list.length === 0) {
      setError("Only .pdf files are accepted.");
      return;
    }
    setError("");
    setResp(null);
    setBusy(true);
    try {
      const fd = new FormData();
      for (const f of list) fd.append("files", f, f.name);
      const r = await fetch("/api/customs-invoice/booking-upload", { method: "POST", body: fd });
      const body = (await r.json()) as UploadResponse;
      if (!r.ok) {
        setError(body.error || `HTTP ${r.status}`);
      } else {
        setResp(body);
        if (body.matched > 0) router.refresh();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  return (
    <div className="card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-2">
        <div>
          <div className="text-sm font-semibold text-slate-700">📑 Booking PDFs → Customs Invoice</div>
          <div className="text-[11px] text-slate-500">
            Drop H&amp;M Booking Confirmation PDFs here. Filename format: <code className="font-mono">&lt;OrderNo&gt; &lt;Market+Sub&gt;.pdf</code>
            {" "}(e.g. <code className="font-mono">643159 PLW067.pdf</code>). Multiple files at once; existing Shipment rows get refreshed, invoices pick up the new fields on next open.
          </div>
        </div>
      </div>

      <div
        onDragOver={(e) => { e.preventDefault(); setDragActive(true); }}
        onDragLeave={() => setDragActive(false)}
        onDrop={(e) => { e.preventDefault(); setDragActive(false); if (e.dataTransfer.files.length) upload(e.dataTransfer.files); }}
        className={`mt-3 flex min-h-[90px] cursor-pointer flex-col items-center justify-center gap-1 rounded border-2 border-dashed p-4 text-center text-xs transition-colors ${dragActive ? "border-sky-400 bg-sky-50" : "border-slate-200 hover:border-slate-300"}`}
        onClick={() => inputRef.current?.click()}
      >
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,.pdf"
          multiple
          hidden
          onChange={(e) => { if (e.target.files && e.target.files.length) upload(e.target.files); }}
        />
        {busy ? (
          <span className="text-slate-600">Parsing &amp; matching…</span>
        ) : (
          <>
            <span className="font-semibold text-slate-700">Click or drop PDFs</span>
            <span className="text-[11px] text-slate-500">PDF only · nothing is uploaded until files land here</span>
          </>
        )}
      </div>

      {error ? (
        <div className="mt-3 rounded border border-rose-200 bg-rose-50 p-2 text-xs text-rose-700">{error}</div>
      ) : null}

      {resp ? (
        <div className="mt-3 space-y-2">
          <div className="flex flex-wrap gap-3 text-xs">
            <span>📥 <b>{resp.totalFiles}</b> file(s)</span>
            <span className="text-emerald-700">✓ <b>{resp.matched}</b> matched</span>
            <span className="text-amber-700">⚠ <b>{resp.skipped}</b> skipped</span>
            {resp.errors > 0 ? <span className="text-rose-700">✗ <b>{resp.errors}</b> error(s)</span> : null}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[11px]">
              <thead className="bg-slate-50">
                <tr>
                  <th className="th">File</th>
                  <th className="th">Order / Market+Sub</th>
                  <th className="th">Outcome</th>
                  <th className="th">Fields filled</th>
                  <th className="th">Invoices affected</th>
                </tr>
              </thead>
              <tbody>
                {resp.files.map((f) => (
                  <tr key={f.filename} className="border-t border-slate-100 align-top">
                    <td className="td font-mono">{f.filename}</td>
                    <td className="td font-mono">
                      {f.orderNoPrefix || "—"}{f.marketSubCode ? ` / ${f.marketSubCode}` : ""}
                    </td>
                    <td className="td">
                      {f.outcome === "matched" ? (
                        <span className="badge bg-emerald-100 text-emerald-700">matched</span>
                      ) : f.outcome === "error" ? (
                        <span className="badge bg-rose-100 text-rose-700" title={f.reason}>error</span>
                      ) : (
                        <span className="badge bg-amber-100 text-amber-700" title={f.reason}>{f.outcome.replace("skipped_", "skipped · ")}</span>
                      )}
                      {f.reason ? <div className="mt-1 text-[10px] text-slate-500">{f.reason}</div> : null}
                    </td>
                    <td className="td">
                      {Object.keys(f.filledFields).length === 0 ? (
                        <span className="text-slate-400">—</span>
                      ) : (
                        <div className="flex max-w-xs flex-wrap gap-1">
                          {Object.entries(f.filledFields).map(([k, v]) => (
                            <span key={k} className="rounded bg-slate-100 px-1 py-0.5 text-[10px]" title={String(v)}>
                              {k}
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="td">
                      {f.updatedInvoiceIds.length === 0 ? (
                        <span className="text-slate-400">—</span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {f.updatedInvoiceIds.map((id) => (
                            <Link key={id} href={`/customs-invoice/${id}`} className="text-ananta hover:underline">
                              {id.slice(0, 8)}…
                            </Link>
                          ))}
                        </div>
                      )}
                    </td>
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
