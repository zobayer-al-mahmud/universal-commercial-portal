"use server";

import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { audit } from "@/lib/audit";
import { emitAnnouncement } from "@/server/notifications/events";
import type { NotificationScope, NotificationLevel } from "@/server/notifications/notify";

const ROLE_AUDIENCES = ["ADMIN", "COMMERCIAL", "MERCHANDISER", "REVIEWER", "VIEWER"] as const;
const LEVELS: NotificationLevel[] = ["info", "success", "warning", "error"];

export interface AnnouncementResult { ok: boolean; message: string; recipients?: number }

/**
 * Admin-authored system announcement / alert → a persistent, role-scoped
 * notification for the chosen audience. Admin-only (ADMIN_USERS). Audience is
 * "all" (every active user) or a single role name.
 */
export async function createAnnouncementAction(formData: FormData): Promise<AnnouncementResult> {
  const user = await getSessionUser();
  if (!user || !userHasPermission(user, PERMISSIONS.ADMIN_USERS)) {
    return { ok: false, message: "Not authorised to send announcements." };
  }
  const title = String(formData.get("title") ?? "").trim().slice(0, 160);
  const body = String(formData.get("body") ?? "").trim().slice(0, 1000);
  const link = String(formData.get("link") ?? "").trim().slice(0, 300);
  const audience = String(formData.get("audience") ?? "all").trim();
  const levelRaw = String(formData.get("level") ?? "info").trim() as NotificationLevel;
  const level: NotificationLevel = LEVELS.includes(levelRaw) ? levelRaw : "info";

  if (!title) return { ok: false, message: "A title is required." };

  let scope: NotificationScope;
  if (audience === "all") scope = { all: true };
  else if ((ROLE_AUDIENCES as readonly string[]).includes(audience.toUpperCase())) scope = { roles: [audience.toUpperCase()] };
  else return { ok: false, message: "Unknown audience." };

  // Only allow an in-app relative link (no external redirects from a notification).
  const safeLink = link.startsWith("/") ? link : "";

  const res = await emitAnnouncement({ title, body, link: safeLink, level, scope, actor: user.email });
  await audit({ entityType: "user", entityId: user.id, action: "notification.announce", actor: user.email, data: { audience, level, recipients: res.recipients } });
  return { ok: true, message: `Announcement sent to ${res.recipients} user(s).`, recipients: res.recipients };
}
