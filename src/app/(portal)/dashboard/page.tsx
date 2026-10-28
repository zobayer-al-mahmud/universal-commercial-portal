import Link from "next/link";
import { prisma } from "@/lib/db";
import { PageHeader, Stat, StatusBadge, Panel } from "@/components/ui";
import { visibleModules } from "@/server/modules/catalog";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const [jobs, openReviews, drafts, queued, verified, salesContractPos, modules, recent] = await Promise.all([
    prisma.job.count(),
    prisma.reviewTicket.count({ where: { status: "open" } }),
    prisma.job.count({ where: { status: "draft" } }),
    prisma.job.count({ where: { status: "queued" } }),
    prisma.job.count({ where: { status: { in: ["verified", "submitted"] } } }),
    prisma.salesContractPo.count(),
    prisma.module.findMany({ orderBy: { sortOrder: "asc" } }),
    prisma.job.findMany({ orderBy: { createdAt: "desc" }, take: 8 }),
  ]);

  const shown = visibleModules(modules);

  return (
    <div>
      <PageHeader title="Dashboard" subtitle="Operational status across your commercial automation modules." />

      <div className="grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-3 lg:grid-cols-6">
        <Stat label="Total Jobs" value={jobs} href="/jobs" />
        <Stat label="Open Reviews" value={openReviews} href="/review" tone={openReviews ? "text-rose-600" : "text-slate-800"} />
        <Stat label="Drafts" value={drafts} href="/jobs?status=draft" tone={drafts ? "text-amber-600" : "text-slate-800"} />
        <Stat label="Queued" value={queued} href="/jobs?status=queued" tone={queued ? "text-rose-600" : "text-slate-800"} />
        <Stat label="Verified" value={verified} tone={verified ? "text-emerald-600" : "text-slate-800"} />
        <Stat label="Sales Contract POs" value={salesContractPos} />
      </div>

      <div className="mt-8">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-800">Modules</h2>
          <Link href="/modules" className="text-xs font-medium text-ananta hover:underline">
            View all →
          </Link>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {shown.map((m) => (
            <Link key={m.key} href={`/modules/${m.key}`} className="card card-hover flex items-start justify-between gap-3 p-4">
              <div className="min-w-0">
                <div className="font-medium text-slate-800">{m.name}</div>
                <p className="mt-1 line-clamp-2 text-xs text-slate-500">{m.description}</p>
              </div>
              <span className="shrink-0 text-slate-300">→</span>
            </Link>
          ))}
        </div>
      </div>

      <div className="mt-8">
        <Panel title="Recent Jobs">
          {recent.length === 0 ? (
            <div className="p-8 text-center text-sm text-slate-400">
              No jobs yet. Start with the{" "}
              <Link href="/modules/sales-contract" className="font-medium text-ananta hover:underline">
                Sales Contract
              </Link>{" "}
              module.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-slate-50/70">
                  <tr>
                    <th className="th">Job</th>
                    <th className="th">Module</th>
                    <th className="th">Key</th>
                    <th className="th">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {recent.map((j) => (
                    <tr key={j.id} className="hover:bg-slate-50/60">
                      <td className="td">
                        <Link href={`/jobs/${j.id}`} className="row-link">
                          {j.id.slice(0, 8)}
                        </Link>
                      </td>
                      <td className="td">{j.module}</td>
                      <td className="td font-mono text-xs">{j.businessKey ?? "—"}</td>
                      <td className="td">
                        <StatusBadge status={j.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
