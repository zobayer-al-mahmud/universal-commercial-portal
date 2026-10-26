"use client";

/**
 * Spreadsheet-style editable Sales Contract table (replaces the stacked per-PO
 * cards). One sticky header row, one editable row per PO, every cell inline. A
 * single "Save Changes" button at the top persists ONLY the cells the user
 * actually changed (grouped per PO) via the existing append-only
 * `editHmRowAction`. Calculations, fallbacks, validation and history are
 * unchanged — this is a UI shape change, not a logic change.
 */
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { editHmRowAction } from "@/app/actions/hm-sales-contract";
import type { SalesContractPoRow } from "@/components/SalesContractPoEditor";

type FieldKey = "orderNo" | "styleNo" | "itemDes" | "orderQty" | "totalWithPacks" | "fob" | "value" | "tod";

const COLUMNS: { key: FieldKey; label: string; kind: "text" | "int" | "num"; width: string }[] = [
  { key: "orderNo", label: "Order No.", kind: "text", width: "w-28" },
  { key: "styleNo", label: "Style No.", kind: "text", width: "w-32" },
  { key: "itemDes", label: "Description", kind: "text", width: "w-56" },
  { key: "orderQty", label: "Order Qty", kind: "int", width: "w-24" },
  { key: "totalWithPacks", label: "Total Qty With Packs", kind: "int", width: "w-28" },
  { key: "fob", label: "Unit Price", kind: "num", width: "w-24" },
  { key: "value", label: "Value", kind: "num", width: "w-28" },
  { key: "tod", label: "Time of Delivery", kind: "text", width: "w-48" },
];

function pickStr(override: string | number | null | undefined, extracted: string): string {
  if (override === null || override === undefined) return extracted ?? "";
  return String(override);
}
function pickNum(override: string | number | null | undefined, extracted: number | null): number | null {
  if (override === null || override === undefined) return extracted;
  const n = typeof override === "number" ? override : Number(override);
  return Number.isFinite(n) ? n : null;
}

/** Initial display value for one cell (override wins, else extracted/calc fallback). */
function initialValue(po: SalesContractPoRow, key: FieldKey): string {
  const o = po.overrides ?? {};
  const packSetN = Number(po.packSet);
  const packs = Number.isFinite(packSetN) && packSetN > 0 ? packSetN : 1;
  const orderQty = pickNum(o.orderQty, po.orderQty);
  const fob = pickNum(o.fob, po.fob);
  switch (key) {
    case "orderNo": return pickStr(o.orderNo, po.orderNo);
    case "styleNo": return pickStr(o.styleNo, po.styleNo);
    case "itemDes": return pickStr(o.itemDes, po.itemDes);
    case "tod": return pickStr(o.tod, po.tod);
    case "orderQty": return orderQty === null ? "" : String(orderQty);
    case "fob": return fob === null ? "" : String(fob);
    case "totalWithPacks": {
      const calc = orderQty !== null ? orderQty * packs : null;
      const v = pickNum(o.totalWithPacks, calc);
      return v === null ? "" : String(v);
    }
    case "value": {
      const calc = orderQty !== null && fob !== null ? orderQty * fob : null;
      const v = pickNum(o.value, calc);
      return v === null ? "" : String(v);
    }
  }
}

const cellKey = (poId: string, field: FieldKey) => `${poId}:${field}`;

export function SalesContractGrid({ contractId, pos }: { contractId: string; pos: SalesContractPoRow[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [edits, setEdits] = useState<Map<string, string>>(new Map());
  const [status, setStatus] = useState<"idle" | "saved" | "error">("idle");
  const [errorText, setErrorText] = useState<string | null>(null);

  // Baseline of original values so we can tell what actually changed.
  const baseline = useMemo(() => {
    const m = new Map<string, string>();
    for (const po of pos) for (const c of COLUMNS) m.set(cellKey(po.poId, c.key), initialValue(po, c.key));
    return m;
  }, [pos]);

  const valueOf = (poId: string, field: FieldKey) => {
    const k = cellKey(poId, field);
    return edits.has(k) ? edits.get(k)! : (baseline.get(k) ?? "");
  };

  const setCell = (poId: string, field: FieldKey, value: string) => {
    setStatus("idle");
    setEdits((prev) => {
      const next = new Map(prev);
      const k = cellKey(poId, field);
      if (value === (baseline.get(k) ?? "")) next.delete(k);
      else next.set(k, value);
      return next;
    });
  };

  const dirtyCount = edits.size;
  const dirtyPoIds = useMemo(() => {
    const set = new Set<string>();
    for (const k of edits.keys()) set.add(k.split(":")[0]);
    return set;
  }, [edits]);

  const save = () => {
    if (dirtyPoIds.size === 0) return;
    setErrorText(null);
    start(async () => {
      try {
        for (const poId of dirtyPoIds) {
          const po = pos.find((p) => p.poId === poId);
          if (!po) continue;
          const fd = new FormData();
          fd.set("poId", poId);
          fd.set("contractId", contractId);
          fd.set("marketCode", po.marketCode || "ALL");
          // Send ONLY the changed cells for this PO.
          for (const c of COLUMNS) {
            const k = cellKey(poId, c.key);
            if (edits.has(k)) fd.set(c.key, edits.get(k)!);
          }
          await editHmRowAction(fd);
        }
        setEdits(new Map());
        setStatus("saved");
        router.refresh();
        setTimeout(() => setStatus("idle"), 2000);
      } catch (e) {
        setStatus("error");
        setErrorText(e instanceof Error ? e.message : "Save failed.");
      }
    });
  };

  return (
    <div className="card overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
        <div className="text-sm font-semibold text-slate-700">
          PO rows ({pos.length})
          {dirtyCount > 0 ? <span className="ml-2 text-xs font-normal text-amber-600">• {dirtyCount} unsaved change{dirtyCount > 1 ? "s" : ""}</span> : null}
        </div>
        <div className="flex items-center gap-3">
          {status === "saved" ? <span className="text-xs font-medium text-green-700">✓ Saved</span> : null}
          {status === "error" ? <span className="text-xs font-medium text-rose-600">{errorText || "Save failed"}</span> : null}
          <button onClick={save} disabled={pending || dirtyCount === 0} className="btn-primary text-xs disabled:opacity-40">
            {pending ? "Saving…" : "💾 Save Changes"}
          </button>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-slate-50">
            <tr>
              <th className="th text-left">PO</th>
              {COLUMNS.map((c) => <th key={c.key} className="th whitespace-nowrap text-left">{c.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {pos.map((po) => (
              <tr key={po.poId} className="border-t border-slate-100">
                <td className="td whitespace-nowrap">
                  <StateBadge state={po.state} />
                </td>
                {COLUMNS.map((c) => {
                  const k = cellKey(po.poId, c.key);
                  const changed = edits.has(k);
                  return (
                    <td key={c.key} className="td">
                      <input
                        type={c.kind === "text" ? "text" : "number"}
                        step={c.kind === "num" ? "0.01" : c.kind === "int" ? "1" : undefined}
                        value={valueOf(po.poId, c.key)}
                        onChange={(e) => setCell(po.poId, c.key, e.target.value)}
                        className={`w-full rounded border px-1.5 py-1 ${c.width} ${c.kind === "text" ? "" : "text-right"} ${changed ? "border-amber-400 bg-amber-50" : "border-transparent hover:border-slate-200"}`}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
            {pos.length === 0 ? (
              <tr><td className="td text-slate-400" colSpan={COLUMNS.length + 1}>No POs yet.</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <div className="border-t border-slate-100 px-4 py-2 text-[11px] text-slate-400">
        Total Qty With Packs = Order Qty × pack/set and Value = Order Qty × Unit Price by default; type a value to override. Edits are
        append-only — previous data is never overwritten. Only changed cells are saved.
      </div>
    </div>
  );
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
