"use client";

/**
 * Bulk import of PO rows into the open Sales Contract from an .xlsx that
 * matches the exported layout. Lives at the bottom of the view/edit page.
 * Duplicate PO rows (same Order No. already in this contract) are skipped —
 * never duplicated.
 */
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

interface Result {
  totalRows: number;
  created: number;
  skippedDuplicates: { orderNo: string }[];
  skippedBlank: number;
  rejectedRows: { row: number; reason: string }[];
}

export function SalesContractImport({ contractId }: { contractId: string }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<Result | null>(null);

  const submit = async () => {
    if (!file) { setError("Pick an .xlsx file first."); return; }
    setPending(true);
    setError("");
    setResult(null);
    try {
      const form = new FormData();
      form.set("file", file);
      const res = await fetch(`/api/sales-contract/import/${contractId}`, { method: "POST", body: form });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Import failed.");
      setResult(body.result as Result);
      setFile(null);
      if (inputRef.current) inputRef.current.value = "";
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Import failed.");
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="card p-5">
      <h3 className="mb-1 text-sm font-semibold text-slate-800">Bulk import PO rows from Excel</h3>
      <p className="mb-3 text-xs text-slate-400">
        Upload an .xlsx with the same column layout as the export (Order No. · Style No. · Description · Order Qty · Total Qty
        With Packs · Unit Price · Value · Time of Delivery). The importer finds the header row automatically. Each row becomes
        one PO under <span className="font-mono">this</span> Sales Contract. A row whose Order No. is already in this contract
        is skipped — never duplicated.
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <input
          ref={inputRef}
          type="file"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          onChange={(e) => { setFile(e.target.files?.[0] ?? null); setError(""); setResult(null); }}
          className="text-xs"
        />
        <button className="btn-primary text-xs" disabled={pending || !file} onClick={submit}>
          {pending ? "Importing…" : "⤒ Import rows"}
        </button>
      </div>

      {error ? <div className="mt-3 text-xs text-rose-600">{error}</div> : null}

      {result ? (
        <div className="mt-4 rounded-md border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="badge bg-green-100 text-green-800">{result.created} created</span>
            {result.skippedDuplicates.length ? <span className="badge bg-slate-100 text-slate-600">{result.skippedDuplicates.length} duplicate(s) skipped</span> : null}
            {result.skippedBlank ? <span className="badge bg-slate-100 text-slate-500">{result.skippedBlank} blank row(s) skipped</span> : null}
            {result.rejectedRows.length ? <span className="badge bg-rose-100 text-rose-700">{result.rejectedRows.length} rejected</span> : null}
            <span className="text-slate-400">· {result.totalRows} data row(s) in sheet</span>
          </div>
          {result.skippedDuplicates.length ? (
            <div className="mb-2">
              <div className="font-medium">Duplicates skipped (already in this contract):</div>
              <div className="ml-3 font-mono text-[11px] text-slate-500">
                {result.skippedDuplicates.map((d) => d.orderNo).join(", ")}
              </div>
            </div>
          ) : null}
          {result.rejectedRows.length ? (
            <ul className="ml-4 list-disc text-rose-700">
              {result.rejectedRows.map((r, i) => <li key={i}>{r.reason}</li>)}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
