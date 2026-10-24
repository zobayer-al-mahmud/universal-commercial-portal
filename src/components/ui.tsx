import Link from "next/link";
import type { ReactNode } from "react";

/** Status → badge tone. Keys stay lowercase/underscored so every existing caller
 *  (job/ticket/module/batch/adapter statuses, integration modes) keeps working. */
const TONE: Record<string, string> = {
  // success / done
  verified: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-600/15",
  submitted: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-600/15",
  resolved: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-600/15",
  active: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-600/15",
  completed: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-600/15",
  confirmed: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-600/15",
  implemented: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-600/15",
  // in-progress / info
  received: "bg-sky-50 text-sky-700 ring-1 ring-sky-600/15",
  planned: "bg-sky-50 text-sky-700 ring-1 ring-sky-600/15",
  processing: "bg-sky-50 text-sky-700 ring-1 ring-sky-600/15",
  uploaded: "bg-sky-50 text-sky-700 ring-1 ring-sky-600/15",
  mock: "bg-sky-50 text-sky-700 ring-1 ring-sky-600/15",
  dryrun: "bg-sky-50 text-sky-700 ring-1 ring-sky-600/15",
  // attention / pending
  draft: "bg-amber-50 text-amber-700 ring-1 ring-amber-600/20",
  in_review: "bg-amber-50 text-amber-700 ring-1 ring-amber-600/20",
  needs_review: "bg-amber-50 text-amber-700 ring-1 ring-amber-600/20",
  partial: "bg-amber-50 text-amber-700 ring-1 ring-amber-600/20",
  // problem / blocked
  queued: "bg-rose-50 text-rose-700 ring-1 ring-rose-600/15",
  failed: "bg-rose-50 text-rose-700 ring-1 ring-rose-600/15",
  open: "bg-rose-50 text-rose-700 ring-1 ring-rose-600/15",
  blocked: "bg-rose-50 text-rose-700 ring-1 ring-rose-600/15",
  // neutral
  duplicate: "bg-slate-100 text-slate-600 ring-1 ring-slate-500/10",
  rejected: "bg-slate-100 text-slate-600 ring-1 ring-slate-500/10",
  not_configured: "bg-slate-100 text-slate-600 ring-1 ring-slate-500/10",
  live: "bg-ananta-50 text-ananta-700 ring-1 ring-ananta-600/15",
};

const DOT: Record<string, string> = {
  emerald: "bg-emerald-500",
  sky: "bg-sky-500",
  amber: "bg-amber-500",
  rose: "bg-rose-500",
  slate: "bg-slate-400",
  ananta: "bg-ananta-500",
};

function humanize(status: string): string {
  const s = status.replace(/[_-]+/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  const key = (status ?? "").toLowerCase();
  const tone = TONE[key] ?? "bg-slate-100 text-slate-600 ring-1 ring-slate-500/10";
  const dotKey = tone.includes("emerald")
    ? "emerald"
    : tone.includes("sky")
      ? "sky"
      : tone.includes("amber")
        ? "amber"
        : tone.includes("rose")
          ? "rose"
          : tone.includes("ananta")
            ? "ananta"
            : "slate";
  return (
    <span className={`badge ${tone}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${DOT[dotKey]}`} aria-hidden />
      {label ?? humanize(status)}
    </span>
  );
}

export function Stat({
  label,
  value,
  href,
  tone,
  icon,
}: {
  label: string;
  value: ReactNode;
  href?: string;
  tone?: string;
  icon?: ReactNode;
}) {
  const body = (
    <div className={`card p-4 ${href ? "card-hover" : ""}`}>
      <div className="flex items-start justify-between">
        <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
        {icon ? <div className="text-slate-300">{icon}</div> : null}
      </div>
      <div className={`mt-2 text-2xl font-semibold tracking-tight ${tone ?? "text-slate-800"}`}>{value}</div>
    </div>
  );
  return href ? (
    <Link href={href} className="block">
      {body}
    </Link>
  ) : (
    body
  );
}

export function PageHeader({
  title,
  subtitle,
  eyebrow,
  actions,
}: {
  title: string;
  subtitle?: string;
  eyebrow?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
      <div className="min-w-0">
        {eyebrow ? (
          <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-ananta-600">{eyebrow}</div>
        ) : null}
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{title}</h1>
        {subtitle ? <p className="mt-1.5 max-w-3xl text-sm text-slate-500">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function Panel({
  title,
  actions,
  children,
  bodyClass,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  bodyClass?: string;
}) {
  return (
    <section className="card overflow-hidden">
      {title ? (
        <div className="panel-head">
          <div className="panel-title">{title}</div>
          {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
      <div className={bodyClass ?? ""}>{children}</div>
    </section>
  );
}

export function Empty({
  children,
  title,
  icon,
  action,
}: {
  children?: ReactNode;
  title?: string;
  icon?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="card flex flex-col items-center justify-center gap-2 p-10 text-center">
      {icon ? <div className="text-slate-300">{icon}</div> : null}
      {title ? <div className="text-sm font-semibold text-slate-700">{title}</div> : null}
      {children ? <div className="max-w-md text-sm text-slate-400">{children}</div> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <span className={`spinner ${className ?? ""}`} role="status" aria-label="Loading" />;
}
