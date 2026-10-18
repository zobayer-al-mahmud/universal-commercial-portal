"use client";

import Link from "next/link";
import { useFormState, useFormStatus } from "react-dom";
import { scheduleFromContractsAction, type ScheduleFromContractsState } from "@/app/actions/handoffs";
import type { SchedulableContract } from "@/server/handoffs/service";

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button className="btn-primary" disabled={pending}>
      {pending ? "Building…" : "Build schedule from selected"}
    </button>
  );
}

export function ScheduleFromContracts({ contracts }: { contracts: SchedulableContract[] }) {
  const [state, action] = useFormState<ScheduleFromContractsState, FormData>(scheduleFromContractsAction, {});

  if (contracts.length === 0) {
    return (
      <div className="card p-4 text-sm text-slate-400">
        No confirmed, unscheduled contracts. Confirm a Sales Contract draft (on its job page) to feed it here.
      </div>
    );
  }

  return (
    <form action={action} className="card space-y-4 p-5">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label">Week title</label>
          <input name="weekTitle" className="input" defaultValue="Week 43 1st cut off 19.10.2026 2nd 23.10.2026" />
        </div>
        <div>
          <label className="label">First invoice number</label>
          <input name="invoiceStart" className="input" defaultValue="66000" />
        </div>
      </div>
      <div className="max-h-60 overflow-y-auto rounded border border-slate-200">
        <table className="w-full">
          <thead className="bg-slate-50">
            <tr><th className="th"></th><th className="th">Order</th><th className="th">Style</th><th className="th">Qty</th><th className="th">FOB</th><th className="th">Contract</th><th className="th">Markets</th></tr>
          </thead>
          <tbody>
            {contracts.map((c) => (
              <tr key={c.id} className="border-t border-slate-50">
                <td className="td"><input type="checkbox" name="rowIds" value={c.id} defaultChecked /></td>
                <td className="td font-mono text-xs">{c.orderNo}</td>
                <td className="td text-xs">{c.styleNo}</td>
                <td className="td">{c.orderQty}</td>
                <td className="td">{c.unitPrice}</td>
                <td className="td font-mono text-xs">{c.blockContractRef}</td>
                <td className="td text-xs">{c.markets.join(", ") || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {state.error ? <p className="text-sm text-rose-600">{state.error}</p> : null}
      {state.result ? (
        <p className="text-sm text-green-700">
          Built Week {state.result.weekNo} schedule ({state.result.lines} lines,{" "}
          <span className="badge bg-slate-100">{state.result.status}</span>) —{" "}
          <Link href={`/jobs/${state.result.jobId}`} className="text-ananta underline">view job</Link>. Invoice lines are now available in Customs Invoice.
        </p>
      ) : null}
      <Submit />
    </form>
  );
}
