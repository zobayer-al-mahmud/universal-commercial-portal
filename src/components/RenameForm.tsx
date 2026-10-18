"use client";

import Link from "next/link";
import { useFormState, useFormStatus } from "react-dom";
import { renameAction, type RenameActionState } from "@/app/actions/pdf-rename";

// Sanitized synthetic sample (real header names, fictional values).
const SAMPLE_FCR = `"Serial Number","File Name","FCR Number","Order Number","Invoice Number","Success","Message"
"1","1 (1).pdf","CTG0000001","700001-6555","64931DE","true","ok"
"2","1 (2).pdf","CTG0000002","700002-1710","64883OE","true","ok"
"3","1 (3).pdf","CTG0000003","700003-5672","","false","extract failed"`;

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button className="btn-primary" disabled={pending}>
      {pending ? "Planning…" : "Build rename plan"}
    </button>
  );
}

export function RenameForm() {
  const [state, action] = useFormState<RenameActionState, FormData>(renameAction, {});
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <form action={action} className="card space-y-4 p-5">
        <div>
          <label className="label">Document type</label>
          <select name="docType" className="input" defaultValue="auto">
            <option value="auto">Auto-detect from headers</option>
            <option value="fcr">FCR (Forwarder&apos;s Cargo Receipt)</option>
            <option value="bill-of-export">Bill of Export (Shipping Bill)</option>
          </select>
        </div>
        <div>
          <label className="label">Extraction CSV</label>
          <textarea name="csv" className="input h-64 font-mono text-[11px]" defaultValue={SAMPLE_FCR} />
          <p className="mt-1 text-xs text-slate-400">
            Paste the FCR / Bill-of-Export extraction CSV. The plan is a preview — no files on disk are renamed.
          </p>
        </div>
        <Submit />
      </form>

      <div className="card p-5">
        <h3 className="mb-3 text-sm font-semibold text-slate-700">Plan result</h3>
        {state.error ? <p className="text-sm text-rose-600">{state.error}</p> : null}
        {!state.result && !state.error ? (
          <p className="text-sm text-slate-400">
            Submit a CSV to produce a deterministic rename plan (opaque scan name → numeric invoice
            key). Collisions and missing keys route to the review queue.
          </p>
        ) : null}
        {state.result ? (
          <div className="space-y-2 text-sm">
            <div className="flex items-center gap-2">
              <span className="font-medium">Job:</span>
              <Link href={`/jobs/${state.result.jobId}`} className="font-mono text-ananta hover:underline">
                {state.result.jobId.slice(0, 10)}
              </Link>
              <span className="badge bg-slate-100 text-slate-700">{state.result.status}</span>
              <span className="badge bg-sky-100 text-sky-700">{state.result.docType}</span>
              {state.result.duplicate ? <span className="badge bg-slate-200">duplicate</span> : null}
            </div>
            <ul className="ml-4 list-disc text-sm text-slate-600">
              <li>Total rows: {state.result.summary.total}</li>
              <li>Planned renames: <strong className="text-green-700">{state.result.summary.planned}</strong></li>
              <li>Collisions: <strong className="text-rose-700">{state.result.summary.collision}</strong></li>
              <li>Skipped (extraction failed): {state.result.summary.skipped}</li>
              <li>Needs review (no key): {state.result.summary.needsReview}</li>
            </ul>
            <Link href={`/jobs/${state.result.jobId}`} className="btn-ghost mt-2 text-xs">View full plan</Link>
          </div>
        ) : null}
      </div>
    </div>
  );
}
