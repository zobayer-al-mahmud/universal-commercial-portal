import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { logoutAction } from "../actions/auth";
import { StatusBadge } from "@/components/ui";

const NAV = [
  { href: "/dashboard", label: "Dashboard", icon: "▦" },
  { href: "/jobs", label: "Jobs", icon: "⚙" },
  { href: "/review", label: "Review Queue", icon: "⚑" },
  { href: "/modules", label: "Modules", icon: "▤" },
  { href: "/audit", label: "Audit Trail", icon: "☰" },
  { href: "/admin", label: "Administration", icon: "⚙" },
];

export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const openReviews = await prisma.reviewTicket.count({ where: { status: "open" } });

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-60 shrink-0 flex-col border-r border-slate-200 bg-white">
        <div className="flex items-center gap-2 border-b border-slate-200 px-4 py-4">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/ananta_logo_full.png" alt="Ananta" className="h-10 w-auto" />
          <div className="leading-tight">
            <div className="text-sm font-semibold text-ananta">UCP</div>
            <div className="text-[10px] text-slate-400">Commercial Portal</div>
          </div>
        </div>
        <nav className="flex-1 space-y-1 p-3">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className="flex items-center justify-between rounded-md px-3 py-2 text-sm text-slate-600 hover:bg-slate-100"
            >
              <span>
                <span className="mr-2 text-slate-400">{n.icon}</span>
                {n.label}
              </span>
              {n.href === "/review" && openReviews > 0 ? (
                <span className="badge bg-rose-100 text-rose-700">{openReviews}</span>
              ) : null}
            </Link>
          ))}
        </nav>
        <div className="border-t border-slate-200 p-3 text-xs text-slate-500">
          <div className="font-medium text-slate-700">{user.name}</div>
          <div className="mb-2 flex items-center gap-2">
            <StatusBadge status={user.role.toLowerCase()} /> {user.email}
          </div>
          <form action={logoutAction}>
            <button className="btn-ghost w-full text-xs">Sign out</button>
          </form>
        </div>
      </aside>
      <main className="flex-1 overflow-x-hidden px-8 py-6">{children}</main>
    </div>
  );
}
