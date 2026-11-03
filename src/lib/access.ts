import "server-only";
import { redirect } from "next/navigation";
import { getSessionUser, type SessionUser } from "./auth";
import { roleCanAccessSection, type PortalSection } from "./permissions";

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
