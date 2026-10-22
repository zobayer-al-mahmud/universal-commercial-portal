"use client";

import { useState } from "react";
import { addCutoffAction, updateCutoffAction, deleteCutoffAction } from "@/app/actions/shipment-schedule";

export interface CutoffRow {
  id: string;
  label: string;
  date: string;
  sortOrder: number;
}

export function ShipmentScheduleCutoffs({ scheduleId, cutoffs, rowCounts }: { scheduleId: string; cutoffs: CutoffRow[]; rowCounts?: Record<string, number> }) {
  const [adding, setAdding] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);

  return (
    <div className="card p-5">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-800">Cut-offs</h3>
        {!adding ? (
          <button className="text-xs text-sky-700 hover:underline" onClick={() => setAdding(true)}>+ Add cut-off</button>
        ) : null}
      </div>

      {adding ? (
        <form
          action={addCutoffAction}
          onSubmit={() => setAdding(false)}
          className="mb-3 grid gap-2 rounded-md border border-sky-200 bg-sky-50 p-3 sm:grid-cols-[1fr_140px_auto_auto]"
        >
          <input type="hidden" name="scheduleId" value={scheduleId} />
          <input name="label" required placeholder="Label (e.g. 3rd cut off)" className="input w-full" />
          <input name="date" placeholder="DD.MM.YYYY" className="input w-full" />
          <button className="btn-primary text-xs">Add</button>
          <button type="button" className="btn-ghost text-xs" onClick={() => setAdding(false)}>Cancel</button>
        </form>
      ) : null}

      <table className="w-full text-xs">
        <thead className="bg-slate-50">
          <tr>
            <th className="th">Label</th>
            <th className="th">Date</th>
            <th className="th">Rows</th>
            <th className="th">Action</th>
          </tr>
        </thead>
        <tbody>
          {cutoffs.length === 0 ? (
            <tr>
              <td colSpan={4} className="td text-slate-400">
                No cut-offs. Add one above.
              </td>
            </tr>
          ) : (
            cutoffs.map((c) => {
              const n = rowCounts?.[c.id] ?? 0;
              return (
                <tr key={c.id} className="border-t border-slate-100">
                  {editId === c.id ? (
                    <>
                      <td className="td" colSpan={3}>
                        <form
                          action={updateCutoffAction}
                          onSubmit={() => setEditId(null)}
                          className="grid gap-2 sm:grid-cols-[1fr_140px_auto_auto]"
                        >
                          <input type="hidden" name="id" value={c.id} />
                          <input type="hidden" name="scheduleId" value={scheduleId} />
                          <input name="label" defaultValue={c.label} required className="input w-full" />
                          <input name="date" defaultValue={c.date} placeholder="DD.MM.YYYY" className="input w-full" />
                          <button className="btn-primary text-xs">Save</button>
                          <button type="button" className="btn-ghost text-xs" onClick={() => setEditId(null)}>Cancel</button>
                        </form>
                      </td>
                      <td className="td" />
                    </>
                  ) : (
                    <>
                      <td className="td font-medium">{c.label}</td>
                      <td className="td font-mono text-slate-500">{c.date || "—"}</td>
                      <td className="td">{n}</td>
                      <td className="td">
                        <div className="flex items-center gap-3">
                          <button className="text-xs text-sky-700 hover:underline" onClick={() => setEditId(c.id)}>✎ Edit</button>
                          {n > 0 ? (
                            <a
                              href={`/api/shipment-schedule/${scheduleId}/cutoff/${c.id}/download`}
                              className="text-xs text-green-700 hover:underline"
                            >
                              ⬇ Download .xlsx
                            </a>
                          ) : (
                            <span className="text-xs text-slate-400">No rows yet</span>
                          )}
                          <form action={deleteCutoffAction}>
                            <input type="hidden" name="id" value={c.id} />
                            <input type="hidden" name="scheduleId" value={scheduleId} />
                            <button
                              className="text-xs text-rose-600 hover:underline"
                              onClick={(e) => {
                                if (!confirm(`Delete "${c.label}"? Its uploaded rows will be removed.`)) e.preventDefault();
                              }}
                            >
                              🗑 Delete
                            </button>
                          </form>
                        </div>
                      </td>
                    </>
                  )}
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
