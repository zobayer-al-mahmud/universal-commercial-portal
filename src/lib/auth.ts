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
    email: user.email,
    name: user.name,
    role: user.role.name,
    permissions: user.role.permissions.map((rp) => rp.permission.key as PermissionKey),
  };
}

export function userHasPermission(user: SessionUser | null, key: PermissionKey): boolean {
  return !!user && user.permissions.includes(key);
}

/** Authenticate by email + password. Returns the user id on success. */
export async function authenticate(email: string, password: string): Promise<string | null> {
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
  if (!user || !user.isActive) return null;
  const ok = await verifyPassword(password, user.passwordHash);
  return ok ? user.id : null;
}
