"use server";

import { revalidatePath } from "next/cache";
import { getSessionUser, userHasPermission, hashPassword, normalizeUsername } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";

/**
 * Administrator user-management actions. Every action re-checks ADMIN_USERS
 * server-side, hashes passwords (never stores or echoes plaintext), enforces
 * unique usernames, and writes an audit record. Guards prevent an admin from
 * locking everyone out (last active admin / self-deactivation).
 */

const MIN_PASSWORD = 8;
const USERNAME_RE = /^[a-z0-9._-]{3,40}$/;

export interface AdminActionState {
  ok?: boolean;
  error?: string;
  message?: string;
}

async function requireAdmin() {
  const user = await getSessionUser();
  if (!user) return { error: "Not authenticated." as const };
  if (!userHasPermission(user, PERMISSIONS.ADMIN_USERS)) return { error: "Administrator access required." as const };
  return { user };
}

/** Count active users holding the ADMIN role (used by the last-admin guard). */
async function activeAdminCount(): Promise<number> {
  return prisma.user.count({ where: { isActive: true, role: { name: "ADMIN" } } });
}

export async function createAdminUserAction(input: {
  username: string;
  name: string;
  password: string;
  roleName?: string;
}): Promise<AdminActionState> {
  const auth = await requireAdmin();
  if ("error" in auth) return { error: auth.error };

  const username = normalizeUsername(input.username ?? "");
  const name = (input.name ?? "").trim();
  const password = input.password ?? "";
  const roleName = (input.roleName ?? "ADMIN").trim().toUpperCase();

  if (!USERNAME_RE.test(username)) return { error: "Username must be 3–40 chars: lowercase letters, numbers, dot, dash or underscore." };
  if (!name) return { error: "Name is required." };
  if (password.length < MIN_PASSWORD) return { error: `Password must be at least ${MIN_PASSWORD} characters.` };

  const role = await prisma.role.findUnique({ where: { name: roleName } });
  if (!role) return { error: `Unknown role "${roleName}".` };

  const existing = await prisma.user.findUnique({ where: { username } });
  if (existing) return { error: `Username "${username}" is already taken.` };

  // `email` is a retained legacy column; synthesize a unique placeholder when the
  // account is created by username only.
  const email = `${username}@ucp.local`;
  const user = await prisma.user.create({
    data: { username, email, name, passwordHash: await hashPassword(password), roleId: role.id },
  });
  await audit({ entityType: "user", entityId: user.id, action: "admin.user.created", actor: auth.user.username || auth.user.email, data: { username, role: roleName } });
  revalidatePath("/admin");
  return { ok: true, message: `User "${username}" created.` };
}

export async function setAdminUserActiveAction(userId: string, active: boolean): Promise<AdminActionState> {
  const auth = await requireAdmin();
  if ("error" in auth) return { error: auth.error };

  const target = await prisma.user.findUnique({ where: { id: userId }, include: { role: true } });
  if (!target) return { error: "User not found." };
  if (target.isActive === active) return { ok: true, message: "No change." };

  if (!active) {
    if (target.id === auth.user.id) return { error: "You cannot deactivate your own account." };
    if (target.role.name === "ADMIN" && (await activeAdminCount()) <= 1) {
      return { error: "Cannot deactivate the last active administrator." };
    }
  }

  await prisma.user.update({ where: { id: userId }, data: { isActive: active } });
  await audit({
    entityType: "user",
    entityId: userId,
    action: active ? "admin.user.activated" : "admin.user.deactivated",
    actor: auth.user.username || auth.user.email,
    data: { username: target.username },
  });
  revalidatePath("/admin");
  return { ok: true, message: active ? "User activated." : "User deactivated." };
}

export async function setAdminUserPasswordAction(userId: string, newPassword: string): Promise<AdminActionState> {
  const auth = await requireAdmin();
  if ("error" in auth) return { error: auth.error };
  if ((newPassword ?? "").length < MIN_PASSWORD) return { error: `Password must be at least ${MIN_PASSWORD} characters.` };

  const target = await prisma.user.findUnique({ where: { id: userId } });
  if (!target) return { error: "User not found." };

  await prisma.user.update({ where: { id: userId }, data: { passwordHash: await hashPassword(newPassword) } });
  await audit({ entityType: "user", entityId: userId, action: "admin.user.password_changed", actor: auth.user.username || auth.user.email, data: { username: target.username } });
  revalidatePath("/admin");
  return { ok: true, message: "Password updated." };
}
