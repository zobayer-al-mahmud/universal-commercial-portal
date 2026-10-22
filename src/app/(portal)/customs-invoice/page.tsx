import Link from "next/link";
import { PageHeader, StatusBadge } from "@/components/ui";
import { listOrderNosWithPrefill } from "@/server/customs-invoice/pull-data";
import { listTemplates, resolveTemplate } from "@/server/customs-invoice/templates";
import { OrderNoCreateButton } from "@/components/CustomsInvoiceCreate";

export const dynamic = "force-dynamic";

export default async function CustomsInvoiceListPage() {
  const [rows, templates] = await Promise.all([
    listOrderNosWithPrefill(),
    Promise.resolve(listTemplates()),
  ]);

  const withInvoice = rows.filter((r) => r.hasInvoice).length;
  const withoutInvoice = rows.length - withInvoice;

  return (
    <div>
      <PageHeader
        title="Customs Invoice Generation"
        subtitle="One invoice per unique Order No, prefilled from Sales Contract + Shipment Schedule. Country code picks the template."
        actions={
          <div className="flex items-center gap-2">
            <Link href="/customs-invoice/templates" className="btn-ghost text-xs">🔎 Template health</Link>
            <StatusBadge status={templates.length === 0 ? "needs_review" : "active"} />
          </div>
        }
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <div className="card p-4">
          <div className="text-xs uppercase tracking-wide text-slate-500">Order Nos found</div>
          <div className="mt-1 text-2xl font-semibold">{rows.length}</div>
        </div>
        <div className="card p-4">
          <div className="text-xs uppercase tracking-wide text-slate-500">With invoice</div>
          <div className="mt-1 text-2xl font-semibold text-green-700">{withInvoice}</div>
        </div>
        <div className="card p-4">
          <div className="text-xs uppercase tracking-wide text-slate-500">Templates loaded</div>
          <div className="mt-1 text-2xl font-semibold">{templates.length}</div>
          <div className="text-[11px] text-slate-500">Country codes: {Array.from(new Set(templates.map((t) => t.countryCode))).slice(0, 20).join(", ")}{templates.length > 20 ? "…" : ""}</div>
        </div>
      </div>

      {templates.length === 0 ? (
        <div className="card mb-4 border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
          No country-wise invoice templates were found. Set <code>CUSTOMS_INVOICE_TEMPLATE_DIR</code> to the folder with the
          <code> &lt;invoiceNo&gt; &lt;countryCode&gt;.xlsx </code> files.
        </div>
      ) : null}

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
            {rows.length === 0 ? (
              <tr>
                <td colSpan={10} className="td text-center text-slate-400">
                  No Order Nos found yet. Upload a Sales Contract 3-PDF set or a Shipment Schedule booking confirmation.
                </td>
              </tr>
            ) : (
              rows.map((r, i) => {
                const template = resolveTemplate(r.marketCode, r.marketSubCode, templates);
                return (
                  <tr key={r.orderNo} className="border-t border-slate-50">
                    <td className="td text-slate-400">{i + 1}</td>
                    <td className="td font-mono">{r.orderNo}</td>
                    <td className="td">
                      {r.marketCode || <span className="text-slate-400">—</span>}
                      {r.marketSubCode && /^[A-Z0-9\-]{1,20}$/i.test(r.marketSubCode)
                        ? <span className="text-slate-400"> · {r.marketSubCode}</span>
                        : null}
                    </td>
                    <td className="td">
                      {template ? (
                        <>
                          <span className="font-mono text-slate-700">{template.countryCode}{template.variant ? ` (${template.variant})` : ""}</span>
                          <div className="text-[10px] text-slate-400">{template.filename}</div>
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
                        <Link href={`/customs-invoice/${r.invoiceId}`} className="btn-ghost text-[10px]">Open →</Link>
                      ) : (
                        <OrderNoCreateButton orderNo={r.orderNo} />
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
