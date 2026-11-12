"use server";

import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { audit } from "@/lib/audit";
import { resolveError } from "@/server/monitoring/errors";

/**
 * Server actions for the Super Admin Control Center. SYSTEM_MONITOR is enforced on
 * the backend here (not just the UI). Administrative actions are written to the
 * append-only audit trail with the acting user + timestamp (requirement #10).
 */

async function requireSuperAdmin() {
  const user = await getSessionUser();
  if (!user) return { error: "Not authenticated." as const };
  if (!userHasPermission(user, PERMISSIONS.SYSTEM_MONITOR)) return { error: "You do not have permission to use the Control Center." as const };
  return { user };
}

/** Acknowledge/resolve a captured error (Troubleshooting). Audited. */
export async function resolveErrorAction(id: string): Promise<{ ok?: boolean; error?: string }> {
  const auth = await requireSuperAdmin();
  if ("error" in auth) return { error: auth.error };
  const ok = await resolveError(id, auth.user.email);
  if (!ok) return { error: "Could not resolve this error (it may no longer exist)." };
  await audit({ entityType: "integration", entityId: id, action: "monitoring.error.resolved", actor: auth.user.email, data: { errorId: id } });
  return { ok: true };
}
