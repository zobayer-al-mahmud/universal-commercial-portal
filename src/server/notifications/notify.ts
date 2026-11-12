/**
 * Centralized notification system (module: global notification bell).
 *
 * Persistent, non-mock notifications stored one row PER RECIPIENT (fan-out), so
 * per-user unread/read state is trivial and queries are index-friendly. Role-based
 * visibility is enforced at CREATION — only users matching the scope get a row —
 * and again at READ time (a user only ever reads `userId = me`).
 *
 * Scope semantics (a recipient matches if it satisfies ANY provided criterion):
 *   - all: true          → every active user
 *   - roles: ["ADMIN"]   → users whose role name is in the list
 *   - permission: "x"    → users whose role grants that permission
 *   - userIds: [...]      → those specific users
 * `excludeUserId` drops the actor so no one is pinged about their own action.
 *
 * De-dup: when `groupKey` is set and the recipient already has an UNREAD row with
 * the same groupKey, that row is UPDATED (message/level/link refreshed, bumped to
 * now) instead of inserting a duplicate — so a job emitting several events shows
 * as one live notification, never a flood.
 *
 * The pure helpers (`matchesScope`, `resolveRecipientIds`) carry the visibility
 * logic and are unit-tested without a database.
 */

import { prisma } from "@/lib/db";
import type { PermissionKey } from "@/lib/permissions";
import { ROLE_PERMISSIONS } from "@/lib/permissions";

export type NotificationCategory = "job" | "automation" | "review" | "system" | "workflow" | "announcement";
export type NotificationLevel = "info" | "success" | "warning" | "error";

export interface NotificationScope {
  all?: boolean;
  roles?: string[];
  permission?: PermissionKey;
  userIds?: string[];
}

/** A user as the scope resolver needs to see them (role name + permission keys). */
export interface ScopeUser {
  id: string;
  isActive: boolean;
  role: string; // role name, e.g. "ADMIN"
  permissions: PermissionKey[];
}

export interface CreateNotificationInput {
  category: NotificationCategory;
  level?: NotificationLevel;
  title: string;
  body?: string;
  /** In-app href the bell item navigates to (module / record / task). */
  link?: string;
  entityType?: string;
  entityId?: string;
  /** Collapse/dedupe key; an unread row with the same key is refreshed, not duplicated. */
  groupKey?: string;
  actor?: string;
  scope: NotificationScope;
  /** Do not notify this user (usually the actor who triggered the event). */
  excludeUserId?: string;
}

// --- Pure visibility logic (unit-tested) -----------------------------------

/** Whether a single user should receive a notification with this scope. */
export function matchesScope(user: ScopeUser, scope: NotificationScope): boolean {
  if (!user.isActive) return false;
  if (scope.all) return true;
  if (scope.roles && scope.roles.map((r) => r.toUpperCase()).includes((user.role || "").toUpperCase())) return true;
  if (scope.permission && user.permissions.includes(scope.permission)) return true;
  if (scope.userIds && scope.userIds.includes(user.id)) return true;
  return false;
}

/** Resolve the recipient user ids for a scope from a loaded user set. */
export function resolveRecipientIds(users: ScopeUser[], scope: NotificationScope, excludeUserId?: string): string[] {
  const out: string[] = [];
  for (const u of users) {
    if (excludeUserId && u.id === excludeUserId) continue;
    if (matchesScope(u, scope)) out.push(u.id);
  }
  return out;
}

// --- DB-backed operations ---------------------------------------------------

/** Load every user as a ScopeUser (role name + effective permission keys). */
export async function loadScopeUsers(): Promise<ScopeUser[]> {
  const users = await prisma.user.findMany({
    where: { isActive: true },
    include: { role: { include: { permissions: { include: { permission: true } } } } },
  });
  return users.map((u) => ({
    id: u.id,
    isActive: u.isActive,
    role: u.role.name,
    // Prefer the live join; fall back to the static baseline so a freshly seeded
    // role with no RolePermission rows still resolves its permissions.
    permissions: (u.role.permissions.length
      ? u.role.permissions.map((rp) => rp.permission.key)
      : (ROLE_PERMISSIONS[u.role.name.toUpperCase()] ?? []).slice()) as PermissionKey[],
  }));
}

export interface CreateResult {
  recipients: number;
  created: number;
  updated: number;
}

/**
 * Create (fan out) a notification to every user matching the scope. Persistent —
 * never a mock. Returns how many recipients matched and how many rows were
 * inserted vs. collapsed into an existing unread row.
 */
export async function createNotification(input: CreateNotificationInput): Promise<CreateResult> {
  const users = await loadScopeUsers();
  const recipientIds = resolveRecipientIds(users, input.scope, input.excludeUserId);
  if (recipientIds.length === 0) return { recipients: 0, created: 0, updated: 0 };

  const base = {
    category: input.category,
    level: input.level ?? "info",
    title: input.title,
    body: input.body ?? "",
    link: input.link ?? "",
    entityType: input.entityType ?? "",
    entityId: input.entityId ?? "",
    groupKey: input.groupKey ?? "",
    actor: input.actor ?? "system",
  };

  let created = 0;
  let updated = 0;
  for (const userId of recipientIds) {
    // Collapse a repeat event into the recipient's existing UNREAD row for the
    // same groupKey (fresh message + bump to now), else insert a new row.
    if (base.groupKey) {
      const existing = await prisma.notification.findFirst({
        where: { userId, groupKey: base.groupKey, readAt: null },
        orderBy: { createdAt: "desc" },
      });
      if (existing) {
        await prisma.notification.update({
          where: { id: existing.id },
          data: { ...base, createdAt: new Date() },
        });
        updated++;
        continue;
      }
    }
    await prisma.notification.create({ data: { ...base, userId } });
    created++;
  }
  return { recipients: recipientIds.length, created, updated };
}

export interface NotificationView {
  id: string;
  category: string;
  level: string;
  title: string;
  body: string;
  link: string;
  entityType: string;
  entityId: string;
  actor: string;
  read: boolean;
  createdAt: string;
}

function toView(n: {
  id: string; category: string; level: string; title: string; body: string; link: string;
  entityType: string; entityId: string; actor: string; readAt: Date | null; createdAt: Date;
}): NotificationView {
  return {
    id: n.id, category: n.category, level: n.level, title: n.title, body: n.body, link: n.link,
    entityType: n.entityType, entityId: n.entityId, actor: n.actor, read: n.readAt != null,
    createdAt: n.createdAt.toISOString(),
  };
}

/** The recent notifications for one user (newest first), with the unread count. */
export async function listForUser(userId: string, opts: { limit?: number } = {}): Promise<{ items: NotificationView[]; unread: number }> {
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
  const [rows, unread] = await Promise.all([
    prisma.notification.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: limit }),
    prisma.notification.count({ where: { userId, readAt: null } }),
  ]);
  return { items: rows.map(toView), unread };
}

/** Unread count for the bell badge (cheap, index-backed). */
export async function unreadCountForUser(userId: string): Promise<number> {
  return prisma.notification.count({ where: { userId, readAt: null } });
}

/** Mark ONE notification read — scoped to the owner so no one can touch another's. */
export async function markRead(userId: string, id: string): Promise<{ ok: boolean }> {
  const res = await prisma.notification.updateMany({ where: { id, userId, readAt: null }, data: { readAt: new Date() } });
  return { ok: res.count > 0 };
}

/** Mark every unread notification for a user read. */
export async function markAllRead(userId: string): Promise<{ updated: number }> {
  const res = await prisma.notification.updateMany({ where: { userId, readAt: null }, data: { readAt: new Date() } });
  return { updated: res.count };
}
