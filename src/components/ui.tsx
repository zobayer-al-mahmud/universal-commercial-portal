import Link from "next/link";
import type { ReactNode } from "react";

export function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    verified: "bg-green-100 text-green-800",
    submitted: "bg-green-100 text-green-800",
    draft: "bg-amber-100 text-amber-800",
    queued: "bg-rose-100 text-rose-800",
    failed: "bg-rose-100 text-rose-800",
    duplicate: "bg-slate-100 text-slate-600",
    received: "bg-sky-100 text-sky-800",
    open: "bg-rose-100 text-rose-800",
    in_review: "bg-amber-100 text-amber-800",
    resolved: "bg-green-100 text-green-800",
    rejected: "bg-slate-200 text-slate-700",
    active: "bg-green-100 text-green-800",
    planned: "bg-sky-100 text-sky-800",
    blocked: "bg-rose-100 text-rose-800",
    not_configured: "bg-slate-100 text-slate-600",
    mock: "bg-sky-100 text-sky-800",
    completed: "bg-green-100 text-green-800",
    partial: "bg-amber-100 text-amber-800",
    needs_review: "bg-amber-100 text-amber-800",
    processing: "bg-sky-100 text-sky-800",
    uploaded: "bg-sky-100 text-sky-800",
  };
  return <span className={`badge ${map[status] ?? "bg-slate-100 text-slate-600"}`}>{status}</span>;
}

export function Stat({ label, value, href, tone }: { label: string; value: ReactNode; href?: string; tone?: string }) {
  const body = (
    <div className="card p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`mt-1 text-2xl font-semibold ${tone ?? "text-slate-800"}`}>{value}</div>
    </div>
  );
  return href ? <Link href={href}>{body}</Link> : body;
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex items-start justify-between gap-4">
      <div>
        <h1 className="text-xl font-semibold text-slate-800">{title}</h1>
        {subtitle ? <p className="mt-1 max-w-3xl text-sm text-slate-500">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 gap-2">{actions}</div> : null}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="card p-8 text-center text-sm text-slate-400">{children}</div>;
}
