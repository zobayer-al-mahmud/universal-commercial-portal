"use client";

import { useRef, useState, type ChangeEvent } from "react";
import { useRouter } from "next/navigation";

interface BulkRowOutcome {
  orderNo: string;
  countryCode: string | null;
  templateUsed: string | null;
  mode: "template" | "fresh" | "error";
  error: string | null;
}

interface BulkSummary {
  totalRows: number;
  generated: number;
  templated: number;
  freshFallback: number;
  errors: number;
}

export function CustomsInvoiceBulkUpload() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState<"preview" | "download" | null>(null);
  const [error, setError] = useState<string>("");
  const [summary, setSummary] = useState<BulkSummary | null>(null);
  const [results, setResults] = useState<BulkRowOutcome[]>([]);

  function onFile(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null;
    setFile(f);
    setSummary(null);
    setResults([]);
    setError("");
  }

  function reset() {
    setFile(null);
    setSummary(null);
    setResults([]);
    setError("");
    if (inputRef.current) inputRef.current.value = "";
  }

  async function preview() {
    if (!file) return;
    setBusy("preview");
    setError("");
    try {
      const fd = new FormData();
      fd.set("xlsx", file);
      fd.set("mode", "json");
      const r = await fetch("/api/customs-invoice/bulk-generate", { method: "POST", body: fd });
      const data = await r.json();
      if (!r.ok) {
        setError(data.error ?? "Preview failed.");
        return;
      }
      setSummary(data.summary);
      setResults(data.results ?? []);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Preview failed.");
    } finally {
      setBusy(null);
    }
  }

  async function download() {
    if (!file) return;
    setBusy("download");
    setError("");
    try {
      const fd = new FormData();
      fd.set("xlsx", file);
      fd.set("mode", "zip");
      const r = await fetch("/api/customs-invoice/bulk-generate", { method: "POST", body: fd });
      if (!r.ok) {
        const data = await r.json().catch(() => ({ error: "Generation failed." }));
        setError(data.error ?? "Generation failed.");
        return;
      }
      setSummary({
        totalRows: Number(r.headers.get("X-Bulk-Generated") ?? 0) + Number(r.headers.get("X-Bulk-Errors") ?? 0),
        generated: Number(r.headers.get("X-Bulk-Generated") ?? 0),
        templated: Number(r.headers.get("X-Bulk-Templated") ?? 0),
        freshFallback: Number(r.headers.get("X-Bulk-Fresh-Fallback") ?? 0),
        errors: Number(r.headers.get("X-Bulk-Errors") ?? 0),
      });
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const cd = r.headers.get("Content-Disposition") ?? "";
      const fileName = /filename="([^"]+)"/.exec(cd)?.[1] ?? "CustomsInvoices_bulk.zip";
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      a.click();
      URL.revokeObjectURL(url);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Generation failed.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="card p-5">
      <div className="mb-2 flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold text-slate-800">⬆ Bulk Excel upload</h3>
          <p className="mt-1 text-xs text-slate-500">
            Upload an .xlsx where every row has an <span className="font-mono">Order No.</span>. For each row we
            prefill from the matching Sales Contract + Shipment Schedule, apply any override columns you provided
            (e.g. <span className="font-mono">Country code</span>, <span className="font-mono">Invoice No.</span>,
            <span className="font-mono"> Consignee</span>, …), and generate the invoice using the country-code
            template that matches it. Rows where no template matches fall back to a plain editable workbook.
          </p>
        </div>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_auto_auto_auto]">
        <label className="flex min-h-[40px] items-center gap-2 rounded-lg border border-dashed border-slate-300 bg-slate-50 px-3 text-xs text-slate-500 hover:bg-slate-100">
          <input
            ref={inputRef}
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={onFile}
            className="hidden"
          />
          <span className="truncate">
            {file ? (
              <>📎 <span className="font-mono text-slate-700">{file.name}</span> ({(file.size / 1024).toFixed(1)} KB)</>
            ) : (
              <>Click to pick an .xlsx</>
            )}
          </span>
        </label>
        <button
          className="btn-ghost text-xs"
          disabled={!file || busy !== null}
          onClick={preview}
        >
          {busy === "preview" ? "Previewing…" : "👁 Preview"}
        </button>
        <button
          className="btn-primary text-xs"
          disabled={!file || busy !== null}
          onClick={download}
        >
          {busy === "download" ? "Generating…" : "⬇ Generate & download ZIP"}
        </button>
        {file ? (
          <button className="btn-ghost text-xs" disabled={busy !== null} onClick={reset}>Reset</button>
        ) : null}
      </div>

      {error ? <p className="mt-3 text-xs text-rose-700">{error}</p> : null}

      {summary ? (
        <div className="mt-4 grid gap-2 text-xs sm:grid-cols-5">
          <Stat label="Rows" value={summary.totalRows} />
          <Stat label="Generated" value={summary.generated} tone="green" />
          <Stat label="With template" value={summary.templated} tone="sky" />
          <Stat label="Fresh fallback" value={summary.freshFallback} tone="amber" />
          <Stat label="Errors" value={summary.errors} tone={summary.errors > 0 ? "rose" : "slate"} />
        </div>
      ) : null}

      {results.length > 0 ? (
        <div className="mt-3 max-h-[260px] overflow-y-auto rounded-md border border-slate-200">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-slate-50">
              <tr>
                <th className="th">Order No.</th>
                <th className="th">Country</th>
                <th className="th">Template</th>
                <th className="th">Mode</th>
                <th className="th">Note</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r, i) => (
                <tr key={`${r.orderNo}-${i}`} className="border-t border-slate-100">
                  <td className="td font-mono">{r.orderNo}</td>
                  <td className="td">{r.countryCode ?? "—"}</td>
                  <td className="td text-slate-500">{r.templateUsed ?? "—"}</td>
                  <td className="td">
                    <span
                      className={`badge ${
                        r.mode === "template"
                          ? "bg-sky-100 text-sky-800"
                          : r.mode === "fresh"
                          ? "bg-amber-100 text-amber-800"
                          : "bg-rose-100 text-rose-800"
                      }`}
                    >
                      {r.mode}
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

function Stat({ label, value, tone = "slate" }: { label: string; value: number; tone?: "slate" | "green" | "sky" | "amber" | "rose" }) {
  const toneCls =
    tone === "green" ? "text-green-700" :
    tone === "sky" ? "text-sky-700" :
    tone === "amber" ? "text-amber-700" :
    tone === "rose" ? "text-rose-700" :
    "text-slate-700";
  return (
    <div className="rounded-md border border-slate-100 bg-slate-50 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`mt-0.5 text-lg font-semibold ${toneCls}`}>{value}</div>
    </div>
  );
}
