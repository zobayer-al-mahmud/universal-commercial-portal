"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { OrderNoCreateButton } from "@/components/CustomsInvoiceCreate";

export interface InvoiceListRow {
  orderNo: string;
  marketCode: string;
  marketSubCode: string;
  contractNo: string;
  styleNo: string;
  quantityPcs: number | null;
  unitPrice: number | null;
  foundInSalesContract: boolean;
  foundInShipmentSchedule: boolean;
  hasInvoice: boolean;
  invoiceId: string | null;
  templateCode: string | null;
  templateVariant: string | null;
  templateFilename: string | null;
}

/**
 * Client-side filtered list of invoice-ready Order Nos. Search is a plain
 * case-insensitive substring match against Order No. — the field the user
 * knows (short key, e.g. "644637"). Also matches on the full H&M order,
 * contract no., style and country code so operators can jump by any of them.
 */
export function CustomsInvoiceListTable({ rows }: { rows: InvoiceListRow[] }) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => {
      const hay = [
        r.orderNo,
        r.marketCode,
        r.marketSubCode,
        r.contractNo,
        r.styleNo,
        r.templateCode ?? "",
        r.templateFilename ?? "",
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [rows, query]);

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[220px]">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by Order No. (also matches contract, style, country code)"
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

      <div className="card overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-slate-50">
            <tr>
              <th className="th">#</th>
              <th className="th">Order No.</th>
              <th className="th">Country code</th>
              <th className="th">Resolved template</th>
              <th className="th">Contract</th>
              <th className="th">Style</th>
              <th className="th">Qty</th>
              <th className="th">FOB</th>
              <th className="th">Source</th>
              <th className="th">Invoice</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={10} className="td text-center text-slate-400">
                  {rows.length === 0
                    ? "No Order Nos found yet. Upload a Sales Contract 3-PDF set or a Shipment Schedule booking confirmation."
                    : `No Order No matches "${query}".`}
                </td>
              </tr>
            ) : (
              filtered.map((r, i) => (
                <tr key={r.orderNo} className="border-t border-slate-50">
                  <td className="td text-slate-400">{i + 1}</td>
                  <td className="td font-mono">{r.orderNo}</td>
                  <td className="td">
                    {r.marketCode || <span className="text-slate-400">—</span>}
                    {r.marketSubCode && /^[A-Z0-9\-]{1,20}$/i.test(r.marketSubCode) ? (
                      <span className="text-slate-400"> · {r.marketSubCode}</span>
                    ) : null}
                  </td>
                  <td className="td">
                    {r.templateCode ? (
                      <>
                        <span className="font-mono text-slate-700">
                          {r.templateCode}
                          {r.templateVariant ? ` (${r.templateVariant})` : ""}
                        </span>
                        <div className="text-[10px] text-slate-400">{r.templateFilename}</div>
                      </>
                    ) : (
                      <span className="badge bg-amber-100 text-amber-800">no template</span>
                    )}
                  </td>
                  <td className="td font-mono">{r.contractNo || "—"}</td>
                  <td className="td">{r.styleNo || "—"}</td>
                  <td className="td text-right">{r.quantityPcs ?? "—"}</td>
                  <td className="td text-right">{r.unitPrice != null ? r.unitPrice.toFixed(2) : "—"}</td>
                  <td className="td">
                    <div className="flex gap-1">
                      {r.foundInSalesContract ? <span className="badge bg-sky-100 text-sky-800">SC</span> : null}
                      {r.foundInShipmentSchedule ? <span className="badge bg-green-100 text-green-800">SS</span> : null}
                    </div>
                  </td>
                  <td className="td">
                    {r.hasInvoice && r.invoiceId ? (
                      <Link href={`/customs-invoice/${r.invoiceId}`} className="btn-ghost text-[10px]">
                        Open →
                      </Link>
                    ) : (
                      <OrderNoCreateButton orderNo={r.orderNo} />
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
