"use client";

import { useFormState, useFormStatus } from "react-dom";
import { createScheduleAction, type CreateScheduleState } from "@/app/actions/shipment-schedule";

const INITIAL: CreateScheduleState = {};

export function CreateShipmentScheduleForm() {
  const [state, action] = useFormState(createScheduleAction, INITIAL);
  return (
    <form action={action} className="card p-5">
      <div className="mb-3">
        <h3 className="text-sm font-semibold text-slate-800">+ Create new Shipment Schedule</h3>
        <p className="mt-1 text-xs text-slate-500">
          Title convention: <span className="font-mono">Week NN 1st cut off DD.MM.YYYY 2nd DD.MM.YYYY</span>. You can edit it later.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-[1fr_120px_auto]">
        <input
          name="weekTitle"
          required
          placeholder="e.g. Week 43 1st cut off 19.10.2026 2nd 23.10.2026"
          className="input w-full"
        />
        <input
          name="weekNo"
          type="number"
          min={1}
          max={60}
          placeholder="Week No."
          className="input w-full"
        />
        <SubmitBtn />
      </div>
      {state.error ? <p className="mt-2 text-sm text-rose-700">{state.error}</p> : null}
    </form>
  );
}

function SubmitBtn() {
  const { pending } = useFormStatus();
  return (
    <button className="btn-primary text-xs" disabled={pending}>
      {pending ? "Creating…" : "Create"}
    </button>
  );
}
