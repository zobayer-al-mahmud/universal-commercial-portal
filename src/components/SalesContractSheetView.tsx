"use client";

import { useEffect, useMemo, useState } from "react";

interface SheetRow {
  orderNo: string;
  styleNo: string;
  description: string;
  orderQty: number | null;
  unitPrice: number | null;
  timeOfDelivery: string;
  commercialRef: string;
  packSet: number;
  totalWithPacksE?: number | null;
  value?: number | null;
  totalWithPacksJ?: number | null;
}
interface SheetHeader {
  contractNo: string;
  blockYear: string;
  contractDate: string;
  reviseNo: string;
  lastUpdatedDate: string;
}
interface SheetPayload { header: SheetHeader; rows: SheetRow[] }

type EditableKey =
  | "styleNo" | "description" | "orderQty" | "unitPrice" | "timeOfDelivery"
  | "commercialRef" | "packSet"
  | "totalWithPacksE" | "value" | "totalWithPacksJ";

/**
 * Editable in-portal preview of the per-contract Sales Contract sheet. Click
 * any cell, type, press Save — the row's overrides are persisted on the PO
 * (sheetEditsJson) and merged back on every subsequent read + xlsx download.
 */
export function SalesContractSheetView({ contractId }: { contractId: string }) {
  const [data, setData] = useState<SheetPayload | null>(null);
  const [error, setError] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);
  const [refreshToken, setRefreshToken] = useState<number>(0);
  const [edits, setEdits] = useState<Record<string, Partial<Record<EditableKey, string | number | null>>>>({});
  const [saving, setSaving] = useState<boolean>(false);
  const [savedMsg, setSavedMsg] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError("");
      try {
        const res = await fetch(`/api/sales-contract/${contractId}/sheet?mode=json`, { cache: "no-store" });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
        if (!cancelled) { setData(body as SheetPayload); setEdits({}); }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [contractId, refreshToken]);

  const blockRef = (() => {
    const cn = (data?.header.contractNo || "").trim();
    if (!cn) return "Block Contract Ref:  :";
    const pretty = /AGL/i.test(cn) ? cn : `AGL/H&M/${cn}/${data?.header.blockYear || ""}`;
    return `Block Contract Ref:  : ${pretty}`;
  })();

  // Render-time rows: base + pending (unsaved) edits.
  const displayRows: SheetRow[] = useMemo(() => {
    if (!data) return [];
    return data.rows.map((r) => {
      const over = edits[r.orderNo] ?? {};
      const numOrNull = (v: unknown): number | null | undefined =>
        v === null ? null : (typeof v === "number" ? v : undefined);
      return {
        ...r,
        styleNo: typeof over.styleNo === "string" ? over.styleNo : r.styleNo,
        description: typeof over.description === "string" ? over.description : r.description,
        orderQty: numOrNull(over.orderQty) !== undefined ? (numOrNull(over.orderQty) as number | null) : r.orderQty,
        unitPrice: numOrNull(over.unitPrice) !== undefined ? (numOrNull(over.unitPrice) as number | null) : r.unitPrice,
        timeOfDelivery: typeof over.timeOfDelivery === "string" ? over.timeOfDelivery : r.timeOfDelivery,
        commercialRef: typeof over.commercialRef === "string" ? over.commercialRef : r.commercialRef,
        packSet: typeof over.packSet === "number" && over.packSet > 0 ? over.packSet : r.packSet,
        totalWithPacksE: numOrNull(over.totalWithPacksE) !== undefined ? numOrNull(over.totalWithPacksE) : r.totalWithPacksE,
        value: numOrNull(over.value) !== undefined ? numOrNull(over.value) : r.value,
        totalWithPacksJ: numOrNull(over.totalWithPacksJ) !== undefined ? numOrNull(over.totalWithPacksJ) : r.totalWithPacksJ,
      };
    });
  }, [data, edits]);

  const totalQty = displayRows.reduce((n, r) => n + (Number.isFinite(r.orderQty ?? NaN) ? (r.orderQty as number) : 0), 0);
  const totalValue = displayRows.reduce((n, r) => {
    if (!Number.isFinite(r.orderQty ?? NaN) || !Number.isFinite(r.unitPrice ?? NaN)) return n;
    return n + (r.orderQty as number) * (r.unitPrice as number);
  }, 0);
  const dirtyCount = Object.keys(edits).length;

  const numericKeys = new Set<EditableKey>(["orderQty", "unitPrice", "packSet", "totalWithPacksE", "value", "totalWithPacksJ"]);
  const update = (orderNo: string, key: EditableKey, value: string) => {
    setSavedMsg("");
    setEdits((prev) => {
      const row = { ...(prev[orderNo] ?? {}) };
      if (numericKeys.has(key)) {
        if (value.trim() === "") row[key] = null;
        else {
          const n = Number(value);
          row[key] = Number.isFinite(n) ? n : null;
        }
      } else {
        row[key] = value;
      }
      return { ...prev, [orderNo]: row };
    });
  };

  const save = async () => {
    if (dirtyCount === 0) return;
    setSaving(true);
    setError("");
    setSavedMsg("");
    try {
      const res = await fetch(`/api/sales-contract/${contractId}/sheet`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ edits }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setSavedMsg(`✓ Saved ${body.updated ?? 0} row${(body.updated ?? 0) === 1 ? "" : "s"}.`);
      setEdits({});
      setRefreshToken((t) => t + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 p-4">
        <div className="flex items-center gap-2 text-sm font-semibold text-slate-700">
          📊 Sales Contract sheet
          <span className="font-normal text-xs text-slate-500">matches the live revise-73/45/21 xlsx layout</span>
        </div>
        <div className="flex items-center gap-2">
          {savedMsg ? <span className="text-xs text-emerald-700">{savedMsg}</span> : null}
          {dirtyCount > 0 ? <span className="text-xs text-amber-700">{dirtyCount} unsaved row{dirtyCount === 1 ? "" : "s"}</span> : null}
          <button onClick={() => { setEdits({}); setRefreshToken((t) => t + 1); setSavedMsg(""); }} className="btn-ghost text-xs">🔄 Reload</button>
          <button onClick={save} disabled={saving || dirtyCount === 0} className={dirtyCount > 0 ? "btn-primary text-xs" : "btn-ghost text-xs cursor-not-allowed opacity-60"}>
            {saving ? "Saving…" : "💾 Save edits"}
          </button>
          <a href={`/api/sales-contract/${contractId}/sheet`} download className="btn-primary text-xs">⬇ Download .xlsx</a>
        </div>
      </div>

      {error ? <div className="m-4 rounded border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">{error}</div> : null}

      {loading && !data ? (
        <div className="p-6 text-center text-sm text-slate-400">Loading sheet…</div>
      ) : null}

      {data ? (
        <div className="overflow-x-auto p-4">
          <div className="mb-4 flex flex-wrap items-baseline justify-between gap-3 border-b border-slate-200 pb-2 font-serif text-sm">
            <div className="font-bold text-blue-700">{blockRef}</div>
            <div className="font-bold text-blue-700">Date: {data.header.contractDate || "—"}</div>
          </div>
          {(data.header.reviseNo || data.header.lastUpdatedDate) ? (
            <div className="mb-4 flex flex-wrap items-baseline justify-between gap-3 font-serif text-xs">
              <div className="font-bold text-blue-700">{data.header.reviseNo ? `Revise: ${data.header.reviseNo}` : ""}</div>
              <div className="font-bold text-blue-700">{data.header.lastUpdatedDate ? `Date: ${data.header.lastUpdatedDate}` : ""}</div>
            </div>
          ) : null}

          <table className="min-w-[1400px] border-collapse text-[11px] font-bold text-blue-700">
            <colgroup>
              <col style={{ minWidth: 110 }} />   {/* Order No */}
              <col style={{ minWidth: 180 }} />   {/* Style */}
              <col style={{ minWidth: 300 }} />   {/* Description */}
              <col style={{ minWidth: 90  }} />   {/* Order Qty */}
              <col style={{ minWidth: 110 }} />   {/* Total Qty With Pack & Set */}
              <col style={{ minWidth: 90  }} />   {/* Unit Price */}
              <col style={{ minWidth: 110 }} />   {/* Value */}
              <col style={{ minWidth: 130 }} />   {/* Time of Delivery */}
              <col style={{ minWidth: 170 }} />   {/* Commercial Ref */}
              <col style={{ minWidth: 110 }} />   {/* Total Qty With Pack & Set */}
              <col style={{ minWidth: 80  }} />   {/* Pack / Set */}
            </colgroup>
            <thead>
              <tr className="border-y border-slate-800">
                <Th>Order No.</Th>
                <Th>Style No.</Th>
                <Th>Description</Th>
                <Th align="right">Order Qty</Th>
                <Th align="right">Total Qty With Pack&nbsp;&amp;&nbsp;Set</Th>
                <Th align="right">Unit Price</Th>
                <Th align="right">Value</Th>
                <Th>Time of Delivery</Th>
                <Th>Commercial Ref</Th>
                <Th align="right">Total Qty With Pack&nbsp;&amp;&nbsp;Set</Th>
                <Th align="right">Pack / Set</Th>
              </tr>
            </thead>
            <tbody>
              {displayRows.length === 0 ? (
                <tr><td colSpan={11} className="border-b border-slate-200 p-6 text-center text-sm font-normal text-slate-400">No READY POs yet — scan a folder first.</td></tr>
              ) : null}
              {displayRows.map((r) => {
                const touched = (k: EditableKey) => (edits[r.orderNo] ?? {})[k] !== undefined;
                // Computed fallbacks (user override wins; when blank we show the computed value).
                const computedE = Number.isFinite(r.orderQty ?? NaN) ? (r.orderQty as number) * (r.packSet || 1) : null;
                const computedG = Number.isFinite(r.orderQty ?? NaN) && Number.isFinite(r.unitPrice ?? NaN) ? (r.orderQty as number) * (r.unitPrice as number) : null;
                const computedJ = computedE;
                const effE = r.totalWithPacksE ?? computedE;
                const effG = r.value ?? computedG;
                const effJ = r.totalWithPacksJ ?? computedJ;
                return (
                  <tr key={r.orderNo} className={`border-b border-slate-200 ${Object.keys(edits[r.orderNo] ?? {}).length ? "bg-amber-50/40" : ""}`}>
                    <Td mono>{r.orderNo}</Td>
                    <TdInput value={r.styleNo} dirty={touched("styleNo")} onChange={(v) => update(r.orderNo, "styleNo", v)} />
                    <TdInput value={r.description} dirty={touched("description")} onChange={(v) => update(r.orderNo, "description", v)} wrap />
                    <TdInput value={r.orderQty === null ? "" : String(r.orderQty)} dirty={touched("orderQty")} onChange={(v) => update(r.orderNo, "orderQty", v)} align="right" numeric />
                    <TdInput value={effE === null ? "" : String(effE)} dirty={touched("totalWithPacksE")} onChange={(v) => update(r.orderNo, "totalWithPacksE", v)} align="right" numeric />
                    <TdInput value={r.unitPrice === null ? "" : String(r.unitPrice)} dirty={touched("unitPrice")} onChange={(v) => update(r.orderNo, "unitPrice", v)} align="right" numeric />
                    <TdInput value={effG === null ? "" : String(effG)} dirty={touched("value")} onChange={(v) => update(r.orderNo, "value", v)} align="right" numeric />
                    <TdInput value={r.timeOfDelivery} dirty={touched("timeOfDelivery")} onChange={(v) => update(r.orderNo, "timeOfDelivery", v)} />
                    <TdInput value={r.commercialRef} dirty={touched("commercialRef")} onChange={(v) => update(r.orderNo, "commercialRef", v)} />
                    <TdInput value={effJ === null ? "" : String(effJ)} dirty={touched("totalWithPacksJ")} onChange={(v) => update(r.orderNo, "totalWithPacksJ", v)} align="right" numeric />
                    <TdInput value={String(r.packSet)} dirty={touched("packSet")} onChange={(v) => update(r.orderNo, "packSet", v)} align="right" numeric />
                  </tr>
                );
              })}
              {displayRows.length > 0 ? (() => {
                const totE = displayRows.reduce((n, r) => n + (Number.isFinite(r.totalWithPacksE ?? (Number.isFinite(r.orderQty ?? NaN) ? (r.orderQty as number) * (r.packSet || 1) : NaN)) ? (r.totalWithPacksE ?? ((r.orderQty as number) * (r.packSet || 1))) as number : 0), 0);
                const totG = displayRows.reduce((n, r) => {
                  const v = r.value ?? (Number.isFinite(r.orderQty ?? NaN) && Number.isFinite(r.unitPrice ?? NaN) ? (r.orderQty as number) * (r.unitPrice as number) : null);
                  return n + (v === null ? 0 : v);
                }, 0);
                const totJ = displayRows.reduce((n, r) => n + (Number.isFinite(r.totalWithPacksJ ?? (Number.isFinite(r.orderQty ?? NaN) ? (r.orderQty as number) * (r.packSet || 1) : NaN)) ? (r.totalWithPacksJ ?? ((r.orderQty as number) * (r.packSet || 1))) as number : 0), 0);
                return (
                  <tr className="border-t-2 border-double border-slate-800 bg-slate-50">
                    <Td></Td>
                    <Td></Td>
                    <Td>TOTAL</Td>
                    <Td align="right">{fmtInt(totalQty)}</Td>
                    <Td align="right">{fmtInt(totE)}</Td>
                    <Td></Td>
                    <Td align="right">{fmtDecimal(totG)}</Td>
                    <Td></Td>
                    <Td></Td>
                    <Td align="right">{fmtInt(totJ)}</Td>
                    <Td></Td>
                  </tr>
                );
              })() : null}
            </tbody>
          </table>

          {displayRows.length > 0 ? (
            <div className="mt-10 grid grid-cols-2 gap-10 text-xs">
              <div>
                <div className="mb-1 text-slate-700">-------------------------------</div>
                <div className="font-bold text-slate-800">For and on Behalf of :</div>
                <div className="font-bold text-slate-800">Puls Trading Far East Ltd, Bangladesh Liaison Office</div>
                <div className="text-slate-600">House # NW(K) 8/A, Road # 50, Gulshan - 2, Dhaka - 1212, Bangladesh</div>
              </div>
              <div>
                <div className="mb-1 text-slate-700">-------------------------------</div>
                <div className="font-bold text-slate-800">For and on Behalf of :</div>
                <div className="font-bold text-slate-800">Ananta Garments Ltd.</div>
                <div className="text-slate-600">Plot: 20, Gareeb-E-Newaz Avenue, Sector 13, Uttara, Dhaka-1230</div>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Th({ children, align }: { children: React.ReactNode; align?: "left" | "right" }) {
  return <th className={`border-r border-slate-100 px-2 py-2 font-bold ${align === "right" ? "text-right" : "text-left"}`}>{children}</th>;
}
function Td({ children, align, mono }: { children?: React.ReactNode; align?: "left" | "right"; mono?: boolean }) {
  return <td className={`border-r border-slate-100 px-2 py-1 align-top ${align === "right" ? "text-right" : "text-left"} ${mono ? "font-mono" : ""}`}>{children ?? ""}</td>;
}
function TdInput(props: { value: string; onChange: (v: string) => void; dirty?: boolean; align?: "left" | "right"; numeric?: boolean; wrap?: boolean }) {
  const base = `w-full min-w-0 bg-transparent px-2 py-1 text-[11px] font-bold text-blue-700 focus:bg-white focus:outline focus:outline-1 focus:outline-sky-400 ${props.align === "right" ? "text-right" : "text-left"}`;
  const dirtyBg = props.dirty ? "bg-amber-100/60" : "";
  return (
    <td className="border-r border-slate-100 p-0 align-top">
      <input
        type="text"
        inputMode={props.numeric ? "decimal" : undefined}
        value={props.value}
        onChange={(e) => {
          const v = e.target.value;
          if (props.numeric) {
            if (!/^-?\d*(\.\d*)?$/.test(v)) return;
          }
          props.onChange(v);
        }}
        onWheel={(e) => e.currentTarget.blur()}
        className={`${base} ${dirtyBg}`}
        autoComplete="off"
        title={props.value}
      />
    </td>
  );
}
function fmtInt(n: number | null): string {
  if (!Number.isFinite(n ?? NaN) || n === null) return "";
  return (n as number).toLocaleString("en-US");
}
function fmtDecimal(n: number | null): string {
  if (!Number.isFinite(n ?? NaN) || n === null) return "";
  return (n as number).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
