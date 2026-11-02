import "server-only";
import bcrypt from "bcryptjs";
import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { prisma } from "./db";
import { env } from "./env";
import type { PermissionKey } from "./permissions";

const COOKIE_NAME = "aucp_session";
const secret = new TextEncoder().encode(env.AUTH_SECRET);

export interface SessionUser {
  id: string;
  username: string;
  email: string;
  name: string;
  role: string;
  permissions: PermissionKey[];
}

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export async function createSessionToken(userId: string): Promise<string> {
  return new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${env.SESSION_TTL_HOURS}h`)
    .sign(secret);
}

export async function setSessionCookie(userId: string) {
  const token = await createSessionToken(userId);
  cookies().set(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: env.SESSION_TTL_HOURS * 3600,
  });
}

export function clearSessionCookie() {
  cookies().delete(COOKIE_NAME);
}

/** Resolve the current session user from the signed cookie, or null. */
export async function getSessionUser(): Promise<SessionUser | null> {
  const token = cookies().get(COOKIE_NAME)?.value;
  if (!token) return null;
  let userId: string;
  try {
    const { payload } = await jwtVerify(token, secret);
    userId = String(payload.sub);
  } catch {
    return null;
  }
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { role: { include: { permissions: { include: { permission: true } } } } },
  });
  if (!user || !user.isActive) return null;
  return {
    id: user.id,
    // Actor/display identity: username when set, else the legacy email, else id —
    // so the ~50 `actor: user.email` audit call sites keep a meaningful value.
    username: user.username ?? "",
    email: user.email || user.username || user.id,
    name: user.name,
    role: user.role.name,
    permissions: user.role.permissions.map((rp) => rp.permission.key as PermissionKey),
  };
}

export function userHasPermission(user: SessionUser | null, key: PermissionKey): boolean {
  return !!user && user.permissions.includes(key);
}

/**
 * Authenticate by USERNAME + password. Returns the user id on success.
 * Usernames are stored as entered but matched case-insensitively. For backward
 * compatibility during the email→username migration, a value containing "@" that
 * matches no username falls back to an email lookup (so a not-yet-migrated login
 * still works). Passwords are unchanged bcrypt hashes.
 */
export async function authenticate(identifier: string, password: string): Promise<string | null> {
  const id = identifier.trim();
  if (!id) return null;
  // Usernames are stored lowercased (see normalizeUsername), so a lowercased
  // exact match is case-insensitive without SQLite's unsupported `mode`.
  let user = await prisma.user.findUnique({ where: { username: id.toLowerCase() } });
  if (!user && id.includes("@")) {
    user = await prisma.user.findUnique({ where: { email: id.toLowerCase() } });
  }
  if (!user || !user.isActive) return null;
  const ok = await verifyPassword(password, user.passwordHash);
  return ok ? user.id : null;
}

/** Canonical username form: trimmed + lowercased. Use everywhere a username is stored or looked up. */
export function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase();
}
