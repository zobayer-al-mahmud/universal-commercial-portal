"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { logoutAction } from "@/app/actions/auth";

type NavItem = { href: string; label: string; icon: ReactNode };

function Icon({ path }: { path: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-[18px] w-[18px] shrink-0"
      aria-hidden
    >
      {path}
    </svg>
  );
}

const NAV: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: <Icon path={<><rect x="3" y="3" width="7" height="9" rx="1" /><rect x="14" y="3" width="7" height="5" rx="1" /><rect x="14" y="12" width="7" height="9" rx="1" /><rect x="3" y="16" width="7" height="5" rx="1" /></>} /> },
  { href: "/modules", label: "Modules", icon: <Icon path={<><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>} /> },
  { href: "/jobs", label: "Jobs", icon: <Icon path={<><path d="M4 7h16M4 12h16M4 17h10" /></>} /> },
  { href: "/review", label: "Review Queue", icon: <Icon path={<><path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></>} /> },
  { href: "/audit", label: "Audit Trail", icon: <Icon path={<><path d="M12 8v4l3 2" /><circle cx="12" cy="12" r="9" /></>} /> },
  { href: "/admin", label: "Administration", icon: <Icon path={<><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-2.82 1.17V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 8 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15H4.5a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 6.2 9.4l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 12 4.6V4.5a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 2.82 1.17l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 12v.09Z" /></>} /> },
];

function isActive(pathname: string, href: string): boolean {
  return href === "/dashboard" ? pathname === href : pathname === href || pathname.startsWith(href + "/");
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join("");
}

function Brand() {
  return (
    <div className="flex items-center gap-2.5">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/ananta_logo_full.png" alt="Ananta" className="h-9 w-auto" />
      <div className="leading-tight">
        <div className="text-sm font-bold tracking-tight text-ananta-700">UCP</div>
        <div className="text-[10px] font-medium uppercase tracking-wider text-slate-400">Commercial Portal</div>
      </div>
    </div>
  );
}

export function PortalShell({
  user,
  openReviews,
  children,
}: {
  user: { name: string; email: string; role: string };
  openReviews: number;
  children: ReactNode;
}) {
  const pathname = usePathname() ?? "";
  const [mobileOpen, setMobileOpen] = useState(false);

  // Close the mobile drawer whenever the route changes.
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  const nav = (
    <nav className="flex-1 space-y-0.5 overflow-y-auto p-3">
      {NAV.map((n) => {
        const active = isActive(pathname, n.href);
        return (
          <Link
            key={n.href}
            href={n.href}
            className={`group flex items-center justify-between rounded-lg px-3 py-2 text-sm font-medium transition ${
              active
                ? "bg-ananta-50 text-ananta-700"
                : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
            }`}
          >
            <span className="flex items-center gap-2.5">
              <span className={active ? "text-ananta-600" : "text-slate-400 group-hover:text-slate-500"}>
                {n.icon}
              </span>
              {n.label}
            </span>
            {n.href === "/review" && openReviews > 0 ? (
              <span className="badge bg-rose-100 text-rose-700">{openReviews}</span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );

  const footer = (
    <div className="border-t border-slate-200 p-3">
      <div className="flex items-center gap-2.5 rounded-lg px-2 py-2">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-ananta-100 text-xs font-semibold text-ananta-700">
          {initials(user.name) || "U"}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-slate-800">{user.name}</div>
          <div className="truncate text-xs text-slate-400">{user.email}</div>
        </div>
      </div>
      <div className="mt-1 flex items-center justify-between gap-2 px-2">
        <StatusPill role={user.role} />
        <form action={logoutAction}>
          <button className="text-xs font-medium text-slate-500 hover:text-rose-600">Sign out</button>
        </form>
      </div>
    </div>
  );

  return (
    <div className="flex min-h-screen bg-surface-muted">
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-slate-200 bg-white lg:flex">
        <div className="border-b border-slate-200 px-4 py-4">
          <Brand />
        </div>
        {nav}
        {footer}
      </aside>

      {/* Mobile drawer */}
      {mobileOpen ? (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-slate-900/40" onClick={() => setMobileOpen(false)} />
          <aside className="absolute left-0 top-0 flex h-full w-64 animate-fade-in flex-col border-r border-slate-200 bg-white shadow-pop">
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-4">
              <Brand />
              <button
                className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                onClick={() => setMobileOpen(false)}
                aria-label="Close menu"
              >
                <Icon path={<path d="M6 6l12 12M18 6L6 18" />} />
              </button>
            </div>
            {nav}
            {footer}
          </aside>
        </div>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile top bar */}
        <header className="sticky top-0 z-30 flex items-center justify-between border-b border-slate-200 bg-white/90 px-4 py-3 backdrop-blur lg:hidden">
          <Brand />
          <button
            className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100"
            onClick={() => setMobileOpen(true)}
            aria-label="Open menu"
          >
            <Icon path={<path d="M4 6h16M4 12h16M4 18h16" />} />
          </button>
        </header>

        <main className="mx-auto w-full max-w-[1400px] flex-1 px-4 py-6 sm:px-6 lg:px-8">{children}</main>
      </div>
    </div>
  );
}

function StatusPill({ role }: { role: string }) {
  return (
    <span className="badge bg-slate-100 text-slate-600 ring-1 ring-slate-500/10">
      {role.charAt(0).toUpperCase() + role.slice(1).toLowerCase()}
    </span>
  );
}
