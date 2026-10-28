import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { PageHeader, StatusBadge } from "@/components/ui";
import { listTemplates, resolveTemplate } from "@/server/customs-invoice/templates";
import { CustomsInvoiceEditor } from "@/components/CustomsInvoiceEditor";
import { CustomsInvoicePdfUpload } from "@/components/CustomsInvoicePdfUpload";
import { CustomsInvoiceRefill } from "@/components/CustomsInvoiceRefill";
import { buildPrefill, preferredCountryCode } from "@/server/customs-invoice/pull-data";
import { updateInvoiceFields } from "@/server/customs-invoice/intake";
import type { InvoiceFields } from "@/server/customs-invoice/types";

export const dynamic = "force-dynamic";

export default async function CustomsInvoiceDetail({ params }: { params: { id: string } }) {
  let inv = await prisma.customsInvoice.findUnique({
    where: { id: params.id },
    include: {
      pdfs: { orderBy: { uploadedAt: "desc" } },
      edits: { orderBy: { editedAt: "desc" }, take: 50 },
    },
  });
  if (!inv) notFound();

  // Auto-sync from the ONE shipment row this invoice tracks (user flow:
  // "first invoice no + order no → shipment schedule row → country code →
  // template"). Mechanical fields (marketCode / marketSubCode / countryCode)
  // ALWAYS re-sync, since they are derived deterministically from the row and
  // the user never types them. Headline fields (invoiceNumber / invoiceDate)
  // are backfilled only when the invoice has them blank — user-typed values
  // stay sticky. Guarantee: opening any invoice shows the SAME country code
  // as the list, and the template resolves to EXACTLY that country.
  //
  // Resolution priority for the shipment row:
  //   1. The row whose invoiceNo equals this invoice's stored number
  //      (invoice numbers are globally unique per week — 1:1 link).
  //   2. Fallback: the first shipment row for this invoice's Order No via
  //      buildPrefill (used when the invoice has not yet been numbered —
  //      buildPrefill now prefers rows that DO carry an invoiceNo + PDF).
  const templates = listTemplates();
  let srcMarketCode = "";
  let srcMarketSubCode = "";
  let srcInvoiceNo = "";
  let srcExpectedDelivery = "";
  if (inv.invoiceNumber) {
    const row = await prisma.shipmentScheduleRow.findFirst({
      where: { invoiceNo: inv.invoiceNumber },
      select: { marketCode: true, marketSubCode: true, invoiceNo: true, expectedDelivery: true },
    });
    if (row) {
      srcMarketCode = preferredCountryCode(row);
      srcMarketSubCode = row.marketSubCode;
      srcInvoiceNo = row.invoiceNo;
      srcExpectedDelivery = row.expectedDelivery;
    }
  }
  if (!srcMarketCode) {
    const prefill = await buildPrefill(inv.orderNo);
    if (prefill) {
      srcMarketCode = prefill.marketCode;
      srcMarketSubCode = prefill.marketSubCode;
      srcInvoiceNo = prefill.invoiceNo;
      srcExpectedDelivery = prefill.expectedDelivery;
    }
  }
  if (srcMarketCode) {
    const resolved = resolveTemplate(srcMarketCode, srcMarketSubCode, templates);
    const nextCountryCode = resolved?.countryCode ?? srcMarketCode;
    const patch: Partial<InvoiceFields> = {};
    if (srcMarketCode !== inv.marketCode) patch.marketCode = srcMarketCode;
    if (srcMarketSubCode !== inv.marketSubCode) patch.marketSubCode = srcMarketSubCode;
    if (nextCountryCode !== inv.countryCode) patch.countryCode = nextCountryCode;
    // Backfill the headline fields on first visit — never overwrite values
    // the user already typed.
    if (!inv.invoiceNumber && srcInvoiceNo) patch.invoiceNumber = srcInvoiceNo;
    if (!inv.invoiceDate && srcExpectedDelivery) patch.invoiceDate = srcExpectedDelivery;
    if (Object.keys(patch).length > 0) {
      await updateInvoiceFields(inv.id, patch, { actor: "system", source: "prefill" });
      // Re-read so this render shows the corrected values, not the stale ones.
      inv = await prisma.customsInvoice.findUnique({
        where: { id: params.id },
        include: {
          pdfs: { orderBy: { uploadedAt: "desc" } },
          edits: { orderBy: { editedAt: "desc" }, take: 50 },
        },
      });
      if (!inv) notFound();
    }
  }

  const template = resolveTemplate(inv.marketCode, inv.marketSubCode || inv.countryCode, templates);
  const fields: InvoiceFields = {
    invoiceNumber: inv.invoiceNumber,
    invoiceDate: inv.invoiceDate,
    contractNo: inv.contractNo,
    contractDate: inv.contractDate,
    hmOrderNo: inv.hmOrderNo,
    marketCode: inv.marketCode,
    marketSubCode: inv.marketSubCode,
    countryCode: inv.countryCode,
    expNo: inv.expNo,
    expDate: inv.expDate,
    portOfLoading: inv.portOfLoading,
    portOfDischarge: inv.portOfDischarge,
    placeOfDelivery: inv.placeOfDelivery,
    countryOfOrigin: inv.countryOfOrigin,
    countryOfFinalDestination: inv.countryOfFinalDestination,
    transportMode: inv.transportMode,
    termsOfDelivery: inv.termsOfDelivery,
    termsOfPayment: inv.termsOfPayment,
    vesselName: inv.vesselName,
    voyageNo: inv.voyageNo,
    sailingDate: inv.sailingDate,
    currency: inv.currency,
    exporterName: inv.exporterName,
    buyerName: inv.buyerName,
    consigneeName: inv.consigneeName,
    cargoDeliveryName: inv.cargoDeliveryName,
    issuingBank: inv.issuingBank,
    descriptionOfGoods: inv.descriptionOfGoods,
    styleNo: inv.styleNo,
    buyerCode: inv.buyerCode,
    hsCode: inv.hsCode,
    category: inv.category,
    quantityPcs: inv.quantityPcs,
    unitPrice: inv.unitPrice,
    totalCartons: inv.totalCartons,
    grossWeightKg: inv.grossWeightKg,
    netWeightKg: inv.netWeightKg,
    measurementCbm: inv.measurementCbm,
    dimension: inv.dimension,
    packSet: inv.packSet,
  };

  return (
    <div>
      <PageHeader
        title={`Customs Invoice — Order ${inv.orderNo}`}
        subtitle={`Country code ${inv.marketCode || "—"}${inv.marketSubCode ? ` · sub ${inv.marketSubCode}` : ""} → template ${template?.filename ?? "(none)"}`}
        actions={
          <div className="flex items-center gap-2">
            <StatusBadge status={inv.status} />
            <CustomsInvoiceRefill invoiceId={inv.id} />
            <Link href={`/api/customs-invoice/${inv.id}/download`} className="btn-primary text-xs">⬇ Download .xlsx</Link>
            <Link href="/customs-invoice" className="btn-ghost text-xs">← Back</Link>
          </div>
        }
      />

      {!template ? (
        <div className="card mb-4 border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
          No template matched country code <code>{inv.marketCode || "—"}</code>{inv.marketSubCode ? <> / sub <code>{inv.marketSubCode}</code></> : null}.
          Download will produce a plain fresh workbook until a template is added or the country code is corrected below.
        </div>
      ) : null}

      <div className="mb-4">
        <CustomsInvoicePdfUpload invoiceId={inv.id} pdfs={inv.pdfs.map((p) => ({ id: p.id, originalName: p.originalName, sizeBytes: p.sizeBytes, uploadedAt: p.uploadedAt.toISOString() }))} />
      </div>

      <CustomsInvoiceEditor invoiceId={inv.id} initial={fields} />

      {inv.edits.length ? (
        <section className="card mt-6 p-5">
          <h3 className="mb-3 text-sm font-semibold text-slate-700">Edit history (append-only)</h3>
          <table className="w-full text-xs">
            <thead className="bg-slate-50">
              <tr><th className="th">When</th><th className="th">Who</th><th className="th">Source</th><th className="th">Field</th><th className="th">Old</th><th className="th">New</th></tr>
            </thead>
            <tbody>
              {inv.edits.map((e) => (
                <tr key={e.id} className="border-t border-slate-50">
                  <td className="td text-slate-400">{e.editedAt.toISOString().slice(0, 16).replace("T", " ")}</td>
                  <td className="td text-slate-500">{e.editedBy}</td>
                  <td className="td">
                    <span className={`badge ${e.source === "pdf-extract" ? "bg-sky-100 text-sky-800" : e.source === "prefill" ? "bg-amber-100 text-amber-800" : "bg-slate-100 text-slate-700"}`}>{e.source}</span>
                  </td>
                  <td className="td font-mono">{e.field}</td>
                  <td className="td font-mono text-xs text-slate-500">{e.oldValue || "∅"}</td>
                  <td className="td font-mono text-xs">{e.newValue || "∅"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
    </div>
  );
}
