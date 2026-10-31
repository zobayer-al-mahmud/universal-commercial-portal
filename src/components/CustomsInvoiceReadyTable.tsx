"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { OrderNoCreateButton } from "@/components/CustomsInvoiceCreate";
import { BulkDownloadBar } from "@/components/BulkDownloadBar";

export interface InvoiceReadyListRow {
  invoiceNo: string;
  rowId: string;
  orderNo: string;
  countryCode: string;
  countrySubCode: string;
  contractNo: string;
  buyerCode: string;
  styleNo: string;
  quantityPcs: number | null;
  unitPrice: number | null;
  bcn: string;
  bookingRef: string;
  bookingStatus: string;
  grossWeightKg: number | null;
  totalCartons: number | null;
  weekNo: number | null;
  hasInvoice: boolean;
  invoiceId: string | null;
  templateCode: string | null;
  templateVariant: string | null;
  templateFilename: string | null;
}

export function CustomsInvoiceReadyTable({ rows }: { rows: InvoiceReadyListRow[] }) {
  const [query, setQuery] = useState("");
  // Selection is keyed by CustomsInvoice id (only rows that already have an
  // invoice are selectable; "Create invoice" first for the rest).
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => {
      const hay = [
        r.invoiceNo, r.orderNo, r.countryCode, r.countrySubCode,
        r.contractNo, r.buyerCode, r.styleNo, r.bcn, r.bookingRef,
        r.templateCode ?? "", r.templateFilename ?? "",
      ].join(" ").toLowerCase();
      return hay.includes(q);
    });
  }, [rows, query]);

  const selectableIds = useMemo(
    () => filtered.filter((r) => r.hasInvoice && r.invoiceId).map((r) => r.invoiceId!),
    [filtered],
  );
  const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selected.has(id));
  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const toggleAll = () => {
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
  };
  const selectedIds = Array.from(selected);

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[220px]">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by Invoice No., Order No., country, BCN, BRef, style, contract…"
            className="w-full rounded-md border border-slate-200 bg-white px-3 py-1.5 pr-8 text-xs placeholder:text-slate-400 focus:border-sky-400 focus:outline-none focus:ring-1 focus:ring-sky-200"
          />
          {query ? (
            <button
              onClick={() => setQuery("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
              aria-label="Clear search"
              type="button"
            >
              ×
            </button>
          ) : null}
        </div>
        <span className="text-[11px] text-slate-500">
          {filtered.length} of {rows.length} shown
        </span>
      </div>

      <div className="mb-3">
        <BulkDownloadBar
          endpoint="/api/customs-invoice/bulk-download"
          bodyKey="ids"
          ids={selectedIds}
          totalCount={selectableIds.length}
          allSelected={allSelected}
          onSelectAll={toggleAll}
          onClear={() => setSelected(new Set())}
          fileNameBase="CustomsInvoices"
        />
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-slate-50">
            <tr>
              <th className="th w-8">
                <input
                  type="checkbox"
                  aria-label="Select all"
                  checked={allSelected}
                  onChange={toggleAll}
                  disabled={selectableIds.length === 0}
                />
              </th>
              <th className="th">#</th>
              <th className="th">Invoice No.</th>
              <th className="th">Order No.</th>
              <th className="th">Country · Sub</th>
              <th className="th">Buyer</th>
              <th className="th">Contract</th>
              <th className="th">Style</th>
              <th className="th">Qty</th>
              <th className="th">FOB</th>
              <th className="th">BCN · BRef</th>
              <th className="th">GW · Ctns</th>
              <th className="th">Template</th>
              <th className="th">Week</th>
              <th className="th">Open</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={15} className="td text-center text-slate-400">
                  {rows.length === 0
                    ? "No invoice-ready rows yet. A row shows up here once its booking PDF is uploaded AND an invoice number is allocated for the week."
                    : `No row matches "${query}".`}
                </td>
              </tr>
            ) : (
              filtered.map((r, i) => (
                <tr key={r.rowId} className="border-t border-slate-50">
                  <td className="td">
                    {r.hasInvoice && r.invoiceId ? (
                      <input
                        type="checkbox"
                        aria-label={`Select invoice ${r.invoiceNo}`}
                        checked={selected.has(r.invoiceId)}
                        onChange={() => toggle(r.invoiceId!)}
                      />
                    ) : (
                      <span className="text-[10px] text-slate-300" title="Create the invoice before selecting it">—</span>
                    )}
                  </td>
                  <td className="td text-slate-400">{i + 1}</td>
                  <td className="td font-mono font-semibold text-slate-800">{r.invoiceNo}</td>
                  <td className="td font-mono">{r.orderNo}</td>
                  <td className="td">
                    {r.countryCode || <span className="text-slate-400">—</span>}
                    {r.countrySubCode ? <span className="text-slate-400"> · {r.countrySubCode}</span> : null}
                  </td>
                  <td className="td">{r.buyerCode || "—"}</td>
                  <td className="td font-mono">{r.contractNo || "—"}</td>
                  <td className="td">{r.styleNo || "—"}</td>
                  <td className="td text-right">{r.quantityPcs ?? "—"}</td>
                  <td className="td text-right">{r.unitPrice != null ? r.unitPrice.toFixed(2) : "—"}</td>
                  <td className="td">
                    <div className="font-mono text-slate-700">{r.bcn || "—"}</div>
                    <div className="font-mono text-[10px] text-slate-400">{r.bookingRef || ""}</div>
                  </td>
                  <td className="td text-right">
                    <div>{r.grossWeightKg != null ? r.grossWeightKg : "—"}</div>
                    <div className="text-[10px] text-slate-400">{r.totalCartons != null ? `${r.totalCartons} ctns` : ""}</div>
                  </td>
                  <td className="td">
                    {r.templateCode ? (
                      <>
                        <span className="font-mono text-slate-700">
                          {r.templateCode}
                          {r.templateVariant ? ` (${r.templateVariant})` : ""}
                        </span>
                      </>
                    ) : (
                      <span className="badge bg-amber-100 text-amber-800">no template</span>
                    )}
                  </td>
                  <td className="td">{r.weekNo ?? "—"}</td>
                  <td className="td">
                    {r.hasInvoice && r.invoiceId ? (
                      <Link href={`/customs-invoice/${r.invoiceId}`} className="btn-ghost text-[10px]">
                        Open →
                      </Link>
                    ) : (
                      <OrderNoCreateButton orderNo={r.orderNo} invoiceNo={r.invoiceNo} />
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
