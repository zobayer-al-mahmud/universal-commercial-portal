import { prisma } from "@/lib/db";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { PageHeader, StatusBadge, Empty } from "@/components/ui";

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

  const [users, adapters, refGroups] = await Promise.all([
    prisma.user.findMany({ include: { role: true }, orderBy: { createdAt: "asc" } }),
    prisma.integrationAdapter.findMany(),
    prisma.referenceData.groupBy({ by: ["type"], _count: { _all: true } }),
  ]);

  return (
    <div>
      <PageHeader title="Administration" subtitle="Users & roles, integration adapters, and reference data." />

      <section className="card mb-6 overflow-hidden">
        <div className="border-b border-slate-100 px-4 py-3 text-sm font-semibold text-slate-700">Integration adapters</div>
        <table className="w-full">
          <thead className="bg-slate-50">
            <tr><th className="th">Adapter</th><th className="th">Mode</th><th className="th">Status</th><th className="th">Notes</th></tr>
          </thead>
          <tbody>
            {adapters.map((a) => (
              <tr key={a.key} className="border-t border-slate-50">
                <td className="td font-medium">{a.name}</td>
                <td className="td"><StatusBadge status={a.mode} /></td>
                <td className="td"><StatusBadge status={a.status} /></td>
                <td className="td text-xs text-slate-500">{a.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="px-4 py-2 text-xs text-slate-400">
          All adapters are <strong>mock / not configured</strong>. Live integrations require explicit business authorisation (INTEGRATION_MODE=live) and are fail-closed today.
        </p>
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="card overflow-hidden">
          <div className="border-b border-slate-100 px-4 py-3 text-sm font-semibold text-slate-700">Users & roles</div>
          <table className="w-full">
            <thead className="bg-slate-50">
              <tr><th className="th">Name</th><th className="th">Email</th><th className="th">Role</th><th className="th">Active</th></tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="border-t border-slate-50">
                  <td className="td">{u.name}</td>
                  <td className="td text-xs">{u.email}</td>
                  <td className="td"><span className="badge bg-ananta-100 text-ananta-700">{u.role.name}</span></td>
                  <td className="td">{u.isActive ? "✓" : "✗"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="card overflow-hidden">
          <div className="border-b border-slate-100 px-4 py-3 text-sm font-semibold text-slate-700">Reference data</div>
          <table className="w-full">
            <thead className="bg-slate-50">
              <tr><th className="th">Type</th><th className="th">Entries</th></tr>
            </thead>
            <tbody>
              {refGroups.map((g) => (
                <tr key={g.type} className="border-t border-slate-50">
                  <td className="td">{g.type}</td>
                  <td className="td">{g._count._all}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="px-4 py-2 text-xs text-slate-400">
            Observed-sample values seeded as configurable reference data. Closed lists are not yet confirmed (Q-SC-03/06).
          </p>
        </section>
      </div>
    </div>
  );
}
