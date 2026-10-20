"use client";

/**
 * UI for the Sales Contract Creation module's "pick a contract → upload up to 3
 * PDFs" flow. Three named dropzones per kind + an existing-contract dropdown
 * with an inline "create new" option. On submit, shows a per-PO verification
 * panel (orderNo, action, state, extracted rows, link to the master workbook).
 */

import { useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import { pickAndUploadSalesContractAction, type PickUploadState } from "@/app/actions/sales-contract-pick";

export interface ExistingContractOption {
  id: string;
  marchentContNo: string;
  buyerCode: string;
  poCount: number;
}

type Kind = "PurchaseOrder" | "SizePerColourBreakdown" | "TotalCountryBreakdown";
const KIND_LABEL: Record<Kind, string> = {
  PurchaseOrder: "Purchase Order",
  SizePerColourBreakdown: "Size / Colour Breakdown",
  TotalCountryBreakdown: "Total Country Breakdown",
};
const KIND_HINT: Record<Kind, string> = {
  PurchaseOrder: "…PurchaseOrder_Supplier_*.pdf",
  SizePerColourBreakdown: "…SizePerColourBreakdown_Supplier_*.pdf",
  TotalCountryBreakdown: "…TotalCountryBreakdown_Supplier_*.pdf",
};

const ACTION_TONE: Record<string, string> = {
  created: "bg-green-100 text-green-800",
  merged: "bg-sky-100 text-sky-800",
  conflict: "bg-amber-100 text-amber-800",
  failed: "bg-rose-100 text-rose-800",
};

const STATE_TONE: Record<string, string> = {
  READY: "bg-green-100 text-green-800",
  NEEDS_REVIEW: "bg-amber-100 text-amber-800",
  BLOCKED: "bg-amber-100 text-amber-800",
  FAILED: "bg-rose-100 text-rose-800",
};

function Submit({ count, pickValid }: { count: number; pickValid: boolean }) {
  const { pending } = useFormStatus();
  const disabled = pending || count === 0 || !pickValid;
  const label = pending
    ? "Processing PDFs…"
    : !pickValid
      ? "Select a Sales Contract first"
      : count === 0
        ? "Select at least one PDF"
        : `▶ Process ${count} PDF${count > 1 ? "s" : ""} → selected contract`;
  return <button className="btn-primary" disabled={disabled}>{label}</button>;
}

export function SalesContractPickBatch({ contracts }: { contracts: ExistingContractOption[] }) {
  const [state, action] = useFormState<PickUploadState, FormData>(pickAndUploadSalesContractAction, {});
  const [mode, setMode] = useState<"pick" | "new">(contracts.length > 0 ? "pick" : "new");
  const [contractId, setContractId] = useState<string>(contracts[0]?.id ?? "");
  const [marchentContNo, setMarchentContNo] = useState<string>("");
  const [picked, setPicked] = useState<Partial<Record<Kind, File>>>({});

  const setKind = (kind: Kind, f: File | null) => {
    setPicked((p) => ({ ...p, [kind]: f ?? undefined }));
  };

  const count = (Object.keys(picked) as Kind[]).filter((k) => picked[k]).length;
  const pickValid = mode === "pick" ? !!contractId : marchentContNo.trim().length > 0;

  return (
    <div className="space-y-4">
      <form action={action} className="card space-y-4 p-5">
        {/* --- Contract selector ---------------------------------------- */}
        <div className="space-y-2">
          <div className="flex items-center gap-4 text-xs">
            <label className="flex items-center gap-1">
              <input type="radio" name="mode" value="pick" checked={mode === "pick"} onChange={() => setMode("pick")} disabled={contracts.length === 0} />
              <span>Pick existing contract</span>
            </label>
            <label className="flex items-center gap-1">
              <input type="radio" name="mode" value="new" checked={mode === "new"} onChange={() => setMode("new")} />
              <span>➕ Create new contract</span>
            </label>
          </div>

          {mode === "pick" ? (
            <>
              <label className="label">Target Sales Contract</label>
              <select
                name="contractId"
                className="input"
                value={contractId}
                onChange={(e) => setContractId(e.target.value)}
                disabled={contracts.length === 0}
              >
                {contracts.length === 0 ? (
                  <option value="">No contracts yet — switch to "Create new"</option>
                ) : (
                  contracts.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.marchentContNo || c.id.slice(0, 10)}
                      {c.buyerCode ? ` · ${c.buyerCode}` : ""}
                      {c.poCount ? ` · ${c.poCount} PO${c.poCount > 1 ? "s" : ""}` : ""}
                    </option>
                  ))
                )}
              </select>
              <p className="text-xs text-slate-400">Uploaded PDFs will append to this contract's master workbook, one row per unique PO.</p>
            </>
          ) : (
            <>
              <label className="label">Merchant Contract No. (new contract)</label>
              <input
                name="marchentContNo"
                className="input"
                placeholder="AGL/H&M/97/2026"
                value={marchentContNo}
                onChange={(e) => setMarchentContNo(e.target.value)}
              />
              <p className="text-xs text-slate-400">
                A fresh Sales Contract is created with this reference as column A. Buyer Code and the other BR-HM-01..05 blocked
                fields stay blank — fill them from the detail page after creation.
              </p>
            </>
          )}
        </div>

        {/* --- 3 PDF dropzones ------------------------------------------- */}
        <div>
          <div className="mb-1 text-xs font-semibold text-slate-700">Upload up to 3 PDFs (one per kind)</div>
          <div className="grid gap-3 sm:grid-cols-3">
            {(Object.keys(KIND_LABEL) as Kind[]).map((k) => (
              <div key={k} className="rounded-md border border-slate-200 p-3">
                <div className="mb-1 text-xs font-semibold text-slate-700">{KIND_LABEL[k]}</div>
                <div className="mb-2 text-[11px] text-slate-400">{KIND_HINT[k]}</div>
                {picked[k] ? (
                  <div className="flex items-center justify-between text-xs">
                    <span className="truncate text-slate-700">{picked[k]!.name}</span>
                    <button type="button" className="ml-2 shrink-0 text-slate-400 hover:text-rose-600" onClick={() => setKind(k, null)}>✕</button>
                  </div>
                ) : (
                  <label className="block cursor-pointer rounded border border-dashed border-slate-300 bg-slate-50 px-2 py-3 text-center text-xs text-slate-500 hover:bg-slate-100">
                    Click to select
                    <input type="file" name={k} accept="application/pdf,.pdf" className="hidden" onChange={(e) => setKind(k, e.target.files?.[0] ?? null)} />
                  </label>
                )}
              </div>
            ))}
          </div>
          <p className="mt-2 text-xs text-slate-400">
            PDFs with the same Order No. are merged into one PO row. PDFs with different Order Nos. become separate rows. A
            re-upload that would change an already-extracted value is flagged for review — the previous values are preserved
            until you resolve the conflict.
          </p>
        </div>

        <Submit count={count} pickValid={pickValid} />
      </form>

      {state.error ? <div className="card p-4 text-sm text-rose-600">{state.error}</div> : null}

      {state.ok && state.result ? (
        <div className="card p-5">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-slate-700">Batch processed</span>
            <span className="badge bg-green-100 text-green-800">{state.result.accepted} accepted</span>
            {state.result.rejected.length ? <span className="badge bg-rose-100 text-rose-700">{state.result.rejected.length} rejected</span> : null}
            <span className="text-xs text-slate-400">· contract {state.result.contractId.slice(0, 10)}</span>
            <a href={`/api/hm-sales-contract/${state.result.contractId}/download`} className="btn-primary ml-auto text-xs">
              ⬇ Download master .xlsx
            </a>
          </div>

          {state.result.rejected.length ? (
            <ul className="mb-3 ml-4 list-disc text-xs text-rose-600">
              {state.result.rejected.map((r, i) => <li key={i}>{r.name}: {r.reason}</li>)}
            </ul>
          ) : null}

          <table className="w-full text-xs">
            <thead className="bg-slate-50">
              <tr>
                <th className="th">PO (Order No)</th>
                <th className="th">Action</th>
                <th className="th">State</th>
                <th className="th">Kinds in this batch</th>
                <th className="th">Rows in master row</th>
                <th className="th">Notes</th>
              </tr>
            </thead>
            <tbody>
              {state.result.perPo.map((p, i) => (
                <tr key={i} className="border-t border-slate-50 align-top">
                  <td className="td font-mono">{p.orderNo || "—"}</td>
                  <td className="td"><span className={`badge ${ACTION_TONE[p.action] ?? ""}`}>{p.action}</span></td>
                  <td className="td"><span className={`badge ${STATE_TONE[p.state] ?? ""}`}>{p.state}</span></td>
                  <td className="td text-slate-600">{p.kinds.join(", ")}</td>
                  <td className="td">{p.rowCount}</td>
                  <td className="td whitespace-pre-wrap text-slate-600">{p.reasons.join("\n") || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <p className="mt-3 text-xs text-slate-400">
            Verification: open the master workbook to see the unique-PO rows that will export to .xlsx. A <span className="font-medium">conflict</span> row
            means the previous extracted values are kept — resolve the conflict on the detail page before overwriting.
          </p>
        </div>
      ) : null}
    </div>
  );
}
