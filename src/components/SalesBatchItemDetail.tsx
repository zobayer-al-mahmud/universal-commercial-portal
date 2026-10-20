"use client";

import { useState } from "react";

interface ExtractionField { label: string; value: string }
interface ExtractionRow {
  orderNo?: string;
  planningMarketA?: string;
  planningMarketB?: string;
  quantity?: string;
  invoiceAveragePrice?: string;
  timeOfDelivery?: string;
}
interface ExtractionSummary {
  kind: "PurchaseOrder" | "SizePerColourBreakdown" | "TotalCountryBreakdown" | "Unknown";
  fields: ExtractionField[];
  rows: ExtractionRow[];
  totals: ExtractionField[];
  notes: string[];
}
export interface SalesBatchItemExtraction {
  kind?: ExtractionSummary["kind"];
  summary?: ExtractionSummary;
  orderNumbers?: string[];
  poRowCount?: number;
  textChars?: number;
  reviewReasons?: { code: string; reason: string; severity: "hard" | "pending" }[];
  contractRows?: { orderNo: string; orderQty: number; unitPrice: number; value: number }[];
}

/** Expandable per-file extraction detail. Shows every extracted field name
 *  and value — never a one-line error alone (user feedback: SCHEMA_DRIFT
 *  without the fields hid the real content). */
export function SalesBatchItemDetail({ data }: { data: SalesBatchItemExtraction | null }) {
  const [open, setOpen] = useState(false);
  if (!data || (!data.summary && !data.reviewReasons?.length)) {
    return <span className="text-slate-400">—</span>;
  }
  const kind = data.kind ?? data.summary?.kind ?? "Unknown";
  const summary = data.summary;
  const fields = summary?.fields ?? [];
  const rows = summary?.rows ?? [];
  const totals = summary?.totals ?? [];
  const notes = summary?.notes ?? [];
  return (
    <div>
      <button
        type="button"
        className="text-ananta hover:underline text-xs"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? "Hide" : "Show"} extraction ({kind}{fields.length ? ` · ${fields.length} fields` : ""}{rows.length ? ` · ${rows.length} PO row${rows.length > 1 ? "s" : ""}` : ""})
      </button>
      {open ? (
        <div className="mt-2 space-y-3 rounded border border-slate-200 bg-slate-50 p-3">
          <div className="flex items-center gap-2 text-[11px]">
            <KindBadge kind={kind} />
            <span className="text-slate-500">text {data.textChars ?? 0} chars</span>
            {typeof data.poRowCount === "number" ? <span className="text-slate-500">· {data.poRowCount} PO row{data.poRowCount === 1 ? "" : "s"}</span> : null}
          </div>

          {notes.length ? (
            <div className="rounded border border-amber-100 bg-amber-50 p-2 text-xs text-amber-800">
              {notes.map((n, i) => <div key={i}>{n}</div>)}
            </div>
          ) : null}

          {totals.length ? (
            <div className="flex flex-wrap gap-2">
              {totals.map((t) => (
                <span key={t.label} className="rounded bg-white px-2 py-0.5 text-[11px] text-slate-700 border border-slate-200">
                  <span className="font-semibold">{t.label}:</span> <span className="font-mono">{t.value || "NOT EXTRACTED"}</span>
                </span>
              ))}
            </div>
          ) : null}

          {rows.length ? (
            <div className="overflow-x-auto">
              <div className="text-[11px] font-semibold text-slate-600 mb-1">Purchase order rows ({rows.length})</div>
              <table className="w-full text-[11px]">
                <thead className="bg-white">
                  <tr>
                    <th className="th">OrderNo</th>
                    <th className="th">PM-A</th>
                    <th className="th">PM-B</th>
                    <th className="th">Qty</th>
                    <th className="th">Invoice Avg Price</th>
                    <th className="th">TOD</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i} className="border-t border-slate-100 bg-white">
                      <td className="td font-mono">{val(r.orderNo)}</td>
                      <td className="td font-mono">{val(r.planningMarketA)}</td>
                      <td className="td font-mono">{val(r.planningMarketB)}</td>
                      <td className="td text-right">{val(r.quantity)}</td>
                      <td className="td text-right">{val(r.invoiceAveragePrice)}</td>
                      <td className="td">{val(r.timeOfDelivery)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          {fields.length ? (
            <div>
              <div className="text-[11px] font-semibold text-slate-600 mb-1">All extracted fields ({fields.length})</div>
              <div className="grid gap-x-4 gap-y-1 sm:grid-cols-2 lg:grid-cols-3 text-[11px]">
                {fields.map((f, i) => (
                  <div key={i} className="flex gap-2">
                    <span className="shrink-0 w-56 truncate text-slate-500">{f.label}</span>
                    <span className={`font-mono ${f.value ? "text-slate-800" : "text-slate-400 italic"}`}>{f.value || "NOT EXTRACTED"}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {data.reviewReasons?.length ? (
            <div>
              <div className="text-[11px] font-semibold text-slate-600 mb-1">Validation / review reasons</div>
              <ul className="ml-4 list-disc text-[11px] text-slate-700">
                {data.reviewReasons.map((r, i) => (
                  <li key={i}>
                    <span className={`mr-1 rounded px-1 ${r.severity === "hard" ? "bg-rose-100 text-rose-700" : "bg-amber-100 text-amber-700"}`}>{r.code}</span>
                    {r.reason}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function KindBadge({ kind }: { kind: string }) {
  const tone: Record<string, string> = {
    PurchaseOrder: "bg-green-100 text-green-800",
    SizePerColourBreakdown: "bg-sky-100 text-sky-800",
    TotalCountryBreakdown: "bg-indigo-100 text-indigo-800",
    Unknown: "bg-slate-100 text-slate-600",
  };
  return <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${tone[kind] ?? tone.Unknown}`}>{kind}</span>;
}

function val(x?: string): string {
  return x && x !== "" ? x : "—";
}
