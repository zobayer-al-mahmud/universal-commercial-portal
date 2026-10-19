import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { PageHeader, StatusBadge } from "@/components/ui";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { confirmContractAction } from "@/app/actions/handoffs";
import { RenameApply } from "@/components/RenameApply";

export const dynamic = "force-dynamic";

export default async function JobDetail({ params }: { params: { id: string } }) {
  const job = await prisma.job.findUnique({
    where: { id: params.id },
    include: {
      documents: true,
      stageEvents: { orderBy: { createdAt: "asc" } },
      poRows: { orderBy: { sl: "asc" } },
      contractRows: true,
      reviewTickets: true,
      renameItems: { orderBy: { createdAt: "asc" } },
      scheduleLines: { orderBy: { createdAt: "asc" } },
      customsInvoices: true,
      bookingCorrections: true,
    },
  });
  if (!job) notFound();

  const user = await getSessionUser();
  const openReviewCount = job.reviewTickets.filter((t) => t.status === "open").length;
  const canConfirm =
    job.module === "sales-contract" &&
    job.status === "draft" &&
    openReviewCount === 0 &&
    job.contractRows.length > 0 &&
    userHasPermission(user, PERMISSIONS.CONTRACT_APPROVE);

  return (
    <div>
      <PageHeader
        title={`Job ${job.id.slice(0, 8)}`}
        subtitle={`${job.module} · ${job.type} · key ${job.businessKey ?? "—"}`}
        actions={
          <div className="flex items-center gap-2">
            <StatusBadge status={job.status} />
            {canConfirm ? (
              <form action={confirmContractAction}>
                <input type="hidden" name="jobId" value={job.id} />
                <button className="btn-primary text-xs">Confirm for scheduling</button>
              </form>
            ) : null}
          </div>
        }
      />
      {job.module === "sales-contract" && job.status === "confirmed" ? (
        <div className="mb-4 rounded-md border border-green-200 bg-green-50 p-3 text-sm text-green-700">
          Contract confirmed. Its orders are available in the{" "}
          <Link href="/modules/shipment-schedule" className="font-medium underline">Shipment Schedule</Link> module.
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="card p-5">
          <h3 className="mb-3 text-sm font-semibold text-slate-700">Stage history (audit)</h3>
          <ol className="space-y-2">
            {job.stageEvents.map((e) => (
              <li key={e.id} className="flex items-start gap-3 text-sm">
                <StatusBadge status={e.status === "ok" ? "verified" : e.status === "failed" ? "failed" : "received"} />
                <div>
                  <div className="font-medium text-slate-700">{e.stage}</div>
                  <div className="text-xs text-slate-500">{e.message}</div>
                  <div className="text-[10px] text-slate-400">{e.createdAt.toISOString().replace("T", " ").slice(0, 19)}</div>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section className="card p-5">
          <h3 className="mb-3 text-sm font-semibold text-slate-700">Source documents</h3>
          {job.documents.map((d) => (
            <div key={d.id} className="mb-2 text-sm">
              <div className="font-medium text-slate-700">{d.originalName}</div>
              <div className="font-mono text-[10px] text-slate-400">sha256:{d.sha256.slice(0, 32)}…</div>
              <div className="text-xs text-slate-500">{d.kind} · {d.sizeBytes} bytes</div>
            </div>
          ))}
          {job.reviewTickets.length > 0 ? (
            <>
              <h3 className="mb-2 mt-4 text-sm font-semibold text-slate-700">Review tickets</h3>
              <ul className="space-y-1 text-sm">
                {job.reviewTickets.map((t) => (
                  <li key={t.id} className="flex items-center justify-between">
                    <span>
                      <span className="badge bg-rose-100 text-rose-700">{t.reasonCode}</span> {t.reason}
                    </span>
                    <StatusBadge status={t.status} />
                  </li>
                ))}
              </ul>
              <Link href="/review" className="btn-ghost mt-3 text-xs">Open review queue</Link>
            </>
          ) : null}
        </section>
      </div>

      {job.poRows.length > 0 ? (
        <section className="card mt-6 overflow-x-auto">
          <div className="border-b border-slate-100 px-4 py-3 text-sm font-semibold text-slate-700">PO EXTRACTION rows</div>
          <table className="w-full">
            <thead className="bg-slate-50">
              <tr>
                <th className="th">SL</th><th className="th">Order No</th><th className="th">Style</th>
                <th className="th">PM-A</th><th className="th">PM-B</th><th className="th">Qty</th>
                <th className="th">Price</th><th className="th">TOD</th><th className="th">OK</th><th className="th">Message</th>
              </tr>
            </thead>
            <tbody>
              {job.poRows.map((r) => (
                <tr key={r.id} className="border-t border-slate-50">
                  <td className="td">{r.sl}</td>
                  <td className="td font-mono text-xs">{r.orderNo}</td>
                  <td className="td">{r.productName ?? "—"}</td>
                  <td className="td">{r.planningMarketA ?? "—"}</td>
                  <td className="td">{r.planningMarketB ?? "—"}</td>
                  <td className="td">{r.quantity ?? "—"}</td>
                  <td className="td">{r.invoiceAveragePrice ?? "—"}</td>
                  <td className="td text-xs">{r.timeOfDelivery ?? "—"}</td>
                  <td className="td">{r.success ? "✓" : "✗"}</td>
                  <td className="td text-xs text-rose-600">{r.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      {job.renameItems.length > 0 ? (
        <section className="card mt-6 overflow-x-auto">
          <div className="border-b border-slate-100 px-4 py-3 text-sm font-semibold text-slate-700">
            Rename plan ({job.renameItems.length} files · {job.renameItems.filter((r) => r.applied).length} applied · originals preserved)
          </div>
          <div className="border-b border-slate-100 bg-slate-50">
            <RenameApply jobId={job.id} canApply={userHasPermission(user, PERMISSIONS.RENAME_APPLY)} />
          </div>
          <table className="w-full">
            <thead className="bg-slate-50">
              <tr>
                <th className="th">Original</th><th className="th">→ Target</th>
                <th className="th">Invoice key</th><th className="th">Status</th><th className="th">Note</th>
              </tr>
            </thead>
            <tbody>
              {job.renameItems.map((r) => (
                <tr key={r.id} className="border-t border-slate-50">
                  <td className="td font-mono text-xs">{r.originalName}</td>
                  <td className="td font-mono text-xs">{r.targetName ?? "—"}</td>
                  <td className="td font-mono text-xs">{r.businessKey ?? "—"}</td>
                  <td className="td">
                    <span className={`badge ${
                      r.status === "planned" ? "bg-green-100 text-green-800"
                      : r.status === "collision" ? "bg-rose-100 text-rose-800"
                      : r.status === "needs_review" ? "bg-amber-100 text-amber-800"
                      : "bg-slate-100 text-slate-600"}`}>{r.status}</span>
                  </td>
                  <td className="td text-xs text-slate-500">{r.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      {job.scheduleLines.length > 0 ? (
        <section className="card mt-6 overflow-x-auto">
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
            <span className="text-sm font-semibold text-slate-700">
              Week {job.scheduleLines[0].weekNo} schedule ({job.scheduleLines.length} lines · cut-offs {job.scheduleLines[0].firstCutOff} / {job.scheduleLines[0].secondCutOff})
            </span>
            <a href={`/api/export/schedule/${job.id}`} className="btn-ghost text-xs">⬇ Download .xlsx</a>
          </div>
          <table className="w-full">
            <thead className="bg-slate-50">
              <tr>
                <th className="th">Buyer</th><th className="th">Order No</th><th className="th">Style</th>
                <th className="th">PCS</th><th className="th">FOB</th><th className="th">Value</th>
                <th className="th">Market</th><th className="th">Invoice</th><th className="th">Cut-off</th><th className="th">OK</th>
              </tr>
            </thead>
            <tbody>
              {job.scheduleLines.map((l) => (
                <tr key={l.id} className="border-t border-slate-50">
                  <td className="td text-xs">{l.buyerCode}</td>
                  <td className="td font-mono text-xs">{l.orderNo}</td>
                  <td className="td text-xs">{l.style}</td>
                  <td className="td">{l.pcs}</td>
                  <td className="td">{l.fob}</td>
                  <td className="td">{l.value}</td>
                  <td className="td font-mono text-xs">{l.marketCode}</td>
                  <td className="td font-mono text-xs">{l.invoiceNo || "—"}</td>
                  <td className="td text-xs">{l.cutOff}</td>
                  <td className="td">{l.success ? "✓" : "✗"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      {job.customsInvoices.map((inv) => {
        let items: { description: string; hsCode: string; quantity: number; unitPrice: number; amount: number }[] = [];
        try { items = JSON.parse(inv.lineItemsJson); } catch { /* ignore */ }
        return (
          <section key={inv.id} className="card mt-6 p-5">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-700">Customs Invoice {inv.invoiceKey}</h3>
              <div className="flex items-center gap-2">
                <a href={`/api/export/customs-invoice/${job.id}`} className="btn-ghost text-xs">⬇ Download .xlsx</a>
                <span className="badge bg-amber-100 text-amber-800">draft document</span>
              </div>
            </div>
            <div className="grid gap-3 text-xs sm:grid-cols-2 lg:grid-cols-3">
              <div><div className="font-medium text-slate-500">Exporter</div>{inv.exporterName}</div>
              <div><div className="font-medium text-slate-500">Buyer</div>{inv.buyerName}</div>
              <div><div className="font-medium text-slate-500">Cargo delivery ({inv.marketCode})</div>{inv.cargoDeliveryName || "— (pending, see review)"}</div>
              <div><div className="font-medium text-slate-500">Contract No. / Date</div>{inv.contractNo} · {inv.contractDate}</div>
              <div><div className="font-medium text-slate-500">H&M Order No.</div>{inv.hmOrderNo}</div>
              <div><div className="font-medium text-slate-500">Exp No. / Date</div>{inv.expNo} · {inv.expDate}</div>
              <div><div className="font-medium text-slate-500">Invoice Date</div>{inv.invoiceDate}</div>
              <div><div className="font-medium text-slate-500">Port of Loading → Delivery</div>{inv.portOfLoading} → {inv.portOfDelivery}</div>
              <div><div className="font-medium text-slate-500">Origin → Destination</div>{inv.countryOfOrigin} → {inv.countryOfFinalDestination}</div>
            </div>
            <table className="mt-4 w-full">
              <thead className="bg-slate-50">
                <tr><th className="th">Description</th><th className="th">HS Code</th><th className="th">Qty</th><th className="th">Unit Price</th><th className="th">Amount</th></tr>
              </thead>
              <tbody>
                {items.map((li, i) => (
                  <tr key={i} className="border-t border-slate-50">
                    <td className="td">{li.description}</td>
                    <td className="td font-mono text-xs">{li.hsCode}</td>
                    <td className="td">{li.quantity}</td>
                    <td className="td">{li.unitPrice}</td>
                    <td className="td">{li.amount}</td>
                  </tr>
                ))}
                <tr className="border-t border-slate-200 font-semibold">
                  <td className="td" colSpan={2}>Total</td>
                  <td className="td">{inv.totalQty}</td>
                  <td className="td"></td>
                  <td className="td">{inv.currency} {inv.totalValue}</td>
                </tr>
              </tbody>
            </table>
          </section>
        );
      })}

      {job.bookingCorrections.map((bc) => {
        let changes: { field: string; label: string; oldValue: string; newValue: string; allowed: boolean }[] = [];
        try { changes = JSON.parse(bc.changesJson); } catch { /* ignore */ }
        return (
          <section key={bc.id} className="card mt-6 p-5">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-700">Booking correction {bc.bookingKey}</h3>
              <span className={`badge ${bc.damcoVerified ? "bg-green-100 text-green-800" : "bg-slate-100 text-slate-600"}`}>
                Damco {bc.damcoVerified ? "verified (mock)" : "not verified"}
              </span>
            </div>
            <p className="mb-3 text-xs text-slate-500">
              SO {bc.soNumber || "—"} · {bc.allowedCount} allowed / {bc.disallowedCount} disallowed · {bc.damcoMessage}
            </p>
            {changes.length === 0 ? (
              <p className="text-sm text-slate-400">No field changes between the two bookings.</p>
            ) : (
              <table className="w-full">
                <thead className="bg-slate-50">
                  <tr><th className="th">Field</th><th className="th">Original</th><th className="th">Corrected</th><th className="th">Classification</th></tr>
                </thead>
                <tbody>
                  {changes.map((c, i) => (
                    <tr key={i} className="border-t border-slate-50">
                      <td className="td">{c.label}</td>
                      <td className="td font-mono text-xs text-slate-500">{c.oldValue || "∅"}</td>
                      <td className="td font-mono text-xs">{c.newValue || "∅"}</td>
                      <td className="td">
                        <span className={`badge ${c.allowed ? "bg-amber-100 text-amber-800" : "bg-rose-100 text-rose-800"}`}>
                          {c.allowed ? "allowed · needs approval" : "locked · disallowed"}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        );
      })}

      {job.contractRows.length > 0 ? (
        <section className="card mt-6 overflow-x-auto">
          <div className="border-b border-slate-100 px-4 py-3 text-sm font-semibold text-slate-700">Sales Contract rows (draft)</div>
          <table className="w-full">
            <thead className="bg-slate-50">
              <tr>
                <th className="th">Order No</th><th className="th">Style</th><th className="th">Description</th>
                <th className="th">Order Qty</th><th className="th">Unit Price</th><th className="th">Value</th>
                <th className="th">TOD</th><th className="th">Commercial Ref</th><th className="th">Rev</th>
              </tr>
            </thead>
            <tbody>
              {job.contractRows.map((r) => (
                <tr key={r.id} className="border-t border-slate-50">
                  <td className="td font-mono text-xs">{r.orderNo}</td>
                  <td className="td">{r.styleNo}</td>
                  <td className="td text-xs">{r.description}</td>
                  <td className="td">{r.orderQty}</td>
                  <td className="td">{r.unitPrice}</td>
                  <td className="td">{r.value}</td>
                  <td className="td text-xs">{r.timeOfDelivery}</td>
                  <td className="td font-mono text-xs">{r.commercialContRef}</td>
                  <td className="td">{r.revision}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
    </div>
  );
}
