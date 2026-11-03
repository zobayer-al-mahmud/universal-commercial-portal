import "server-only";
import { rm } from "fs/promises";
import { resolve } from "path";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { audit } from "@/lib/audit";
import { encryptSecret, decryptSecret } from "@/lib/crypto";
import { shutdownExpBrowser } from "./browser";

/**
 * EXP (Bangladesh Bank) portal credential store.
 *
 * The username + password are managed from the UCP frontend (Admin / Commercial)
 * and stored ENCRYPTED at rest (AES-256-GCM, see src/lib/crypto.ts). The live
 * driver reads them here; the plaintext password is never logged, returned to the
 * client, or written to disk. `.env` (EXP_USERNAME/EXP_PASSWORD) is a fallback so
 * an existing deployment keeps working until credentials are saved in the UI.
 */

const PORTAL = "exp";

export interface ExpCredentials {
  username: string;
  password: string;
}

export interface ExpCredentialStatus {
  /** A usable username + password exists (store or env). */
  configured: boolean;
  /** Where the live creds come from right now. */
  source: "store" | "env" | "none";
  /** Safe to display — NEVER the password. */
  username: string;
  updatedAt: string | null;
  updatedBy: string | null;
}

/** Resolve the live credentials: DB store first (decrypted), then .env fallback. */
export async function getExpCredentials(): Promise<ExpCredentials | null> {
  const row = await prisma.portalCredential.findUnique({ where: { portal: PORTAL } }).catch(() => null);
  if (row && row.username && row.secretEnc) {
    try {
      const password = decryptSecret(row.secretEnc);
      if (password) return { username: row.username, password };
    } catch {
      /* corrupt/old key — fall through to env so a run can still proceed */
    }
  }
  if (env.EXP_USERNAME && env.EXP_PASSWORD) return { username: env.EXP_USERNAME, password: env.EXP_PASSWORD };
  return null;
}

/** Status for the UI. NEVER returns the password. */
export async function getExpCredentialStatus(): Promise<ExpCredentialStatus> {
  const row = await prisma.portalCredential.findUnique({ where: { portal: PORTAL } }).catch(() => null);
  if (row && row.username && row.secretEnc) {
    let ok = false;
    try {
      ok = decryptSecret(row.secretEnc).length > 0;
    } catch {
      ok = false;
    }
    if (ok) {
      return {
        configured: true,
        source: "store",
        username: row.username,
        updatedAt: row.updatedAt.toISOString(),
        updatedBy: row.updatedBy || null,
      };
    }
  }
  if (env.EXP_USERNAME && env.EXP_PASSWORD) {
    return { configured: true, source: "env", username: env.EXP_USERNAME, updatedAt: null, updatedBy: null };
  }
  return { configured: false, source: "none", username: row?.username ?? env.EXP_USERNAME ?? "", updatedAt: null, updatedBy: null };
}

/**
 * Save / replace the EXP portal credentials (encrypted) and force the next run to
 * sign in with them: the running browser is terminated and its persistent profile
 * wiped, so a stale authenticated session can never mask a changed password.
 */
export async function saveExpCredentials(input: { username: string; password: string; actor: string }): Promise<{ ok: boolean; message: string }> {
  const username = input.username.trim();
  const password = input.password; // not trimmed — a portal password may contain spaces
  if (!username) return { ok: false, message: "Username is required." };
  if (!password) return { ok: false, message: "Password is required." };

  const secretEnc = encryptSecret(password);
  await prisma.portalCredential.upsert({
    where: { portal: PORTAL },
    create: { portal: PORTAL, username, secretEnc, updatedBy: input.actor },
    update: { username, secretEnc, updatedBy: input.actor },
  });

  // Invalidate any live session so the new password is actually exercised.
  await shutdownExpBrowser().catch(() => undefined);
  await clearExpProfile().catch(() => undefined);

  // Audit the change WITHOUT the password (username only).
  await audit({ entityType: "exp", entityId: `credential:${PORTAL}`, action: "exp.credentials.updated", actor: input.actor, data: { username } });
  return { ok: true, message: "EXP credentials saved. The next run signs in with the new password." };
}

/** Best-effort wipe of the persistent browser profile so no old session is reused. */
async function clearExpProfile(): Promise<void> {
  const dir = resolve(env.EXP_SESSION_DIR, "profile");
  // The process was just killed; give the OS a moment to release file locks, then
  // remove the profile. Best-effort (a surviving session is still re-verified by
  // ensureExpAuth, which will re-login when the saved cookies no longer authorise).
  for (let i = 0; i < 3; i++) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}
