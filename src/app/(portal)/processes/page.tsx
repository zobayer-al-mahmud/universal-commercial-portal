import Link from "next/link";
import { PageHeader, Panel, Stat } from "@/components/ui";
import { AutoRefresh } from "@/components/AutoRefresh";
import { requireSection } from "@/lib/access";
import { getRunningJobs, anyActive, type RunningJob, type RunningJobStatus } from "@/server/automation/running-jobs";

export const dynamic = "force-dynamic";

const STATUS_TONE: Record<RunningJobStatus, string> = {
  running: "bg-sky-100 text-sky-700 ring-1 ring-sky-500/20",
  queued: "bg-amber-100 text-amber-700 ring-1 ring-amber-500/20",
  completed: "bg-emerald-100 text-emerald-700 ring-1 ring-emerald-500/20",
  partial: "bg-amber-100 text-amber-700 ring-1 ring-amber-500/20",
  failed: "bg-rose-100 text-rose-700 ring-1 ring-rose-500/20",
  stopped: "bg-slate-200 text-slate-600 ring-1 ring-slate-500/20",
  idle: "bg-slate-100 text-slate-500 ring-1 ring-slate-500/10",
};

const STATUS_LABEL: Record<RunningJobStatus, string> = {
  running: "Running",
  queued: "Queued",
  completed: "Completed",
  partial: "Partial",
  failed: "Failed",
  stopped: "Stopped",
  idle: "Idle",
};

function elapsed(from: Date, to: Date): string {
  const s = Math.max(0, Math.round((to.getTime() - from.getTime()) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

function StatusPill({ job }: { job: RunningJob }) {
  return (
    <span className={`badge ${STATUS_TONE[job.status]}`}>
      {job.active ? (
        <span className="relative flex h-1.5 w-1.5" aria-hidden>
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sky-500 opacity-75" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-sky-500" />
        </span>
      ) : (
        <span className="h-1.5 w-1.5 rounded-full bg-current opacity-50" aria-hidden />
      )}
      {STATUS_LABEL[job.status]}
    </span>
  );
}

function ProgressCell({ job }: { job: RunningJob }) {
  const barTone = job.status === "failed" ? "bg-rose-500" : job.status === "partial" ? "bg-amber-500" : job.active ? "bg-sky-500" : "bg-emerald-500";
  return (
    <div className="min-w-[160px]">
      <div className="flex items-center justify-between text-xs text-slate-500">
        <span className="font-medium text-slate-700">
          {job.processed}/{job.total}
        </span>
        <span>{job.progressPct}%</span>
      </div>
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
        <div className={`h-full rounded-full ${barTone} transition-all`} style={{ width: `${job.progressPct}%` }} />
      </div>
    </div>
  );
}

export default async function RunningProcessesPage() {
  await requireSection("processes");
  const now = new Date();
  const jobs = await getRunningJobs();
  const active = jobs.filter((j) => j.active);
  const totalSuccess = jobs.reduce((n, j) => n + j.success, 0);
  const totalFailed = jobs.reduce((n, j) => n + j.failed, 0);

  return (
    <div>
      {/* Live refresh only while something is actually processing. */}
      <AutoRefresh intervalMs={5000} enabled={anyActive(jobs)} />

      <PageHeader
        title="Running Processes"
        subtitle="Live status of every background automation across all modules. Jobs keep running on the server when you switch tabs, navigate away, or refresh — open any job to revisit its module."
      />

      <div className="grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-4">
        <Stat label="Active now" value={active.length} tone={active.length ? "text-sky-600" : "text-slate-800"} />
        <Stat label="Jobs shown" value={jobs.length} />
        <Stat label="Records completed" value={totalSuccess} tone={totalSuccess ? "text-emerald-600" : "text-slate-800"} />
        <Stat label="Records failed" value={totalFailed} tone={totalFailed ? "text-rose-600" : "text-slate-800"} />
      </div>

      <div className="mt-8">
        <Panel title="Background jobs">
          {jobs.length === 0 ? (
            <div className="p-10 text-center text-sm text-slate-400">
              No background jobs yet. Start one from any{" "}
              <Link href="/modules" className="font-medium text-ananta hover:underline">
                process module
              </Link>{" "}
              — it will appear here and keep running if you leave the page.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-slate-50/70">
                  <tr>
                    <th className="th">Module</th>
                    <th className="th">Batch</th>
                    <th className="th">Progress</th>
                    <th className="th">Success</th>
                    <th className="th">Failed</th>
                    <th className="th">Remaining</th>
                    <th className="th">Status</th>
                    <th className="th">Started</th>
                    <th className="th">Elapsed</th>
                    <th className="th"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {jobs.map((j) => (
                    <tr key={j.key} className="hover:bg-slate-50/60">
                      <td className="td font-medium text-slate-800">{j.module}</td>
                      <td className="td max-w-[220px] truncate text-slate-600" title={j.batch}>
                        {j.batch}
                      </td>
                      <td className="td">
                        <ProgressCell job={j} />
                      </td>
                      <td className="td text-emerald-700">{j.success}</td>
                      <td className={`td ${j.failed ? "text-rose-600" : "text-slate-400"}`}>{j.failed}</td>
                      <td className={`td ${j.remaining ? "text-slate-700" : "text-slate-400"}`}>{j.remaining}</td>
                      <td className="td">
                        <StatusPill job={j} />
                      </td>
                      <td className="td whitespace-nowrap text-xs text-slate-400">
                        {j.startedAt.toISOString().slice(0, 16).replace("T", " ")}
                      </td>
                      <td className="td whitespace-nowrap text-xs text-slate-500">
                        {elapsed(j.startedAt, j.active ? now : j.lastActivity)}
                      </td>
                      <td className="td text-right">
                        <Link href={j.href} className="text-xs font-medium text-ananta hover:underline">
                          Open →
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
        <p className="mt-3 text-xs text-slate-400">
          Pause, Resume, Stop, Retry and Download controls live inside each job&rsquo;s own module — click Open to revisit it.
          Global Stop remains available per module. This view refreshes automatically while a job is running.
        </p>
      </div>
    </div>
  );
}
