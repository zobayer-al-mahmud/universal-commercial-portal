"use client";

import { useFormState, useFormStatus } from "react-dom";
import {
  allocateInvoiceNumbersAction,
  type AllocateInvoiceState,
} from "@/app/actions/shipment-schedule";

const INITIAL: AllocateInvoiceState = {};

/**
 * Per-week invoice-number allocator (user rule 2026-10-28).
 *
 * The user types one starting number (e.g. 2000) and presses "Allocate". The
 * server walks every cut-off of this week in sortOrder, then every row in
 * createdAt order, and assigns sequential numbers — so a week with 6 rows on
 * 1st cut-off and 4 on 2nd produces 2000..2005 on the 1st, 2006..2009 on the
 * 2nd.
 */
export function ShipmentScheduleInvoiceAllocator({
  scheduleId,
  rowCount,
}: {
  scheduleId: string;
  rowCount: number;
}) {
  const [state, action] = useFormState(allocateInvoiceNumbersAction, INITIAL);
  return (
    <form action={action} className="card p-5">
      <div className="mb-2">
        <h3 className="text-sm font-semibold text-slate-800">② Allocate invoice numbers for this week</h3>
        <p className="text-xs text-slate-500">
          Enter the first invoice number (e.g. <span className="font-mono">2000</span>). The system numbers the 1st cut-off&apos;s rows first, then the 2nd — so if the 1st cut-off has 6 rows, those get 2000–2005 and the 2nd cut-off starts at 2006. Existing invoice numbers are overwritten; previous values stay in the row&apos;s edit history. These numbers drive invoice creation downstream.
        </p>
      </div>
      <input type="hidden" name="scheduleId" value={scheduleId} />
      <div className="flex items-center gap-2">
        <input
          name="startNumber"
          type="text"
          inputMode="numeric"
          pattern="\d*"
          placeholder="e.g. 2000"
          required
          className="input w-40 font-mono text-xs"
        />
        <SubmitBtn disabled={rowCount === 0} />
        <span className="text-xs text-slate-500">{rowCount} row(s) will be numbered.</span>
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
      {pending ? "Allocating…" : "⬆ Allocate"}
    </button>
  );
}
