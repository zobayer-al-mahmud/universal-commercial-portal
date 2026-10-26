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
          Just enter a <strong>week number</strong> (e.g. 32) to start — the title and cut-off dates can be added or edited later.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-[120px_1fr_auto]">
        <input
          name="weekNo"
          type="number"
          min={1}
          max={60}
          placeholder="Week No. *"
          className="input w-full"
        />
        <input
          name="weekTitle"
          placeholder="Optional title (e.g. Week 32 1st cut off 05.08.2026) — editable later"
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
