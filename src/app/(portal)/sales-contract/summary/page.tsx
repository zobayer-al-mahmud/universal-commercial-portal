"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { PageHeader } from "@/components/ui";

interface SummaryRow {
  orderNo: string;
  // Columns A..U — same payload the Download Summary .xlsx writes, same order.
  marchentContNo: string;            // A — Marchent Cont. No.
  contractDate: string;              // B — Date (folder-level entry date)
  buyerCode: string;                 // C — Buyer Code
  commercialContNo: string;          // D — Commercial Cont. No.
  folderCommercialDate: string;      // E — Date (contract-level date)
  orderQty: number | null;           // G — Order Qty
  styleNo: string;                   // H — Style No.
  fob: number | null;                // I — FOB
  itemDes: string;                   // J — Item Des.
  cat: string;                       // K — Cat
  hts: string;                       // L — HTS
  contractValue: number | null;      // M — CONTRACT VALUE
  tod: string;                       // N — TOD
  country: string;                   // O — COUNTRY
  remarks: string;                   // P — REMARKS (manual)
  merchandiserName: string;          // Q — Merchandiser Name
  packSetQty: number | null;         // R — pack/set Qty
  packSet: string;                   // S — pack/set
  withoutDiscountOldFob: string;     // T — Without Discount / Old FOB (manual)
  discountFobConDate: string;        // U — Discount FOB con: date (manual)
  marketCode: string;
  issues: string[];
}

/**
 * Column spec — order + header text identical to SUMMARY_HEADERS in the
 * server-side writer. Order No. (F in the sheet) is deliberately placed
 * after the two dates to match the user's xlsx layout.
 */
const COLS: { header: string; render: (r: SummaryRow) => string }[] = [
  { header: "Marchent Cont. No.", render: (r) => r.marchentContNo || "—" },
  { header: "Date",               render: (r) => r.contractDate || "—" },
  { header: "Buyer Code",         render: (r) => r.buyerCode || "—" },
  { header: "Commercial Cont. No.", render: (r) => r.commercialContNo || "—" },
  { header: "Date",               render: (r) => r.folderCommercialDate || "—" },
  { header: "Order No.",          render: (r) => r.orderNo || "—" },
  { header: "Order Qty",          render: (r) => (r.orderQty != null ? r.orderQty.toLocaleString() : "—") },
  { header: "Style No.",          render: (r) => r.styleNo || "—" },
  { header: "FOB",                render: (r) => (r.fob != null ? r.fob.toFixed(2) : "—") },
  { header: "Item Des.",          render: (r) => r.itemDes || "—" },
  { header: "Cat",                render: (r) => r.cat || "—" },
  { header: "HTS",                render: (r) => r.hts || "—" },
  { header: "CONTRACT VALUE",     render: (r) => (r.contractValue != null ? r.contractValue.toLocaleString(undefined, { maximumFractionDigits: 2 }) : "—") },
  { header: "TOD",                render: (r) => r.tod || "—" },
  { header: "COUNTRY",            render: (r) => r.country || "—" },
  { header: "REMARKS",            render: (r) => r.remarks || "—" },
  { header: "Merchandiser Name",  render: (r) => r.merchandiserName || "—" },
  { header: "pack/set Qty",       render: (r) => (r.packSetQty != null ? r.packSetQty.toLocaleString() : "—") },
  { header: "pack/set",           render: (r) => r.packSet || "—" },
  { header: "Without Discount / Old FOB", render: (r) => r.withoutDiscountOldFob || "—" },
  { header: "Discount FOB con: date",     render: (r) => r.discountFobConDate || "—" },
];
const NUMERIC_HEADERS = new Set(["Order Qty", "FOB", "CONTRACT VALUE", "pack/set Qty", "pack/set"]);

/**
 * "View summary" page — renders the exact rows the Download Summary .xlsx
 * would produce, for the Sales Contracts selected on the list page. The
 * selection is passed via `?ids=a,b,c`; missing/empty = ALL contracts.
 *
 * Dedup rule: a PO extracted ONCE appears ONCE — even if the same orderNo
 * exists in multiple selected contracts, only the oldest extracted copy
 * contributes to the summary (user rule 2026-10-29).
 */
export default function SalesContractSummaryViewPage() {
  const [data, setData] = useState<{ rows: SummaryRow[]; contractCount: number; totalRows: number } | null>(null);
  const [error, setError] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(true);
  const [query, setQuery] = useState("");

  // Read ?ids=... from the URL on mount.
  const idsFromUrl = useMemo(() => {
    if (typeof window === "undefined") return "";
    const p = new URLSearchParams(window.location.search);
    return (p.get("ids") || "").trim();
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError("");
      try {
        const qs = idsFromUrl ? `?ids=${encodeURIComponent(idsFromUrl)}&mode=json` : `?mode=json`;
        const res = await fetch(`/api/sales-contract/summary${qs}`, { cache: "no-store" });
        const ct = res.headers.get("content-type") ?? "";
        if (!ct.toLowerCase().includes("application/json")) {
          throw new Error(`Server returned a non-JSON response (HTTP ${res.status}). Reload the page; if the error stays, restart the dev server.`);
        }
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
        if (!cancelled) {
          setData({
            rows: body.rows ?? [],
            contractCount: body.contractCount ?? 0,
            totalRows: body.totalRows ?? 0,
          });
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [idsFromUrl]);

  const filtered = useMemo(() => {
    if (!data) return [] as SummaryRow[];
    const q = query.trim().toLowerCase();
    if (!q) return data.rows;
    return data.rows.filter((r) => {
      const hay = [
        r.orderNo, r.marchentContNo, r.commercialContNo, r.buyerCode, r.styleNo,
        r.country, r.marketCode, r.tod, r.itemDes,
      ].join(" ").toLowerCase();
      return hay.includes(q);
    });
  }, [data, query]);

  const downloadUrl = idsFromUrl
    ? `/api/sales-contract/summary?ids=${encodeURIComponent(idsFromUrl)}`
    : `/api/sales-contract/summary`;

  const totalQty = filtered.reduce((n, r) => n + (r.orderQty ?? 0), 0);
  const totalValue = filtered.reduce((n, r) => n + (r.contractValue ?? 0), 0);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Sales Contract Summary"
        subtitle={
          data
            ? `${data.totalRows} row${data.totalRows === 1 ? "" : "s"} across ${data.contractCount} contract${data.contractCount === 1 ? "" : "s"} — one PO per Order No. (dedup on).`
            : loading
              ? "Loading…"
              : ""
        }
        actions={
          <div className="flex items-center gap-2">
            <a href={downloadUrl} download className="btn-primary text-xs">⬇ Download .xlsx</a>
            <Link href="/sales-contract" className="btn-ghost text-xs">← Back to Sales Contracts</Link>
          </div>
        }
      />

      {error ? (
        <div className="card border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">{error}</div>
      ) : null}

      {loading && !data ? (
        <div className="card p-6 text-center text-sm text-slate-400">Loading summary…</div>
      ) : null}

      {data && !loading ? (
        <>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <div className="relative flex-1 min-w-[220px]">
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by Order No., contract, buyer, style, country, TOD…"
                className="w-full rounded-md border border-slate-200 bg-white px-3 py-1.5 text-xs placeholder:text-slate-400 focus:border-sky-400 focus:outline-none focus:ring-1 focus:ring-sky-200"
              />
            </div>
            <span className="text-[11px] text-slate-500">
              {filtered.length} of {data.totalRows} shown · {totalQty.toLocaleString()} pcs · {totalValue.toLocaleString(undefined, { maximumFractionDigits: 2 })} USD
            </span>
          </div>

          <div className="card overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-50">
                <tr>
                  <th className="th">#</th>
                  {COLS.map((c) => (
                    <th
                      key={c.header}
                      className={NUMERIC_HEADERS.has(c.header) ? "th text-right" : "th"}
                    >
                      {c.header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={COLS.length + 1} className="td text-center text-slate-400">
                      {data.totalRows === 0 ? "No READY POs in the selected contracts." : `No row matches "${query}".`}
                    </td>
                  </tr>
                ) : (
                  filtered.map((r, i) => (
                    <tr key={`${r.orderNo}-${i}`} className="border-t border-slate-50">
                      <td className="td text-slate-400">{i + 1}</td>
                      {COLS.map((c) => (
                        <td
                          key={c.header}
                          className={NUMERIC_HEADERS.has(c.header) ? "td text-right whitespace-nowrap" : "td whitespace-nowrap"}
                          title={c.render(r)}
                        >
                          {c.render(r)}
                        </td>
                      ))}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </div>
  );
}
