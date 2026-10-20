"use client";

import { useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import { editScheduleLineAction, type ScheduleEditState } from "@/app/actions/shipment-schedule-edit";

const EDITABLE: { field: string; label: string }[] = [
  { field: "pcs", label: "PCS" },
  { field: "fob", label: "FOB" },
  { field: "style", label: "Style" },
  { field: "composition", label: "Composition" },
  { field: "incoterm", label: "Incoterm" },
  { field: "transport", label: "Transport" },
  { field: "marketCode", label: "Market code" },
  { field: "invoiceNo", label: "Invoice no" },
  { field: "cutOff", label: "Cut-off (1st/2nd)" },
  { field: "firstCutOff", label: "1st cut-off date (DD.MM.YYYY)" },
  { field: "secondCutOff", label: "2nd cut-off date (DD.MM.YYYY)" },
];

function SaveBtn() {
  const { pending } = useFormStatus();
  return <button className="btn-primary text-xs" disabled={pending}>{pending ? "Saving…" : "Save edit"}</button>;
}

export function ScheduleLineEditor({ lineId, current }: { lineId: string; current: Record<string, string> }) {
  const [state, action] = useFormState<ScheduleEditState, FormData>(editScheduleLineAction, {});
  const [field, setField] = useState("pcs");
  const [open, setOpen] = useState(false);

  if (!open) {
    return <button className="text-ananta hover:underline" onClick={() => setOpen(true)}>✎ Edit</button>;
  }

  return (
    <form action={action} className="space-y-2 rounded-md border border-sky-200 bg-sky-50 p-2">
      <input type="hidden" name="lineId" value={lineId} />
      <div className="flex flex-wrap items-center gap-2">
        <select name="field" className="input !w-auto !py-1 text-xs" value={field} onChange={(e) => setField(e.target.value)}>
          {EDITABLE.map((f) => <option key={f.field} value={f.field}>{f.label}</option>)}
        </select>
        <input name="value" className="input !w-28 !py-1 text-xs" defaultValue={current[field] ?? ""} placeholder="new value" />
        <input name="reason" className="input !w-44 !py-1 text-xs" placeholder="change reason (required)" />
        <SaveBtn />
        <button type="button" className="text-xs text-slate-500 hover:underline" onClick={() => setOpen(false)}>close</button>
      </div>
      {state.error ? <p className="text-xs text-rose-600">{state.error}</p> : null}
      {state.ok ? <p className="text-xs text-green-700">Saved.</p> : null}
    </form>
  );
}
