/**
 * Domain notification emitters — thin, well-formed wrappers over
 * `createNotification` so each call site stays a one-liner and every notification
 * carries a correct in-app `link`, category, level and role-based scope.
 *
 * All emitters are best-effort: a notification must NEVER break the business
 * action that triggered it, so each swallows its own errors (and reports via the
 * central error channel only if one exists). They are the ONLY place that decides
 * "who should see this" for each event type.
 */

import { prisma } from "@/lib/db";
import { PERMISSIONS } from "@/lib/permissions";
import { createNotification, type NotificationScope, type NotificationLevel } from "./notify";

/** Resolve a user id from an actor string (username or email), or null. */
async function userIdForActor(actor?: string | null): Promise<string | null> {
  const a = (actor ?? "").trim().toLowerCase();
  if (!a || a === "system") return null;
  const u = await prisma.user.findFirst({ where: { OR: [{ username: a }, { email: a }] }, select: { id: true } });
  return u?.id ?? null;
}

function safe<T extends unknown[]>(fn: (...args: T) => Promise<unknown>) {
  return async (...args: T): Promise<void> => {
    try { await fn(...args); } catch (e) { console.error("[notify] emit failed", e); }
  };
}

/**
 * A background job reached a terminal state. Notifies the job's creator and all
 * ADMINs; the level reflects success vs. attention-needed. Collapses by job id.
 */
export const notifyJobFinished = safe(async (input: {
  module: string;        // e.g. "PDF Rename"
  jobId: string;
  status: string;        // completed | partial | failed | stopped
  actor?: string;        // creator (username/email)
  link: string;          // where to go to see it
  summary?: string;      // e.g. "120 renamed, 3 need review"
}) => {
  const creatorId = await userIdForActor(input.actor);
  const level: NotificationLevel = input.status === "completed" ? "success" : input.status === "failed" ? "error" : "warning";
  const verb = input.status === "completed" ? "completed" : input.status === "failed" ? "failed" : input.status === "stopped" ? "was stopped" : "finished with items to review";
  const scope: NotificationScope = { roles: ["ADMIN"], userIds: creatorId ? [creatorId] : undefined };
  await createNotification({
    category: "job",
    level,
    title: `${input.module} job ${verb}`,
    body: input.summary ?? "",
    link: input.link,
    entityType: "job",
    entityId: input.jobId,
    groupKey: `job:${input.jobId}`,
    actor: input.actor ?? "system",
    scope,
  });
});

/**
 * An automation / background process raised an error. Notifies users who can see
 * the monitoring surface (SYSTEM_MONITOR → ADMIN). Collapses by source+entity.
 */
export const notifyAutomationError = safe(async (input: {
  source: string;        // e.g. "PDF Rename"
  message: string;
  link?: string;
  entityType?: string;
  entityId?: string;
}) => {
  await createNotification({
    category: "automation",
    level: "error",
    title: `${input.source}: process error`,
    body: input.message.slice(0, 300),
    link: input.link ?? "/control-center",
    entityType: input.entityType ?? "error",
    entityId: input.entityId ?? "",
    groupKey: `automation-error:${input.source}:${input.entityId ?? ""}`,
    actor: "system",
    scope: { permission: PERMISSIONS.SYSTEM_MONITOR },
  });
});

/**
 * A review-queue ticket changed (created / disposed). Notifies users who work the
 * queue (REVIEW_READ) plus ADMINs. Collapses by ticket id so repeated updates
 * refresh one item.
 */
export const notifyReviewUpdate = safe(async (input: {
  ticketId: string;
  module: string;
  state: "pending" | "resolved" | "rejected";
  reason?: string;
  actor?: string;
}) => {
  const level: NotificationLevel = input.state === "pending" ? "warning" : "info";
  const title = input.state === "pending"
    ? `Review pending — ${input.module}`
    : `Review ${input.state} — ${input.module}`;
  await createNotification({
    category: "review",
    level,
    title,
    body: input.reason ?? "",
    link: "/review",
    entityType: "review",
    entityId: input.ticketId,
    groupKey: `review:${input.ticketId}`,
    actor: input.actor ?? "system",
    // Reviewers (and admins) see review items; exclude the actor who just acted.
    scope: { permission: PERMISSIONS.REVIEW_READ, roles: ["ADMIN"] },
    excludeUserId: await userIdForActor(input.actor) ?? undefined,
  });
});

/**
 * An admin-authored system announcement / alert. Scope is chosen by the admin
 * (everyone, a role, or a permission). Never collapsed.
 */
export const emitAnnouncement = async (input: {
  title: string;
  body?: string;
  link?: string;
  level?: NotificationLevel;
  scope: NotificationScope;
  actor?: string;
}) => {
  return createNotification({
    category: "announcement",
    level: input.level ?? "info",
    title: input.title,
    body: input.body ?? "",
    link: input.link ?? "",
    entityType: "announcement",
    scope: input.scope,
    actor: input.actor ?? "system",
  });
};
