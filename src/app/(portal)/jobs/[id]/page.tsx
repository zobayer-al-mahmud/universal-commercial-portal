import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { PageHeader, StatusBadge } from "@/components/ui";

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
    },
  });
  if (!job) notFound();

  return (
    <div>
      <PageHeader
        title={`Job ${job.id.slice(0, 8)}`}
        subtitle={`${job.module} · ${job.type} · key ${job.businessKey ?? "—"}`}
        actions={<StatusBadge status={job.status} />}
      />

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
