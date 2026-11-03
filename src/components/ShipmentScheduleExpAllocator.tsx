"use client";

import { useFormState, useFormStatus } from "react-dom";
import {
  allocateExpNumbersAction,
  type AllocateExpState,
} from "@/app/actions/shipment-schedule";

const INITIAL: AllocateExpState = {};

/**
 * Per-week EXP-number allocator (user rule 2026-11-03). Mirrors
 * ShipmentScheduleInvoiceAllocator: user types a starting EXP number and the
 * server walks every cut-off in sortOrder, then every row in createdAt order,
 * filling only the ROWS WHOSE expNo IS BLANK with sequential numbers. Rows
 * that already carry an EXP number are left alone — a manual edit is required
 * to change them. The pool skips any number already used on any schedule so
 * duplicates cannot be produced.
 */
export function ShipmentScheduleExpAllocator({
  scheduleId,
  rowCount,
}: {
  scheduleId: string;
  rowCount: number;
}) {
  const [state, action] = useFormState(allocateExpNumbersAction, INITIAL);
  return (
    <form action={action} className="card p-5">
      <div className="mb-2">
        <h3 className="text-sm font-semibold text-slate-800">③ Allocate EXP numbers for this week</h3>
        <p className="text-xs text-slate-500">
          Enter the first EXP number (e.g. <span className="font-mono">31000</span>). The system fills blank rows cut-off by cut-off; rows that already have an EXP No. are left as-is. Each EXP No. is unique across every week. These numbers flow into the Customs Invoice. The EXP date column is filled manually (no auto-allocation).
        </p>
      </div>
      <input type="hidden" name="scheduleId" value={scheduleId} />
      <div className="flex items-center gap-2">
        <input
          name="startNumber"
          type="text"
          inputMode="numeric"
          pattern="\d*"
          placeholder="e.g. 31000"
          required
          className="input w-40 font-mono text-xs"
        />
        <SubmitBtn disabled={rowCount === 0} />
        <span className="text-xs text-slate-500">{rowCount} row(s) in this week.</span>
      </div>
      {state.error ? <p className="mt-2 text-xs text-rose-700">{state.error}</p> : null}
      {state.ok && state.message ? <p className="mt-2 text-xs text-green-700">{state.message}</p> : null}
    </form>
  );
}

function SubmitBtn({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button className="btn-primary text-xs" disabled={pending || disabled}>
      {pending ? "Allocating…" : "⬆ Allocate EXP"}
    </button>
  );
}
