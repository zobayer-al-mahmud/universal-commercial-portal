import { redirect } from "next/navigation";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { prisma } from "@/lib/db";
import { PortalShell } from "@/components/PortalShell";

export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const openReviews = await prisma.reviewTicket.count({ where: { status: "open" } });

  return (
    <PortalShell
      user={{ name: user.name, username: user.username, email: user.email, role: user.role }}
      openReviews={openReviews}
      canSystemMonitor={userHasPermission(user, PERMISSIONS.SYSTEM_MONITOR)}
      canAnnounce={userHasPermission(user, PERMISSIONS.ADMIN_USERS)}
    >
      {children}
    </PortalShell>
  );
}
