import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { PortalShell } from "@/components/PortalShell";

export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const openReviews = await prisma.reviewTicket.count({ where: { status: "open" } });

  return (
    <PortalShell
      user={{ name: user.name, email: user.email, role: user.role }}
      openReviews={openReviews}
    >
      {children}
    </PortalShell>
  );
}
