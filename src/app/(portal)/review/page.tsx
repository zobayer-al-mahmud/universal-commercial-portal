import Link from "next/link";
import { prisma } from "@/lib/db";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { PageHeader, StatusBadge, Empty } from "@/components/ui";
import { resolveReviewAction } from "@/app/actions/review";

export const dynamic = "force-dynamic";

export default async function ReviewPage() {
  const user = await getSessionUser();
  const canResolve = userHasPermission(user, PERMISSIONS.REVIEW_RESOLVE);
  const tickets = await prisma.reviewTicket.findMany({
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    take: 100,
    include: { job: true },
  });
  const open = tickets.filter((t) => t.status === "open");
  const closed = tickets.filter((t) => t.status !== "open");

  return (
    <div>
      <PageHeader
        title="Review Queue"
        subtitle="Exceptions that need a human decision. Resolve or reject each — every decision is recorded in the audit trail."
      />

      <h3 className="mb-2 text-sm font-semibold text-slate-700">Open ({open.length})</h3>
      {open.length === 0 ? (
        <Empty>No open review tickets. 🎉</Empty>
      ) : (
        <div className="space-y-3">
          {open.map((t) => (
            <div key={t.id} className="card p-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="badge bg-rose-100 text-rose-700">{t.reasonCode}</span>
                    <span className="text-xs text-slate-400">{t.module}</span>
                    <Link href={`/jobs/${t.jobId}`} className="font-mono text-xs text-ananta hover:underline">
                      job {t.jobId.slice(0, 8)}
                    </Link>
                    {t.job?.businessKey ? <span className="font-mono text-xs text-slate-400">{t.job.businessKey}</span> : null}
                  </div>
                  <p className="mt-1 text-sm text-slate-700">{t.reason}</p>
                </div>
                <StatusBadge status={t.status} />
              </div>
              {canResolve ? (
                <form action={resolveReviewAction} className="mt-3 flex flex-wrap items-center gap-2">
                  <input type="hidden" name="ticketId" value={t.id} />
                  <input name="note" className="input mt-0 flex-1" placeholder="Decision note (audited)…" />
                  <button name="decision" value="resolved" className="btn-primary text-xs">Resolve</button>
                  <button name="decision" value="rejected" className="btn-ghost text-xs">Reject</button>
                </form>
              ) : (
                <p className="mt-2 text-xs text-slate-400">You have read-only access to the review queue.</p>
              )}
            </div>
          ))}
        </div>
      )}

      {closed.length > 0 ? (
        <>
          <h3 className="mb-2 mt-8 text-sm font-semibold text-slate-700">Closed ({closed.length})</h3>
          <div className="card overflow-hidden">
            <table className="w-full">
              <thead className="bg-slate-50">
                <tr><th className="th">Reason</th><th className="th">Job</th><th className="th">Status</th><th className="th">Resolution</th></tr>
              </thead>
              <tbody>
                {closed.map((t) => (
                  <tr key={t.id} className="border-t border-slate-50">
                    <td className="td"><span className="badge bg-slate-100 text-slate-600">{t.reasonCode}</span></td>
                    <td className="td font-mono text-xs">
                      <Link href={`/jobs/${t.jobId}`} className="text-ananta hover:underline">{t.jobId.slice(0, 8)}</Link>
                    </td>
                    <td className="td"><StatusBadge status={t.status} /></td>
                    <td className="td text-xs text-slate-500">{t.resolution || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </div>
  );
}
