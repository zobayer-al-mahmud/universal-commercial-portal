import { requirePermission } from "@/lib/access";
import { PERMISSIONS } from "@/lib/permissions";
import { ControlCenter } from "@/components/ControlCenter";

/**
 * Super Admin Control Center. Backend-gated on SYSTEM_MONITOR (ADMIN only) — a
 * non-admin hitting this route directly is redirected, independent of nav hiding.
 * All data is loaded client-side from the SYSTEM_MONITOR-gated monitoring API and
 * auto-refreshes; nothing here is mocked.
 */
export const dynamic = "force-dynamic";

export default async function ControlCenterPage() {
  await requirePermission(PERMISSIONS.SYSTEM_MONITOR);
  return <ControlCenter />;
}
