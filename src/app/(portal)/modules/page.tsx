import Link from "next/link";
import { prisma } from "@/lib/db";
import { PageHeader, StatusBadge } from "@/components/ui";
import { visibleModules } from "@/server/modules/catalog";

export const dynamic = "force-dynamic";

export default async function ModulesPage() {
  const all = await prisma.module.findMany({ orderBy: { sortOrder: "asc" } });
  const modules = visibleModules(all);
  return (
    <div>
      <PageHeader title="Modules" subtitle="Your commercial automation work areas. Select a module to begin." />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {modules.map((m) => (
          <Link key={m.key} href={`/modules/${m.key}`} className="card card-hover flex flex-col p-5">
            <div className="flex items-start justify-between gap-2">
              <h3 className="font-semibold text-slate-800">{m.name}</h3>
              <StatusBadge status={m.status} />
            </div>
            <p className="mt-2 text-sm leading-relaxed text-slate-500">{m.description}</p>
            <span className="mt-4 text-sm font-medium text-ananta">Open →</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
