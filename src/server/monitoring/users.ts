import "server-only";
import { prisma } from "@/lib/db";
import { getAuthEvents, getFailedLoginSummary, getActiveSessions, type AuthEventView, type FailedLoginSummary, type ActiveSessionView } from "./auth-events";

/**
 * User Monitoring aggregation for the Super Admin Control Center: per-user login
 * history, last login + IP, recent-activity counts, module access, failed-login
 * attempts, and inferred active sessions. Built from the User table + append-only
 * AuthEvent + AuditEvent — all real, no secrets (passwordHash is never selected).
 */

export interface UserActivityRow {
  id: string;
  username: string;
  name: string;
  email: string;
  role: string;
  isActive: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  lastLoginIp: string;
  logins30d: number;
  failed24h: number;
  actions30d: number;
  lastAction: string | null; // "exp.row.updated" etc.
  lastActionAt: string | null;
}

export interface RecentActivity {
  actor: string;
  entityType: string; // the module/area
  action: string;
  at: string;
}

export interface UserMonitoring {
  users: UserActivityRow[];
  activeSessions: ActiveSessionView[];
  failedLogins: FailedLoginSummary[];
  recentAuth: AuthEventView[];
  recentActivity: RecentActivity[];
  moduleAccess: { module: string; events: number }[];
  at: string;
}

export async function getUserMonitoring(): Promise<UserMonitoring> {
  const since30 = new Date(Date.now() - 30 * 24 * 3600_000);
  const since24 = new Date(Date.now() - 24 * 3600_000);

  const [users, logins, fails, audits, activeSessions, failedLogins, recentAuth] = await Promise.all([
    prisma.user.findMany({
      select: { id: true, username: true, email: true, name: true, isActive: true, createdAt: true, role: { select: { name: true } } },
      orderBy: { createdAt: "asc" },
    }),
    prisma.authEvent.findMany({ where: { kind: "login_success", createdAt: { gte: since30 } }, orderBy: { createdAt: "desc" }, take: 2000 }),
    prisma.authEvent.findMany({ where: { kind: "login_failed", createdAt: { gte: since24 } }, orderBy: { createdAt: "desc" }, take: 2000 }),
    prisma.auditEvent.findMany({ where: { createdAt: { gte: since30 } }, orderBy: { createdAt: "desc" }, take: 3000 }),
    getActiveSessions(),
    getFailedLoginSummary(24),
    getAuthEvents({ limit: 100 }),
  ]);

  // Per-user login aggregates (keyed by userId when present, else username).
  const loginByUser = new Map<string, { last: Date; ip: string; count: number }>();
  for (const l of logins) {
    const key = l.userId || l.username;
    const cur = loginByUser.get(key);
    if (cur) cur.count += 1;
    else loginByUser.set(key, { last: l.createdAt, ip: l.ip, count: 1 });
  }
  const failByUser = new Map<string, number>();
  for (const f of fails) failByUser.set(f.username, (failByUser.get(f.username) ?? 0) + 1);

  // Per-actor audit aggregates. `actor` is the username/email used at the call site.
  const actionByActor = new Map<string, { count: number; last: { action: string; at: Date } }>();
  const moduleCount = new Map<string, number>();
  for (const a of audits) {
    const cur = actionByActor.get(a.actor);
    if (cur) cur.count += 1;
    else actionByActor.set(a.actor, { count: 1, last: { action: a.action, at: a.createdAt } });
    moduleCount.set(a.entityType, (moduleCount.get(a.entityType) ?? 0) + 1);
  }

  const userRows: UserActivityRow[] = users.map((u) => {
    const key = u.id;
    const byId = loginByUser.get(key);
    const byName = loginByUser.get(u.username ?? "") ?? loginByUser.get(u.email);
    const login = byId ?? byName;
    const actorKey = u.username || u.email;
    const act = actionByActor.get(actorKey) ?? actionByActor.get(u.email);
    return {
      id: u.id,
      username: u.username ?? "",
      name: u.name,
      email: u.email,
      role: u.role?.name ?? "",
      isActive: u.isActive,
      createdAt: u.createdAt.toISOString(),
      lastLoginAt: login ? login.last.toISOString() : null,
      lastLoginIp: login?.ip ?? "",
      logins30d: login?.count ?? 0,
      failed24h: failByUser.get(u.username ?? "") ?? failByUser.get(u.email) ?? 0,
      actions30d: act?.count ?? 0,
      lastAction: act?.last.action ?? null,
      lastActionAt: act ? act.last.at.toISOString() : null,
    };
  });

  const recentActivity: RecentActivity[] = audits.slice(0, 200).map((a) => ({
    actor: a.actor,
    entityType: a.entityType,
    action: a.action,
    at: a.createdAt.toISOString(),
  }));

  const moduleAccess = Array.from(moduleCount.entries())
    .map(([module, events]) => ({ module, events }))
    .sort((a, b) => b.events - a.events);

  return { users: userRows, activeSessions, failedLogins, recentAuth, recentActivity, moduleAccess, at: new Date().toISOString() };
}
