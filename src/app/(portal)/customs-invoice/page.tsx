import Link from "next/link";
import { PageHeader, StatusBadge } from "@/components/ui";
import { listInvoiceReadyRows } from "@/server/customs-invoice/invoice-ready";
import { listTemplates, resolveTemplate } from "@/server/customs-invoice/templates";
import { CustomsInvoiceBulkUpload } from "@/components/CustomsInvoiceBulkUpload";
import {
  CustomsInvoiceReadyTable,
  type InvoiceReadyListRow,
} from "@/components/CustomsInvoiceReadyTable";

export const dynamic = "force-dynamic";

export default async function CustomsInvoiceListPage() {
  const [rows, templates] = await Promise.all([
    listInvoiceReadyRows(),
    Promise.resolve(listTemplates()),
  ]);

  const withInvoice = rows.filter((r) => r.hasInvoice).length;

  // Resolve the per-row template on the server by (country, country+sub).
  const listRows: InvoiceReadyListRow[] = rows.map((r) => {
    const t = resolveTemplate(r.countryCode, r.countrySubCode, templates);
    return {
      invoiceNo: r.invoiceNo,
      rowId: r.rowId,
      orderNo: r.orderNo,
      countryCode: r.countryCode,
      countrySubCode: r.countrySubCode,
      contractNo: r.contractNo,
      buyerCode: r.buyerCode,
      styleNo: r.styleNo,
      quantityPcs: r.quantityPcs,
      unitPrice: r.unitPrice,
      bcn: r.bcn,
      bookingRef: r.bookingRef,
      bookingStatus: r.bookingStatus,
      grossWeightKg: r.grossWeightKg,
      totalCartons: r.totalCartons,
      weekNo: r.weekNo,
      hasInvoice: r.hasInvoice,
      invoiceId: r.invoiceId,
      templateCode: t?.countryCode ?? null,
      templateVariant: t?.variant ?? null,
      templateFilename: t?.filename ?? null,
    };
  });

  return (
    <div>
      <PageHeader
        title="Customs Invoice Generation"
        subtitle="One invoice per Invoice No. Rows appear here once their booking PDF is uploaded AND an invoice number is allocated. All invoice fields pull from the Shipment Schedule row; anything the PDFs don't carry is left blank for manual entry."
        actions={
          <div className="flex items-center gap-2">
            <Link href="/customs-invoice/templates" className="btn-ghost text-xs">🔎 Template health</Link>
            <StatusBadge status={templates.length === 0 ? "needs_review" : "active"} />
          </div>
        }
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <div className="card p-4">
          <div className="text-xs uppercase tracking-wide text-slate-500">Invoice-ready rows</div>
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

      <div className="mb-4">
        <CustomsInvoiceBulkUpload />
      </div>

      <CustomsInvoiceReadyTable rows={listRows} />
    </div>
  );
}
