import "server-only";
import { prisma } from "@/lib/db";

/**
 * Central error capture + queries for the Super Admin Control Center (Error
 * Monitoring). Repeat errors are de-duplicated by a fingerprint so the table
 * records frequency (count) + history (firstSeen/lastSeen) instead of flooding.
 * Context is sanitized — credentials and secrets are stripped before storage.
 * All writes are best-effort and never throw into the caller.
 */

const SECRET_KEY_RE = /pass(word)?|secret|token|cookie|authorization|apikey|api[_-]?key|credential|pwd|bearer/i;

/** Remove secret-looking keys/values from a context object before storing it. */
function sanitizeContext(ctx: unknown): string {
  try {
    const seen = new WeakSet();
    const clean = (v: unknown): unknown => {
      if (v === null || typeof v !== "object") return v;
      if (seen.has(v as object)) return "[circular]";
      seen.add(v as object);
      if (Array.isArray(v)) return v.slice(0, 50).map(clean);
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        out[k] = SECRET_KEY_RE.test(k) ? "[redacted]" : clean(val);
      }
      return out;
    };
    return JSON.stringify(clean(ctx)).slice(0, 4000);
  } catch {
    return "{}";
  }
}

function fingerprint(source: string, message: string, stack: string): string {
  const topFrame = (stack.split("\n").find((l) => l.trim().startsWith("at ")) || "").trim();
  const firstLine = (message || "").split("\n")[0]!.slice(0, 200);
  // FNV-1a 32-bit over source + first message line + top stack frame. This is a
  // stable de-duplication key, not a cryptographic hash — so it needs no Node
  // `crypto` builtin (which cannot be bundled through the instrumentation hook).
  const str = `${source}|${firstLine}|${topFrame}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export async function recordError(input: {
  source: string;
  error: unknown;
  level?: "warn" | "error" | "critical";
  context?: Record<string, unknown>;
}): Promise<void> {
  try {
    const err = input.error;
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 1000) || "Unknown error";
    const stack = (err instanceof Error && err.stack ? err.stack : "").slice(0, 6000);
    const fp = fingerprint(input.source, message, stack);
    const level = input.level ?? "error";
    const context = sanitizeContext(input.context ?? {});

    // De-duplicate: bump an existing UNRESOLVED error with the same fingerprint.
    const existing = await prisma.errorEvent.findFirst({ where: { fingerprint: fp, resolvedAt: null }, select: { id: true } });
    if (existing) {
      await prisma.errorEvent.update({ where: { id: existing.id }, data: { count: { increment: 1 }, lastSeen: new Date(), level, context } });
    } else {
      await prisma.errorEvent.create({ data: { source: input.source.slice(0, 160), message, stack, fingerprint: fp, level, context } });
    }
  } catch {
    /* best-effort — never throw from the error recorder */
  }
}

export interface ErrorEventView {
  id: string;
  level: string;
  source: string;
  message: string;
  stack: string;
  context: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  resolvedAt: string | null;
  resolvedBy: string;
}

export interface ErrorQuery {
  level?: string;
  source?: string;
  search?: string;
  includeResolved?: boolean;
  since?: Date;
  until?: Date;
  limit?: number;
}

export async function getErrors(q: ErrorQuery = {}): Promise<ErrorEventView[]> {
  const where: Record<string, unknown> = {};
  if (q.level) where.level = q.level;
  if (q.source) where.source = { contains: q.source };
  if (q.search) where.message = { contains: q.search };
  if (!q.includeResolved) where.resolvedAt = null;
  if (q.since || q.until) where.lastSeen = { ...(q.since ? { gte: q.since } : {}), ...(q.until ? { lte: q.until } : {}) };
  const rows = await prisma.errorEvent.findMany({ where, orderBy: { lastSeen: "desc" }, take: Math.min(Math.max(q.limit ?? 200, 1), 1000) });
  return rows.map((r) => ({
    id: r.id,
    level: r.level,
    source: r.source,
    message: r.message,
    stack: r.stack,
    context: r.context,
    count: r.count,
    firstSeen: r.firstSeen.toISOString(),
    lastSeen: r.lastSeen.toISOString(),
    resolvedAt: r.resolvedAt ? r.resolvedAt.toISOString() : null,
    resolvedBy: r.resolvedBy,
  }));
}

/** Acknowledge/resolve an error (Troubleshooting). Audited by the caller. */
export async function resolveError(id: string, actor: string): Promise<boolean> {
  try {
    await prisma.errorEvent.update({ where: { id }, data: { resolvedAt: new Date(), resolvedBy: actor.slice(0, 120) } });
    return true;
  } catch {
    return false;
  }
}

export interface ErrorStats {
  openTotal: number;
  critical: number;
  error: number;
  warn: number;
  last24h: number;
}

export async function getErrorStats(): Promise<ErrorStats> {
  const since = new Date(Date.now() - 24 * 3600_000);
  const [openTotal, critical, error, warn, last24h] = await Promise.all([
    prisma.errorEvent.count({ where: { resolvedAt: null } }),
    prisma.errorEvent.count({ where: { resolvedAt: null, level: "critical" } }),
    prisma.errorEvent.count({ where: { resolvedAt: null, level: "error" } }),
    prisma.errorEvent.count({ where: { resolvedAt: null, level: "warn" } }),
    prisma.errorEvent.count({ where: { lastSeen: { gte: since } } }),
  ]);
  return { openTotal, critical, error, warn, last24h };
}
