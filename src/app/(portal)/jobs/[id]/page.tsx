import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { PageHeader, StatusBadge } from "@/components/ui";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { RenameApply } from "@/components/RenameApply";

export const dynamic = "force-dynamic";

export default async function JobDetail({ params }: { params: { id: string } }) {
  const job = await prisma.job.findUnique({
    where: { id: params.id },
    include: {
      documents: true,
      stageEvents: { orderBy: { createdAt: "asc" } },
      reviewTickets: true,
      renameItems: { orderBy: { createdAt: "asc" } },
      bookingCorrections: true,
    },
  });
  if (!job) notFound();

  const user = await getSessionUser();
  // Sales Contract confirmation moved to the dedicated /sales-contract flow
  // on 2026-10-26; this generic job view no longer carries that action.

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

    </div>
  );
}
