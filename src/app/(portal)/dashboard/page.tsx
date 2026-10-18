import Link from "next/link";
import { prisma } from "@/lib/db";
import { PageHeader, Stat, StatusBadge } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const [jobs, openReviews, drafts, queued, verified, contractRows, modules, recent] = await Promise.all([
    prisma.job.count(),
    prisma.reviewTicket.count({ where: { status: "open" } }),
    prisma.job.count({ where: { status: "draft" } }),
    prisma.job.count({ where: { status: "queued" } }),
    prisma.job.count({ where: { status: { in: ["verified", "submitted"] } } }),
    prisma.salesContractRow.count(),
    prisma.module.findMany({ orderBy: { sortOrder: "asc" } }),
    prisma.job.findMany({ orderBy: { createdAt: "desc" }, take: 8 }),
  ]);

  return (
    <div>
      <PageHeader
        title="Dashboard"
        subtitle="Live operational status across all commercial automation modules. All counts are computed from persisted data — no placeholder metrics."
      />

      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
        <Stat label="Total Jobs" value={jobs} href="/jobs" />
        <Stat label="Open Reviews" value={openReviews} href="/review" tone={openReviews ? "text-rose-600" : "text-slate-800"} />
        <Stat label="Drafts" value={drafts} href="/jobs?status=draft" tone="text-amber-600" />
        <Stat label="Queued" value={queued} href="/jobs?status=queued" tone="text-rose-600" />
        <Stat label="Verified" value={verified} tone="text-green-600" />
        <Stat label="Contract Rows" value={contractRows} />
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        <div className="card">
          <div className="border-b border-slate-100 px-4 py-3 text-sm font-semibold text-slate-700">Modules</div>
          <table className="w-full">
            <tbody>
              {modules.map((m) => (
                <tr key={m.key} className="border-b border-slate-50 last:border-0">
                  <td className="td">
                    <Link href={`/modules/${m.key}`} className="font-medium text-ananta hover:underline">
                      {m.name}
                    </Link>
                  </td>
                  <td className="td text-right">
                    <StatusBadge status={m.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="card">
          <div className="border-b border-slate-100 px-4 py-3 text-sm font-semibold text-slate-700">Recent Jobs</div>
          {recent.length === 0 ? (
            <div className="p-6 text-center text-sm text-slate-400">
              No jobs yet. Start with the{" "}
              <Link href="/modules/sales-contract" className="text-ananta hover:underline">
                Sales Contract intake
              </Link>
              .
            </div>
          ) : (
            <table className="w-full">
              <thead>
                <tr>
                  <th className="th">Job</th>
                  <th className="th">Module</th>
                  <th className="th">Key</th>
                  <th className="th">Status</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((j) => (
                  <tr key={j.id} className="border-t border-slate-50">
                    <td className="td">
                      <Link href={`/jobs/${j.id}`} className="font-mono text-xs text-ananta hover:underline">
                        {j.id.slice(0, 8)}
                      </Link>
                    </td>
                    <td className="td">{j.module}</td>
                    <td className="td font-mono text-xs">{j.businessKey ?? "—"}</td>
                    <td className="td"><StatusBadge status={j.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
