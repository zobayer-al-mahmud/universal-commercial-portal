import "server-only";
import { headers } from "next/headers";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";

/**
 * Authentication-history capture + queries for the Super Admin Control Center
 * (User Monitoring). Writes an append-only AuthEvent for every login success /
 * failure and logout, with the client IP + user agent read from the request
 * headers. Never stores the password or any secret. All writes are best-effort:
 * a monitoring failure must never block sign-in.
 */

export type AuthEventKind = "login_success" | "login_failed" | "logout";

/** Best-effort client IP from proxy headers (populated once a reverse proxy is in front). */
function clientIp(): string {
  try {
    const h = headers();
    const xff = h.get("x-forwarded-for");
    if (xff) return xff.split(",")[0]!.trim().slice(0, 64);
    return (h.get("x-real-ip") || h.get("cf-connecting-ip") || "").slice(0, 64);
  } catch {
    return "";
  }
}

function userAgent(): string {
  try {
    return (headers().get("user-agent") || "").slice(0, 300);
  } catch {
    return "";
  }
}

export async function recordAuthEvent(input: {
  kind: AuthEventKind;
  username: string;
  userId?: string | null;
  role?: string;
  detail?: string;
}): Promise<void> {
  try {
    await prisma.authEvent.create({
      data: {
        kind: input.kind,
        username: (input.username || "").slice(0, 120),
        userId: input.userId ?? null,
        role: (input.role || "").slice(0, 60),
        ip: clientIp(),
        userAgent: userAgent(),
        detail: (input.detail || "").slice(0, 300),
      },
    });
  } catch {
    /* monitoring is best-effort — never block auth */
  }
}

export interface AuthEventView {
  id: string;
  kind: AuthEventKind;
  username: string;
  userId: string | null;
  role: string;
  ip: string;
  userAgent: string;
  detail: string;
  at: string;
}

export interface AuthEventQuery {
  kind?: AuthEventKind;
  username?: string;
  since?: Date;
  until?: Date;
  limit?: number;
}

/** Login/logout/failed history, newest first, filterable + date-ranged. */
export async function getAuthEvents(q: AuthEventQuery = {}): Promise<AuthEventView[]> {
  const where: Record<string, unknown> = {};
  if (q.kind) where.kind = q.kind;
  if (q.username) where.username = { contains: q.username.toLowerCase() };
  if (q.since || q.until) {
    where.createdAt = {
      ...(q.since ? { gte: q.since } : {}),
      ...(q.until ? { lte: q.until } : {}),
    };
  }
  const rows = await prisma.authEvent.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(q.limit ?? 200, 1), 1000),
  });
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind as AuthEventKind,
    username: r.username,
    userId: r.userId,
    role: r.role,
    ip: r.ip,
    userAgent: r.userAgent,
    detail: r.detail,
    at: r.createdAt.toISOString(),
  }));
}

export interface FailedLoginSummary {
  username: string;
  attempts: number;
  lastAttempt: string;
  lastIp: string;
}

/** Failed-login attempts grouped by username over a window (default 24h). */
export async function getFailedLoginSummary(sinceHours = 24): Promise<FailedLoginSummary[]> {
  const since = new Date(Date.now() - sinceHours * 3600_000);
  const rows = await prisma.authEvent.findMany({
    where: { kind: "login_failed", createdAt: { gte: since } },
    orderBy: { createdAt: "desc" },
    take: 1000,
  });
  const byUser = new Map<string, FailedLoginSummary>();
  for (const r of rows) {
    const cur = byUser.get(r.username);
    if (cur) cur.attempts += 1;
    else byUser.set(r.username, { username: r.username, attempts: 1, lastAttempt: r.createdAt.toISOString(), lastIp: r.ip });
  }
  return Array.from(byUser.values()).sort((a, b) => b.attempts - a.attempts);
}

export interface ActiveSessionView {
  username: string;
  userId: string | null;
  role: string;
  ip: string;
  since: string;
  ageMinutes: number;
}

/**
 * Inferred active sessions. Sessions are stateless JWTs (no server-side store), so
 * "active" = the latest auth event for a user is a login_success, that login is
 * within the session TTL, and it has not been followed by a logout. This is an
 * inference, not a live socket count — labelled as such in the UI.
 */
export async function getActiveSessions(): Promise<ActiveSessionView[]> {
  const ttlMs = env.SESSION_TTL_HOURS * 3600_000;
  const since = new Date(Date.now() - ttlMs);
  const rows = await prisma.authEvent.findMany({
    where: { createdAt: { gte: since }, kind: { in: ["login_success", "logout"] } },
    orderBy: { createdAt: "desc" },
    take: 1000,
  });
  const seen = new Set<string>();
  const active: ActiveSessionView[] = [];
  for (const r of rows) {
    const key = r.userId || r.username;
    if (seen.has(key)) continue; // only the most recent event per user matters
    seen.add(key);
    if (r.kind === "login_success") {
      active.push({
        username: r.username,
        userId: r.userId,
        role: r.role,
        ip: r.ip,
        since: r.createdAt.toISOString(),
        ageMinutes: Math.round((Date.now() - r.createdAt.getTime()) / 60000),
      });
    }
  }
  return active;
}
