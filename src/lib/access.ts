import "server-only";
import { redirect } from "next/navigation";
import { getSessionUser, userHasPermission, type SessionUser } from "./auth";
import { roleCanAccessSection, type PortalSection, type PermissionKey } from "./permissions";

/**
 * Guard a top-level portal section for direct-URL and backend access.
 *
 * Redirects to /login when signed out, or to /modules when the signed-in
 * user's role is not allowed to open this section (e.g. a Commercial user
 * hitting /dashboard, /jobs, /review, /audit or /admin directly). Returns the
 * session user so the page can keep using it. This is the server-side half of
 * the nav filtering in PortalShell, so hiding a link and blocking its route
 * stay in sync.
 */
export async function requireSection(section: PortalSection): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (!roleCanAccessSection(user.role, section)) redirect("/modules");
  return user;
}

/**
 * Guard a page/route on a specific fine-grained permission (server-side).
 * Redirects to /login when signed out, or to /modules when the user lacks the
 * permission. Used by the Super Admin Control Center (SYSTEM_MONITOR) so the
 * monitoring pages and their data are never served to a non-admin, independent
 * of nav hiding.
 */
export async function requirePermission(permission: PermissionKey): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (!userHasPermission(user, permission)) redirect("/modules");
  return user;
}
