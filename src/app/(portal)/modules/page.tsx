import Link from "next/link";
import { prisma } from "@/lib/db";
import { PageHeader, StatusBadge } from "@/components/ui";
import { MODULE_CATALOG } from "@/server/modules/catalog";

export const dynamic = "force-dynamic";

export default async function ModulesPage() {
  const modules = await prisma.module.findMany({ orderBy: { sortOrder: "asc" } });
  return (
    <div>
      <PageHeader
        title="Modules"
        subtitle="The nine commercial work areas. Status reflects what the source material supported — modules with no source files are marked blocked."
      />
      <div className="grid gap-4 md:grid-cols-2">
        {modules.map((m) => {
          const cat = MODULE_CATALOG[m.key];
          return (
            <Link key={m.key} href={`/modules/${m.key}`} className="card block p-5 hover:border-ananta">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold text-slate-800">{m.name}</h3>
                <StatusBadge status={m.status} />
              </div>
              <p className="mt-2 text-sm text-slate-500">{m.description}</p>
              {cat ? (
                <p className="mt-3 text-xs text-slate-400">
                  <span className="font-medium text-slate-500">Sources:</span> {cat.sources}
                </p>
              ) : null}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
