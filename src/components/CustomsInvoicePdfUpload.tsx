"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

interface PdfRow { id: string; originalName: string; sizeBytes: number; uploadedAt: string }

export function CustomsInvoicePdfUpload({ invoiceId, pdfs }: { invoiceId: string; pdfs: PdfRow[] }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>("");
  const [err, setErr] = useState<string>("");
  const [found, setFound] = useState<string[]>([]);

  async function onUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true); setMsg(""); setErr(""); setFound([]);
    const body = new FormData();
    body.append("file", file);
    try {
      const r = await fetch(`/api/customs-invoice/${invoiceId}/upload`, { method: "POST", body });
      const payload = await r.json();
      if (!r.ok) throw new Error(payload?.error ?? `Upload failed (${r.status})`);
      if (payload.duplicate) {
        setMsg("This PDF was already uploaded for this invoice (same sha256). No fields changed.");
      } else {
        setMsg(`Extracted ${payload.foundLabels?.length ?? 0} field(s); updated ${payload.updated} invoice field(s).`);
        setFound(payload.foundLabels ?? []);
      }
      if (inputRef.current) inputRef.current.value = "";
      router.refresh();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Upload failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card p-5">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-700">Upload invoice PDF — auto-extract fields</h3>
        <span className="text-xs text-slate-400">{pdfs.length} attached</span>
      </div>
      <p className="mb-3 text-xs text-slate-500">
        Drop a single invoice PDF; the parser pulls labelled fields (Invoice No, EXP No, dates, Order No, Qty, Unit Price,
        Weights, Cartons) and writes them into the invoice. Every field is still editable afterwards. Duplicate uploads
        (same sha256) are no-ops.
      </p>
      <label className="btn-primary cursor-pointer text-xs">
        {busy ? "Uploading…" : "📎 Choose PDF"}
        <input ref={inputRef} type="file" accept="application/pdf,.pdf" className="hidden" onChange={onUpload} disabled={busy} />
      </label>
      {msg ? <p className="mt-2 text-xs text-green-700">{msg}</p> : null}
      {err ? <p className="mt-2 text-xs text-rose-700">{err}</p> : null}
      {found.length ? (
        <ul className="mt-2 flex flex-wrap gap-1 text-[11px]">
          {found.map((f, i) => <li key={i} className="badge bg-sky-100 text-sky-800">{f}</li>)}
        </ul>
      ) : null}

      {pdfs.length ? (
        <table className="mt-4 w-full text-xs">
          <thead className="bg-slate-50">
            <tr><th className="th">File</th><th className="th">Size</th><th className="th">Uploaded</th></tr>
          </thead>
          <tbody>
            {pdfs.map((p) => (
              <tr key={p.id} className="border-t border-slate-50">
                <td className="td font-mono text-xs">{p.originalName}</td>
                <td className="td text-right">{(p.sizeBytes / 1024).toFixed(1)} kB</td>
                <td className="td text-slate-400">{p.uploadedAt.slice(0, 16).replace("T", " ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}
