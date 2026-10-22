"use client";

import { useState } from "react";
import { updateScheduleTitleAction } from "@/app/actions/shipment-schedule";

export function ShipmentScheduleHeaderEditor({ id, weekTitle, weekNo }: { id: string; weekTitle: string; weekNo: number | null }) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <div className="card flex items-center justify-between p-4">
        <div>
          <p className="text-xs text-slate-400">Week title</p>
          <p className="text-sm font-semibold text-slate-800">{weekTitle || "(untitled)"}</p>
        </div>
        <button className="text-xs text-sky-700 hover:underline" onClick={() => setOpen(true)}>✎ Edit</button>
      </div>
    );
  }
  return (
    <form
      action={updateScheduleTitleAction}
      className="card p-4"
      onSubmit={() => setOpen(false)}
    >
      <input type="hidden" name="id" value={id} />
      <div className="grid gap-3 sm:grid-cols-[1fr_120px_auto_auto]">
        <input name="weekTitle" defaultValue={weekTitle} required className="input w-full" />
        <input name="weekNo" type="number" min={1} max={60} defaultValue={weekNo ?? ""} placeholder="Week No." className="input w-full" />
        <button className="btn-primary text-xs" type="submit">Save</button>
        <button type="button" className="btn-ghost text-xs" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </form>
  );
}
