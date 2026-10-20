import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { PageHeader, StatusBadge, Empty } from "@/components/ui";
import { MODULE_CATALOG } from "@/server/modules/catalog";
import { IntakeForm } from "@/components/IntakeForm";
import { RenameForm } from "@/components/RenameForm";
import { ScheduleForm } from "@/components/ScheduleForm";
import { CustomsInvoiceForm } from "@/components/CustomsInvoiceForm";
import { BookingCorrectionForm } from "@/components/BookingCorrectionForm";
import { BookingBatchUpload } from "@/components/BookingBatchUpload";
import { SalesContractBatchUpload } from "@/components/SalesContractBatchUpload";
import { ScheduleFromContracts } from "@/components/ScheduleFromContracts";
import { listSchedulableContracts, listInvoiceableScheduleLines } from "@/server/handoffs/service";
import { generateInvoiceFromLineAction } from "@/app/actions/handoffs";

export const dynamic = "force-dynamic";

export default async function ModulePage({ params }: { params: { key: string } }) {
  const module = await prisma.module.findUnique({ where: { key: params.key } });
  if (!module) notFound();
  const cat = MODULE_CATALOG[module.key];

  const jobs = await prisma.job.findMany({
    where: { module: module.key },
    orderBy: { createdAt: "desc" },
    take: 10,
  });

  return (
    <div>
      <PageHeader
        title={module.name}
        subtitle={module.description}
        actions={<StatusBadge status={module.status} />}
      />

      {cat ? (
        <div className="mb-6 grid gap-4 lg:grid-cols-2">
          <div className="card p-5">
            <h3 className="mb-2 text-sm font-semibold text-slate-700">Source-backed scope</h3>
            <p className="mb-3 text-xs text-slate-400">{cat.sources}</p>
            <ul className="ml-4 list-disc space-y-1 text-sm text-slate-600">
              {cat.scope.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          </div>
          <div className="card p-5">
            <h3 className="mb-2 text-sm font-semibold text-slate-700">Open questions / decisions</h3>
            <ul className="ml-4 list-disc space-y-1 text-sm text-slate-600">
              {cat.openQuestions.map((q, i) => (
                <li key={i}>{q}</li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-slate-400">
              See <Link href="/admin" className="text-ananta hover:underline">Administration → Integrations</Link> for adapter status and the decision register in <code>docs/source-analysis/BUSINESS_DECISIONS_REQUIRED.md</code>.
            </p>
          </div>
        </div>
      ) : null}

      {module.key === "sales-contract" ? (
        <>
          <div className="mb-6">
            <h3 className="mb-1 text-sm font-semibold text-slate-700">① Bulk PDF upload (multiple POs)</h3>
            <p className="mb-3 text-xs text-slate-400">
              Upload many H&amp;M PO / supporting PDFs in one operation → each is extracted, cross-matched against existing
              contracts and classified (existing / new / duplicate / amendment / review) in a unified row-based table.
              Verified existing contracts are reused; unresolved numbering / Buyer-Code rules block new-contract creation.
            </p>
            <SalesContractBatchUpload />
          </div>
          {await (async () => {
            const batches = await prisma.salesContractBatch.findMany({ orderBy: { createdAt: "desc" }, take: 8 });
            if (batches.length === 0) return null;
            return (
              <div className="mb-6">
                <h3 className="mb-3 text-sm font-semibold text-slate-700">Recent batches</h3>
                <div className="card overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-slate-50">
                      <tr><th className="th">Batch</th><th className="th">Files</th><th className="th">Drafted</th><th className="th">Review</th><th className="th">Blocked</th><th className="th">Failed</th><th className="th">Status</th><th className="th">Created</th></tr>
                    </thead>
                    <tbody>
                      {batches.map((b) => (
                        <tr key={b.id} className="border-t border-slate-50">
                          <td className="td font-mono"><Link href={`/sales-contract/${b.id}`} className="text-ananta hover:underline">{b.id.slice(0, 8)}</Link></td>
                          <td className="td">{b.totalItems}</td>
                          <td className="td text-green-700">{b.draftedItems}</td>
                          <td className="td text-amber-700">{b.reviewItems}</td>
                          <td className="td text-amber-700">{b.blockedItems}</td>
                          <td className="td text-rose-700">{b.failedItems}</td>
                          <td className="td"><StatusBadge status={b.status} /></td>
                          <td className="td text-slate-400">{b.createdAt.toISOString().slice(0, 16).replace("T", " ")}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })()}
          <div className="mb-6">
            <h3 className="mb-3 text-sm font-semibold text-slate-700">② Or intake a single Order Package (subject + PO text)</h3>
            <IntakeForm />
          </div>
        </>
      ) : null}

      {module.key === "pdf-rename" ? (
        <div className="mb-6">
          <h3 className="mb-3 text-sm font-semibold text-slate-700">Rename plan from extraction CSV</h3>
          <RenameForm />
        </div>
      ) : null}

      {module.key === "shipment-schedule" ? (
        <>
          <div className="mb-6">
            <h3 className="mb-1 text-sm font-semibold text-slate-700">① From confirmed Sales Contracts</h3>
            <p className="mb-3 text-xs text-slate-400">Handoff 1: schedule orders drawn from confirmed contract rows (markets from PO extraction).</p>
            <ScheduleFromContracts contracts={await listSchedulableContracts()} />
          </div>
          <div className="mb-6">
            <h3 className="mb-3 text-sm font-semibold text-slate-700">Or build week schedule from a pasted orders CSV</h3>
            <ScheduleForm />
          </div>
        </>
      ) : null}

      {module.key === "customs-invoice" ? (
        <>
          <div className="mb-6">
            <h3 className="mb-1 text-sm font-semibold text-slate-700">① From shipment schedule lines</h3>
            <p className="mb-3 text-xs text-slate-400">Handoff 2: generate an invoice from a schedule line&apos;s allocated invoice number.</p>
            {await (async () => {
              const lines = await listInvoiceableScheduleLines();
              if (lines.length === 0)
                return <div className="card p-4 text-sm text-slate-400">No invoiceable schedule lines yet. Build a schedule (from confirmed contracts) first.</div>;
              return (
                <div className="card overflow-x-auto">
                  <table className="w-full">
                    <thead className="bg-slate-50">
                      <tr><th className="th">Invoice No</th><th className="th">Market</th><th className="th">Order</th><th className="th">Style</th><th className="th">PCS</th><th className="th">FOB</th><th className="th">Contract</th><th className="th"></th></tr>
                    </thead>
                    <tbody>
                      {lines.map((l) => (
                        <tr key={l.id} className="border-t border-slate-50">
                          <td className="td font-mono text-xs">{l.invoiceNo}</td>
                          <td className="td font-mono text-xs">{l.marketCode}</td>
                          <td className="td font-mono text-xs">{l.orderNo}</td>
                          <td className="td text-xs">{l.style}</td>
                          <td className="td">{l.pcs}</td>
                          <td className="td">{l.fob}</td>
                          <td className="td font-mono text-xs">{l.contractNo}</td>
                          <td className="td">
                            <form action={generateInvoiceFromLineAction}>
                              <input type="hidden" name="lineId" value={l.id} />
                              <button className="btn-ghost text-xs">Generate invoice</button>
                            </form>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              );
            })()}
          </div>
          <div className="mb-6">
            <h3 className="mb-3 text-sm font-semibold text-slate-700">Or generate a customs invoice manually</h3>
            <CustomsInvoiceForm />
          </div>
        </>
      ) : null}

      {module.key === "booking-correction" ? (
        <>
          <div className="mb-6">
            <h3 className="mb-1 text-sm font-semibold text-slate-700">① Batch booking correction (Damco workflow)</h3>
            <p className="mb-3 text-xs text-slate-400">
              Upload packing-list PDFs → extract Gross Weight / Cartons / Quantity + PO &amp; country → search the Damco
              Shipper Portal → match the three values → validate the CONFIRMED status → return verified PDFs. Live portal
              actions are gated; a REQUESTED booking is never reported as confirmed.
            </p>
            <BookingBatchUpload />
          </div>
          {await (async () => {
            const batches = await prisma.bookingBatch.findMany({ orderBy: { createdAt: "desc" }, take: 8 });
            if (batches.length === 0) return null;
            return (
              <div className="mb-6">
                <h3 className="mb-3 text-sm font-semibold text-slate-700">Recent batches</h3>
                <div className="card overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-slate-50">
                      <tr><th className="th">Batch</th><th className="th">Docs</th><th className="th">Done</th><th className="th">Review</th><th className="th">Failed</th><th className="th">Mode</th><th className="th">Status</th><th className="th">Created</th></tr>
                    </thead>
                    <tbody>
                      {batches.map((b) => (
                        <tr key={b.id} className="border-t border-slate-50">
                          <td className="td font-mono"><Link href={`/booking/${b.id}`} className="text-ananta hover:underline">{b.id.slice(0, 8)}</Link></td>
                          <td className="td">{b.totalDocs}</td>
                          <td className="td text-green-700">{b.completedDocs}</td>
                          <td className="td text-amber-700">{b.reviewDocs}</td>
                          <td className="td text-rose-700">{b.failedDocs}</td>
                          <td className="td">{b.damcoMode}</td>
                          <td className="td"><StatusBadge status={b.status} /></td>
                          <td className="td text-slate-400">{b.createdAt.toISOString().slice(0, 16).replace("T", " ")}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })()}
          <div className="mb-6">
            <h3 className="mb-3 text-sm font-semibold text-slate-700">② Compare original vs corrected booking (field-level diff)</h3>
            <BookingCorrectionForm />
          </div>
        </>
      ) : null}

      {module.status === "blocked" ? (
        <div className="mb-6 rounded-md border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
          This module is <strong>blocked</strong>: the source folder contained no files. Portal
          credentials in the checklist are intentionally excluded from the repository. Provide field
          lists / screenshots and authorised, least-privilege service credentials to proceed. No
          live portal action is implemented.
        </div>
      ) : null}

      <div className="card">
        <div className="border-b border-slate-100 px-4 py-3 text-sm font-semibold text-slate-700">
          Recent jobs ({module.name})
        </div>
        {jobs.length === 0 ? (
          <div className="p-6">
            <Empty>No jobs recorded for this module yet.</Empty>
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">Job</th>
                <th className="th">Key</th>
                <th className="th">Status</th>
                <th className="th">Created</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id} className="border-t border-slate-50">
                  <td className="td">
                    <Link href={`/jobs/${j.id}`} className="font-mono text-xs text-ananta hover:underline">
                      {j.id.slice(0, 8)}
                    </Link>
                  </td>
                  <td className="td font-mono text-xs">{j.businessKey ?? "—"}</td>
                  <td className="td"><StatusBadge status={j.status} /></td>
                  <td className="td text-xs text-slate-400">{j.createdAt.toISOString().slice(0, 16).replace("T", " ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
