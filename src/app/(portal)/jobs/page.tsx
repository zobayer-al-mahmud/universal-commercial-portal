import Link from "next/link";
import { prisma } from "@/lib/db";
import { PageHeader, StatusBadge, Empty } from "@/components/ui";

export const dynamic = "force-dynamic";

const STATUSES = ["all", "received", "draft", "queued", "verified", "failed", "duplicate"];

export default async function JobsPage({ searchParams }: { searchParams: { status?: string } }) {
  const status = searchParams.status ?? "all";
  const jobs = await prisma.job.findMany({
    where: status === "all" ? {} : { status },
    orderBy: { createdAt: "desc" },
    take: 100,
    include: { _count: { select: { reviewTickets: true, contractRows: true, poRows: true } } },
  });

  return (
    <div>
      <PageHeader title="Jobs" subtitle="All processing jobs with their full stage history." />
      <div className="mb-4 flex flex-wrap gap-2">
        {STATUSES.map((s) => (
          <Link
            key={s}
            href={s === "all" ? "/jobs" : `/jobs?status=${s}`}
            className={`chip capitalize ${status === s ? "chip-active" : ""}`}
          >
            {s}
          </Link>
        ))}
      </div>
      {jobs.length === 0 ? (
        <Empty title="No jobs found">No jobs match this filter.</Empty>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full">
            <thead className="bg-slate-50/70">
              <tr>
                <th className="th">Job</th>
                <th className="th">Module</th>
                <th className="th">Type</th>
                <th className="th">Business key</th>
                <th className="th">Status</th>
                <th className="th">PO</th>
                <th className="th">Contract</th>
                <th className="th">Reviews</th>
                <th className="th">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {jobs.map((j) => (
                <tr key={j.id} className="hover:bg-slate-50/60">
                  <td className="td">
                    <Link href={`/jobs/${j.id}`} className="row-link">
                      {j.id.slice(0, 8)}
                    </Link>
                  </td>
                  <td className="td">{j.module}</td>
                  <td className="td text-xs">{j.type}</td>
                  <td className="td font-mono text-xs">{j.businessKey ?? "—"}</td>
                  <td className="td"><StatusBadge status={j.status} /></td>
                  <td className="td">{j._count.poRows}</td>
                  <td className="td">{j._count.contractRows}</td>
                  <td className="td">{j._count.reviewTickets}</td>
                  <td className="td text-xs text-slate-400">{j.createdAt.toISOString().slice(0, 16).replace("T", " ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
