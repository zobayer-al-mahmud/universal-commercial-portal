import "server-only";
import { mkdir, readFile, writeFile, rm } from "fs/promises";
import { dirname, resolve } from "path";
import { env } from "@/lib/env";

/**
 * Global, DURABLE "EXP sign-in locked" latch for the Bangladesh Bank EXP portal.
 *
 * When the portal REJECTS the saved password (wrong credentials — not a network
 * blip, not a session expiry, not a CAPTCHA/MFA step), the batch engine latches
 * this lock. While it is set:
 *   - no EXP automation run may start or continue (the bad password is NEVER
 *     retried — see batch.ts guards + the runQueue loop check), and
 *   - the operator is told to update the password and then Verify & Resume.
 *
 * It is file-backed (under EXP_SESSION_DIR, which survives the profile wipe that a
 * credential change performs) so the latch also survives a server restart — a
 * stopped-for-bad-password batch must never silently restart. An in-memory cache
 * fronts the file for cheap reads on the hot path.
 *
 * It NEVER stores the password (only the username, for display) — same discipline
 * as credentials.ts.
 */

export interface ExpAuthLock {
  locked: boolean;
  /** Human-readable reason (no secrets). */
  reason: string;
  /** ISO timestamp the lock was set, or null when unlocked. */
  at: string | null;
  /** The username the portal rejected (display only — NEVER the password). */
  username: string;
  /** EXP job ids that were stopped by this lock, so Verify & Resume can re-queue exactly them. */
  jobIds: string[];
}

const LOCK_PATH = resolve(env.EXP_SESSION_DIR, "auth-lock.json");
const UNLOCKED: ExpAuthLock = { locked: false, reason: "", at: null, username: "", jobIds: [] };

/** Operator-facing message shown wherever a locked run is refused. */
export const EXP_AUTH_LOCK_MESSAGE =
  "EXP automation is paused: Bangladesh Bank rejected the saved password. Update the password in UCP, then click “Verify sign-in & resume”.";

let cache: ExpAuthLock | null = null;

export async function readExpAuthLock(): Promise<ExpAuthLock> {
  if (cache) return cache;
  try {
    const raw = await readFile(LOCK_PATH, "utf8");
    const o = JSON.parse(raw) as Partial<ExpAuthLock>;
    cache = {
      locked: !!o.locked,
      reason: typeof o.reason === "string" ? o.reason : "",
      at: typeof o.at === "string" ? o.at : null,
      username: typeof o.username === "string" ? o.username : "",
      jobIds: Array.isArray(o.jobIds) ? o.jobIds.filter((x): x is string => typeof x === "string") : [],
    };
  } catch {
    cache = { ...UNLOCKED };
  }
  return cache;
}

export async function isExpAuthLocked(): Promise<boolean> {
  return (await readExpAuthLock()).locked;
}

/** Latch the lock (idempotent on reason/time — the FIRST lock wins its timestamp). */
export async function lockExpAuth(input: { reason: string; username?: string; jobIds?: string[] }): Promise<ExpAuthLock> {
  const prev = await readExpAuthLock();
  const lock: ExpAuthLock = {
    locked: true,
    reason: input.reason,
    at: prev.locked && prev.at ? prev.at : new Date().toISOString(),
    username: input.username ?? prev.username ?? "",
    // Accumulate job ids across repeated signals within one incident.
    jobIds: Array.from(new Set([...(prev.locked ? prev.jobIds : []), ...(input.jobIds ?? [])])),
  };
  cache = lock;
  try {
    await mkdir(dirname(LOCK_PATH), { recursive: true });
    await writeFile(LOCK_PATH, JSON.stringify(lock), "utf8");
  } catch {
    /* in-memory cache still enforces the lock for this process */
  }
  return lock;
}

/** Clear the lock (only ever called after a verified successful sign-in). */
export async function clearExpAuthLock(): Promise<void> {
  cache = { ...UNLOCKED };
  await rm(LOCK_PATH, { force: true }).catch(() => undefined);
}

/** Test helper: forget the in-memory cache so the next read hits the file. */
export function __resetExpAuthLockCache(): void {
  cache = null;
}
