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
        <p className="text-xs text-slate-500">
          Weeks are usually created automatically when a Sales Contract PO is extracted. Use this form to add an empty week manually.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-[160px_auto]">
        <input
          name="weekNo"
          type="number"
          min={1}
          max={60}
          required
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
