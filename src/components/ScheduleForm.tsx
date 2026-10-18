"use client";

import Link from "next/link";
import { useFormState, useFormStatus } from "react-dom";
import { scheduleAction, type ScheduleActionState } from "@/app/actions/shipment-schedule";

// Sanitized synthetic sample (format-valid, fictional order numbers/styles).
const SAMPLE = `Buyer Code,Cont.No.,Date,OrderNo.,PCS,STYLE,FOB,COMPOSITION,CAT,HTS,Markets
AGL 365 C,AGL/H&M/99/2026,09.06.2026,700201-8404,2000,Sample Ripstop Trousers,12.64,Women 100% Cotton Woven Trousers,FCA,Sea,OW-NLW195|OW-PLW532
AGL 365 F,AGL/H&M/99/2026,09.06.2026,700202-8313,850,Sample Bootcut,10.38,Women 100% Cotton Woven Trousers,FCA,Sea,OW-NLW195|OW-PLW532|KB`;

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button className="btn-primary" disabled={pending}>
      {pending ? "Building…" : "Build schedule"}
    </button>
  );
}

export function ScheduleForm() {
  const [state, action] = useFormState<ScheduleActionState, FormData>(scheduleAction, {});
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <form action={action} className="card space-y-4 p-5">
        <div>
          <label className="label">Week title</label>
          <input
            name="weekTitle"
            className="input"
            defaultValue="Week 43 1st cut off 19.10.2026 2nd 23.10.2026"
          />
        </div>
        <div>
          <label className="label">First invoice number</label>
          <input name="invoiceStart" className="input" defaultValue="65596" />
        </div>
        <div>
          <label className="label">Orders CSV (Markets are | separated)</label>
          <textarea name="csv" className="input h-56 font-mono text-[11px]" defaultValue={SAMPLE} />
          <p className="mt-1 text-xs text-slate-400">
            Each order expands to one line per market; value = PCS × FOB; invoice numbers
            run sequentially (Q-SS-01 rule configurable).
          </p>
        </div>
        <Submit />
      </form>

      <div className="card p-5">
        <h3 className="mb-3 text-sm font-semibold text-slate-700">Schedule result</h3>
        {state.error ? <p className="text-sm text-rose-600">{state.error}</p> : null}
        {!state.result && !state.error ? (
          <p className="text-sm text-slate-400">
            Build a weekly schedule from confirmed orders. Hard validation failures route
            to the review queue and get no invoice number.
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
              <span className="badge bg-sky-100 text-sky-700">Week {state.result.weekNo}</span>
              {state.result.duplicate ? <span className="badge bg-slate-200">duplicate</span> : null}
            </div>
            <ul className="ml-4 list-disc text-sm text-slate-600">
              <li>Orders: {state.result.summary.orders}</li>
              <li>Schedule lines: {state.result.summary.lines}</li>
              <li>Total PCS: {state.result.summary.totalPcs.toLocaleString()}</li>
              <li>Total value: {state.result.summary.totalValue.toLocaleString()}</li>
              <li>Invoices: {state.result.summary.invoiceFrom ?? "—"} … {state.result.summary.invoiceTo ?? "—"}</li>
              <li>Review tickets: {state.result.reviewTicketCount}</li>
            </ul>
            <Link href={`/jobs/${state.result.jobId}`} className="btn-ghost mt-2 text-xs">View full schedule</Link>
          </div>
        ) : null}
      </div>
    </div>
  );
}
