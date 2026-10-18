import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { PageHeader, StatusBadge, Empty } from "@/components/ui";
import { MODULE_CATALOG } from "@/server/modules/catalog";
import { IntakeForm } from "@/components/IntakeForm";
import { RenameForm } from "@/components/RenameForm";
import { ScheduleForm } from "@/components/ScheduleForm";

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
        <div className="mb-6">
          <h3 className="mb-3 text-sm font-semibold text-slate-700">Order Package intake</h3>
          <IntakeForm />
        </div>
      ) : null}

      {module.key === "pdf-rename" ? (
        <div className="mb-6">
          <h3 className="mb-3 text-sm font-semibold text-slate-700">Rename plan from extraction CSV</h3>
          <RenameForm />
        </div>
      ) : null}

      {module.key === "shipment-schedule" ? (
        <div className="mb-6">
          <h3 className="mb-3 text-sm font-semibold text-slate-700">Build week schedule from orders</h3>
          <ScheduleForm />
        </div>
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
