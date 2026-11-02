import { prisma } from "@/lib/db";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { PageHeader, StatusBadge, Empty } from "@/components/ui";
import { AdminUserManager, type AdminUserRow } from "@/components/AdminUserManager";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const user = await getSessionUser();
  const isAdmin = userHasPermission(user, PERMISSIONS.ADMIN_USERS);
  if (!isAdmin) {
    return (
      <div>
        <PageHeader title="Administration" />
        <Empty>Administrator access required.</Empty>
      </div>
    );
  }

  const [users, roles, adapters, refGroups] = await Promise.all([
    prisma.user.findMany({ include: { role: true }, orderBy: { createdAt: "asc" } }),
    prisma.role.findMany({ orderBy: { name: "asc" } }),
    prisma.integrationAdapter.findMany(),
    prisma.referenceData.groupBy({ by: ["type"], _count: { _all: true } }),
  ]);
  const userRows: AdminUserRow[] = users.map((u) => ({
    id: u.id,
    username: u.username ?? "",
    email: u.email,
    name: u.name,
    roleName: u.role.name,
    isActive: u.isActive,
  }));

  return (
    <div>
      <PageHeader title="Administration" subtitle="Users & roles, integration adapters, and reference data." />

      <section className="card mb-6 overflow-x-auto">
        <div className="panel-head"><div className="panel-title">Integration adapters</div></div>
        <table className="w-full">
          <thead className="bg-slate-50/70">
            <tr><th className="th">Adapter</th><th className="th">Mode</th><th className="th">Status</th><th className="th">Notes</th></tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {adapters.map((a) => (
              <tr key={a.key} className="hover:bg-slate-50/60">
                <td className="td font-medium">{a.name}</td>
                <td className="td"><StatusBadge status={a.mode} /></td>
                <td className="td"><StatusBadge status={a.status} /></td>
                <td className="td text-xs text-slate-500">{a.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="card overflow-hidden">
          <div className="panel-head"><div className="panel-title">Users &amp; roles</div></div>
          <div className="p-3">
            <AdminUserManager users={userRows} roles={roles.map((r) => r.name)} currentUserId={user!.id} />
          </div>
        </section>

        <section className="card overflow-hidden">
          <div className="panel-head"><div className="panel-title">Reference data</div></div>
          <table className="w-full">
            <thead className="bg-slate-50/70">
              <tr><th className="th">Type</th><th className="th">Entries</th></tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {refGroups.map((g) => (
                <tr key={g.type} className="hover:bg-slate-50/60">
                  <td className="td">{g.type}</td>
                  <td className="td">{g._count._all}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
}
