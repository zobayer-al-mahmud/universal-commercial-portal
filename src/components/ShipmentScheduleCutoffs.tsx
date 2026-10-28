"use client";

import { useState, useMemo } from "react";
import { addCutoffAction, updateCutoffAction, deleteCutoffAction } from "@/app/actions/shipment-schedule";
import { BulkDownloadBar } from "@/components/BulkDownloadBar";

export interface CutoffRow {
  id: string;
  label: string;
  date: string;
  sortOrder: number;
}

export function ShipmentScheduleCutoffs({ scheduleId, cutoffs, rowCounts }: { scheduleId: string; cutoffs: CutoffRow[]; rowCounts?: Record<string, number> }) {
  const [adding, setAdding] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Only expose the whole-week download when at least one cut-off has rows,
  // so the user doesn't download an empty workbook.
  const totalRows = cutoffs.reduce((n, c) => n + (rowCounts?.[c.id] ?? 0), 0);

  // Only cut-offs with at least one row are downloadable (empty ones would
  // produce an empty workbook).
  const selectableIds = useMemo(
    () => cutoffs.filter((c) => (rowCounts?.[c.id] ?? 0) > 0).map((c) => c.id),
    [cutoffs, rowCounts],
  );
  const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selected.has(id));
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  const toggleAll = () =>
    setSelected((prev) => {
      if (allSelected) {
        const next = new Set(prev);
        for (const id of selectableIds) next.delete(id);
        return next;
      }
      const next = new Set(prev);
      for (const id of selectableIds) next.add(id);
      return next;
    });
  const selectedIds = Array.from(selected);

  return (
    <div className="card p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-slate-800">Cut-offs</h3>
        <div className="flex items-center gap-3">
          {totalRows > 0 ? (
            <a
              href={`/api/shipment-schedule/${scheduleId}/download`}
              className="text-xs font-medium text-green-700 hover:underline"
              title="Download the entire week as one .xlsx (all cut-offs in one sheet)"
            >
              ⬇ Download week .xlsx
            </a>
          ) : null}
          {!adding ? (
            <button className="text-xs text-sky-700 hover:underline" onClick={() => setAdding(true)}>+ Add cut-off</button>
          ) : null}
        </div>
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

      {selectableIds.length > 0 ? (
        <div className="mb-3">
          <BulkDownloadBar
            endpoint="/api/shipment-schedule/bulk-download"
            bodyKey="cutoffIds"
            ids={selectedIds}
            totalCount={selectableIds.length}
            allSelected={allSelected}
            onSelectAll={toggleAll}
            onClear={() => setSelected(new Set())}
            fileNameBase="ShipmentCutoffs"
          />
        </div>
      ) : null}

      <table className="w-full text-xs">
        <thead className="bg-slate-50">
          <tr>
            <th className="th w-8">
              <input
                type="checkbox"
                aria-label="Select all cut-offs"
                checked={allSelected}
                onChange={toggleAll}
                disabled={selectableIds.length === 0}
              />
            </th>
            <th className="th">Label</th>
            <th className="th">Date</th>
            <th className="th">Rows</th>
            <th className="th">Action</th>
          </tr>
        </thead>
        <tbody>
          {cutoffs.length === 0 ? (
            <tr>
              <td colSpan={5} className="td text-slate-400">
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
                      <td className="td" />
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
                      <td className="td">
                        {n > 0 ? (
                          <input
                            type="checkbox"
                            aria-label={`Select ${c.label}`}
                            checked={selected.has(c.id)}
                            onChange={() => toggle(c.id)}
                          />
                        ) : (
                          <span className="text-[10px] text-slate-300" title="Cut-off has no rows yet">—</span>
                        )}
                      </td>
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
