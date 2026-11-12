import { prisma } from "@/lib/db";
import { userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { requireSection } from "@/lib/access";
import { PageHeader, Empty } from "@/components/ui";
import { AdminUserManager, type AdminUserRow } from "@/components/AdminUserManager";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const user = await requireSection("admin");
  const isAdmin = userHasPermission(user, PERMISSIONS.ADMIN_USERS);
  if (!isAdmin) {
    return (
      <div>
        <PageHeader title="Administration" />
        <Empty>Administrator access required.</Empty>
      </div>
    );
  }

  const [users, roles] = await Promise.all([
    prisma.user.findMany({ include: { role: true }, orderBy: { createdAt: "asc" } }),
    prisma.role.findMany({ orderBy: { name: "asc" } }),
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
      <PageHeader title="Administration" subtitle="Manage users and roles." />

      <section className="card overflow-hidden">
        <div className="panel-head"><div className="panel-title">Users &amp; roles</div></div>
        <div className="p-3">
          <AdminUserManager users={userRows} roles={roles.map((r) => r.name)} currentUserId={user!.id} />
        </div>
      </section>
    </div>
  );
}
