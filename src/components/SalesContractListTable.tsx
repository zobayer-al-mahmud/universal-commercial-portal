"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { BulkDownloadBar } from "@/components/BulkDownloadBar";
import { setCurrentContractAction } from "@/app/actions/sales-contract-config";

/** Row shape pre-flattened by the server page — keeps this component free of
 *  any Prisma types. */
export interface SalesContractListRow {
  id: string;
  label: string;
  isCurrent: boolean;
  posCount: number;
  ready: number;
  blocked: number;
  failed: number;
  status: string;
  createdAt: string; // "YYYY-MM-DD HH:MM"
}

export function SalesContractListTable({ rows }: { rows: SalesContractListRow[] }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Only contracts with uploaded POs can be exported; empty contracts would
  // produce an empty workbook.
  const selectableIds = useMemo(
    () => rows.filter((r) => r.posCount > 0).map((r) => r.id),
    [rows],
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
    <>
      <div className="mb-3">
        <BulkDownloadBar
          endpoint="/api/sales-contract/bulk-download"
          bodyKey="ids"
          ids={selectedIds}
          totalCount={selectableIds.length}
          allSelected={allSelected}
          onSelectAll={toggleAll}
          onClear={() => setSelected(new Set())}
          fileNameBase="SalesContracts"
        />
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-slate-50">
            <tr>
              <th className="th w-8">
                <input
                  type="checkbox"
                  aria-label="Select all contracts"
                  checked={allSelected}
                  onChange={toggleAll}
                  disabled={selectableIds.length === 0}
                />
              </th>
              <th className="th">Current</th>
              <th className="th">Contract</th>
              <th className="th">POs</th>
              <th className="th">Ready / Blocked / Failed</th>
              <th className="th">Status</th>
              <th className="th">Created</th>
              <th className="th"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id} className="border-t border-slate-50">
                <td className="td">
                  {c.posCount > 0 ? (
                    <input
                      type="checkbox"
                      aria-label={`Select ${c.label}`}
                      checked={selected.has(c.id)}
                      onChange={() => toggle(c.id)}
                    />
                  ) : (
                    <span className="text-[10px] text-slate-300" title="Empty contract — upload POs first">—</span>
                  )}
                </td>
                <td className="td">
                  {c.isCurrent ? (
                    <span className="badge bg-emerald-100 text-emerald-700">current</span>
                  ) : (
                    <form action={setCurrentContractAction}>
                      <input type="hidden" name="contractId" value={c.id} />
                      <button className="btn-ghost text-xs">Set current</button>
                    </form>
                  )}
                </td>
                <td className="td font-mono">
                  <Link href={`/sales-contract/${c.id}`} className="text-ananta hover:underline">
                    {c.label}
                  </Link>
                </td>
                <td className="td">{c.posCount}</td>
                <td className="td">
                  <span className="text-green-700">{c.ready}</span> /{" "}
                  <span className="text-amber-700">{c.blocked}</span> /{" "}
                  <span className="text-rose-700">{c.failed}</span>
                </td>
                <td className="td">
                  <span className="badge bg-slate-100 text-slate-600">{c.status}</span>
                </td>
                <td className="td text-slate-400">{c.createdAt}</td>
                <td className="td">
                  <Link href={`/sales-contract/${c.id}`} className="text-ananta hover:underline">Open →</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
