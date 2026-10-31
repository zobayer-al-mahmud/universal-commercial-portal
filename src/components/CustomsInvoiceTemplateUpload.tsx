"use client";

import { useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { useRouter } from "next/navigation";

interface UploadResult {
  file: string;
  ok: boolean;
  countryCode?: string;
  variant?: string;
  error?: string;
}

export function CustomsInvoiceTemplateUpload() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>("");
  const [results, setResults] = useState<UploadResult[]>([]);

  function addFiles(incoming: FileList | null) {
    if (!incoming) return;
    const xlsx = Array.from(incoming).filter((f) => f.name.toLowerCase().endsWith(".xlsx"));
    if (xlsx.length === 0) return;
    setFiles((prev) => [...prev, ...xlsx]);
    setError("");
    setResults([]);
  }
  function onInput(e: ChangeEvent<HTMLInputElement>) {
    addFiles(e.target.files);
    if (inputRef.current) inputRef.current.value = "";
  }
  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    addFiles(e.dataTransfer.files);
  }
  function remove(i: number) {
    setFiles((prev) => prev.filter((_, idx) => idx !== i));
  }
  function reset() {
    setFiles([]);
    setResults([]);
    setError("");
  }

  async function upload() {
    if (files.length === 0) return;
    setBusy(true);
    setError("");
    setResults([]);
    try {
      const fd = new FormData();
      for (const f of files) fd.append("files", f);
      const r = await fetch("/api/customs-invoice/templates/upload", { method: "POST", body: fd });
      const data = await r.json();
      if (!r.ok) {
        setError(data.error ?? "Upload failed.");
        return;
      }
      setResults(data.results ?? []);
      // Keep only files that failed, so the user can fix the name and retry.
      const failed = new Set<string>((data.results as UploadResult[]).filter((x) => !x.ok).map((x) => x.file));
      setFiles((prev) => prev.filter((f) => failed.has(f.name)));
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card p-5">
      <h3 className="text-sm font-semibold text-slate-800">⬆ Upload invoice templates</h3>
      <p className="mt-1 text-xs text-slate-500">
        Drop one or more .xlsx template files. The filename decides the match —
        <span className="font-mono"> &lt;invoiceNo&gt; &lt;countryCode&gt;[(subCode)].xlsx</span>
        {" "}(e.g. <span className="font-mono">45254 NH.xlsx</span>, <span className="font-mono">45237 OB.xlsx</span>,
        {" "}<span className="font-mono">45248 OF-(IT).xlsx</span>, <span className="font-mono">45239 OE (PLW067).xlsx</span>).
        When an order&apos;s country / sub code matches, that template is used; template cells provide only the layout — fields without data for the order stay blank for manual filling.
      </p>

      <div
        onDrop={onDrop}
        onDragOver={(e) => e.preventDefault()}
        className="mt-3 flex min-h-[90px] items-center justify-center rounded-md border-2 border-dashed border-slate-300 bg-slate-50 p-3 text-xs text-slate-500"
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          onChange={onInput}
          className="hidden"
          id="template-upload-input"
        />
        <label htmlFor="template-upload-input" className="cursor-pointer">
          <strong>Click to add .xlsx templates</strong> or drag &amp; drop (multiple allowed).
        </label>
      </div>

      {files.length > 0 ? (
        <div className="mt-3 rounded-md border border-slate-200 bg-white p-3">
          <div className="mb-2 text-xs font-medium text-slate-600">Pending ({files.length})</div>
          <ul className="divide-y divide-slate-100 text-xs">
            {files.map((f, i) => (
              <li key={`${f.name}-${i}`} className="flex items-center justify-between py-1">
                <span className="font-mono">{f.name}</span>
                <button className="text-rose-600 hover:underline" onClick={() => remove(i)} disabled={busy}>remove</button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="mt-3 flex items-center gap-2">
        <button className="btn-primary text-xs" onClick={upload} disabled={busy || files.length === 0}>
          {busy ? "Uploading…" : `⬆ Upload ${files.length || ""} template(s)`}
        </button>
        {files.length > 0 || results.length > 0 ? (
          <button className="btn-ghost text-xs" onClick={reset} disabled={busy}>Reset</button>
        ) : null}
        {error ? <span className="text-xs text-rose-700">{error}</span> : null}
      </div>

      {results.length > 0 ? (
        <div className="mt-3 max-h-[220px] overflow-y-auto rounded-md border border-slate-200">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-slate-50">
              <tr>
                <th className="th">File</th>
                <th className="th">Code</th>
                <th className="th">Sub</th>
                <th className="th">Status</th>
                <th className="th">Note</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r, i) => (
                <tr key={`${r.file}-${i}`} className="border-t border-slate-100">
                  <td className="td font-mono">{r.file}</td>
                  <td className="td font-mono">{r.countryCode ?? "—"}</td>
                  <td className="td font-mono">{r.variant || "—"}</td>
                  <td className="td">
                    <span className={`badge ${r.ok ? "bg-green-100 text-green-800" : "bg-rose-100 text-rose-800"}`}>
                      {r.ok ? "saved" : "rejected"}
                    </span>
                  </td>
                  <td className="td text-rose-700">{r.error ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

export function TemplateDeleteButton({ filename }: { filename: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>("");

  async function onClick() {
    if (!confirm(`Delete ${filename}? This removes the uploaded template from the server.`)) return;
    setBusy(true);
    setErr("");
    try {
      const r = await fetch("/api/customs-invoice/templates/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename }),
      });
      const data = await r.json().catch(() => ({ error: "delete failed" }));
      if (!r.ok) {
        setErr(data.error ?? "delete failed");
        return;
      }
      router.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "delete failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        className="text-[10px] text-rose-600 hover:underline disabled:text-slate-400"
        onClick={onClick}
        disabled={busy}
      >
        {busy ? "deleting…" : "delete"}
      </button>
      {err ? <span className="ml-1 text-[10px] text-rose-700">{err}</span> : null}
    </>
  );
}
