"use client";

/**
 * Per-PO row editor that matches the exported Excel columns one-to-one.
 * EVERY column is editable (user spec 2026-10-20):
 *   Order No. | Style No. | Description | Order Qty | Total Qty With Packs |
 *   Unit Price | Value | Time of Delivery
 *
 * Total Qty With Packs and Value are calculated by default (orderQty × packSet
 * and orderQty × fob respectively); when the user types a value in either,
 * that override wins on export and the recomputation stops for that cell.
 * Every edit is persisted as an append-only override via `editHmRowAction`;
 * previous values are kept in the DB.
 */
import { useState, useTransition } from "react";
import { editHmRowAction } from "@/app/actions/hm-sales-contract";

export interface SalesContractPoRow {
  poId: string;
  orderNo: string;
  styleNo: string;
  itemDes: string;
  orderQty: number | null;
  fob: number | null;
  tod: string;
  marketCode: string;
  overrides?: Record<string, string | number | null>;
  state: string;
  reasons?: string;
  packSet: string;
}

type DraftKey = "orderNo" | "styleNo" | "itemDes" | "orderQty" | "totalWithPacks" | "fob" | "value" | "tod";
type Draft = Record<DraftKey, string>;

function toDraft(po: SalesContractPoRow): Draft {
  const o = po.overrides ?? {};
  const packSetN = Number(po.packSet);
  const packs = Number.isFinite(packSetN) && packSetN > 0 ? packSetN : 1;
  const orderQty = pickNum(o.orderQty, po.orderQty);
  const fob = pickNum(o.fob, po.fob);
  const totalFromCalc = orderQty !== null ? orderQty * packs : null;
  const valueFromCalc = orderQty !== null && fob !== null ? orderQty * fob : null;
  return {
    orderNo: pickStr(o.orderNo, po.orderNo),
    styleNo: pickStr(o.styleNo, po.styleNo),
    itemDes: pickStr(o.itemDes, po.itemDes),
    orderQty: orderQty === null ? "" : String(orderQty),
    totalWithPacks: pickNum(o.totalWithPacks, totalFromCalc) === null ? "" : String(pickNum(o.totalWithPacks, totalFromCalc)),
    fob: fob === null ? "" : String(fob),
    value: pickNum(o.value, valueFromCalc) === null ? "" : String(pickNum(o.value, valueFromCalc)),
    tod: pickStr(o.tod, po.tod),
  };
}

export function SalesContractPoEditor({ contractId, po }: { contractId: string; po: SalesContractPoRow }) {
  const [pending, start] = useTransition();
  const [saved, setSaved] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => toDraft(po));

  const set = (k: DraftKey, v: string) => setDraft((d) => ({ ...d, [k]: v }));

  const save = () => {
    const form = new FormData();
    form.set("poId", po.poId);
    form.set("contractId", contractId);
    form.set("marketCode", po.marketCode || "ALL");
    for (const [k, v] of Object.entries(draft)) form.set(k, v);
    start(async () => {
      await editHmRowAction(form);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    });
  };

  return (
    <div className="card border border-slate-200 p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm text-slate-700">PO {po.orderNo || "—"}</span>
        <StateBadge state={po.state} />
        {po.reasons ? <span className="text-[11px] text-amber-700">{po.reasons.split("\n")[0]}</span> : null}
        <span className="ml-auto text-[11px] text-slate-400">Every cell editable · click Save to persist</span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 text-left">
            <tr>
              <Th>Order No.</Th>
              <Th>Style No.</Th>
              <Th>Description</Th>
              <Th>Order Qty</Th>
              <Th>Total Qty With Packs</Th>
              <Th>Unit Price</Th>
              <Th>Value</Th>
              <Th>Time of Delivery</Th>
            </tr>
          </thead>
          <tbody>
            <tr className="align-top">
              <Td><TextInput value={draft.orderNo} onChange={(v) => set("orderNo", v)} width="w-28" /></Td>
              <Td><TextInput value={draft.styleNo} onChange={(v) => set("styleNo", v)} width="w-36" /></Td>
              <Td><TextInput value={draft.itemDes} onChange={(v) => set("itemDes", v)} width="w-64" /></Td>
              <Td><NumInput value={draft.orderQty} onChange={(v) => set("orderQty", v)} step="1" width="w-24" /></Td>
              <Td><NumInput value={draft.totalWithPacks} onChange={(v) => set("totalWithPacks", v)} step="1" width="w-28" /></Td>
              <Td><NumInput value={draft.fob} onChange={(v) => set("fob", v)} step="0.01" width="w-24" /></Td>
              <Td><NumInput value={draft.value} onChange={(v) => set("value", v)} step="0.01" width="w-28" /></Td>
              <Td><TextInput value={draft.tod} onChange={(v) => set("tod", v)} width="w-56" /></Td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="mt-3 flex items-center justify-between">
        <p className="text-[11px] text-slate-400">
          Blank fields in the PDFs stay blank in the Excel. Total Qty With Packs = Order Qty × pack/set (fallback); Value =
          Order Qty × Unit Price (fallback). Any value you type replaces the fallback. Edits are append-only — previous data is never
          overwritten in the DB.
        </p>
        <div className="flex items-center gap-2">
          {saved ? <span className="text-[11px] font-medium text-green-700">✓ Saved</span> : null}
          <button className="btn-primary text-xs" disabled={pending} onClick={save}>
            {pending ? "Saving…" : "💾 Save row"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="th whitespace-nowrap">{children}</th>;
}
function Td({ children }: { children: React.ReactNode }) {
  return <td className="td align-top">{children}</td>;
}
function TextInput({ value, onChange, width }: { value: string; onChange: (v: string) => void; width: string }) {
  return <input type="text" className={`input ${width}`} value={value} onChange={(e) => onChange(e.target.value)} />;
}
function NumInput({ value, onChange, step, width }: { value: string; onChange: (v: string) => void; step: string; width: string }) {
  return <input type="number" step={step} className={`input ${width} text-right`} value={value} onChange={(e) => onChange(e.target.value)} />;
}

function StateBadge({ state }: { state: string }) {
  const tone =
    state === "READY" ? "bg-green-100 text-green-800" :
    state === "NEEDS_REVIEW" ? "bg-amber-100 text-amber-800" :
    state === "BLOCKED" ? "bg-amber-100 text-amber-800" :
    state === "FAILED" ? "bg-rose-100 text-rose-800" :
    "bg-slate-100 text-slate-600";
  return <span className={`badge ${tone}`}>{state}</span>;
}

function pickStr(override: string | number | null | undefined, extracted: string): string {
  if (override === null || override === undefined) return extracted ?? "";
  return String(override);
}
function pickNum(override: string | number | null | undefined, extracted: number | null): number | null {
  if (override === null || override === undefined) return extracted;
  const n = typeof override === "number" ? override : Number(override);
  return Number.isFinite(n) ? n : null;
}
