import "server-only";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { audit } from "@/lib/audit";
import { encryptSecret, decryptSecret } from "@/lib/crypto";
import { isKnownFactory } from "./factories";

/**
 * Per-FACTORY BGMEA portal credential store.
 *
 * Credentials are isolated by factory and never shared. The preferred source is
 * the encrypted DB store (PortalCredential, portal = "bgmea:<factoryId>",
 * AES-256-GCM at rest — src/lib/crypto.ts), managed from the UI so a password can
 * be rotated without a redeploy. A per-factory `.env` pair is a DEV fallback.
 *
 * The plaintext password is NEVER logged, returned to the client, or written to
 * disk. Credentials shared in chat must be rotated and are never used here.
 */

function portalKey(factoryId: string): string {
  return `bgmea:${factoryId}`;
}

interface EnvCreds {
  username: string;
  password: string;
}

/** DEV fallback: per-factory env pair, by stable factory id (never display name). */
function envCredsFor(factoryId: string): EnvCreds {
  switch (factoryId) {
    case "1095":
      return { username: env.BGMEA_1095_USERNAME ?? "", password: env.BGMEA_1095_PASSWORD ?? "" };
    case "4148":
      return { username: env.BGMEA_4148_USERNAME ?? "", password: env.BGMEA_4148_PASSWORD ?? "" };
    case "4149":
      return { username: env.BGMEA_4149_USERNAME ?? "", password: env.BGMEA_4149_PASSWORD ?? "" };
    case "2966":
      return { username: env.BGMEA_2966_USERNAME ?? "", password: env.BGMEA_2966_PASSWORD ?? "" };
    default:
      return { username: "", password: "" };
  }
}

export interface BgmeaCredentials {
  username: string;
  password: string;
}

export interface BgmeaCredentialStatus {
  factoryId: string;
  configured: boolean;
  source: "store" | "env" | "none";
  /** Safe to display — NEVER the password. */
  username: string;
  updatedAt: string | null;
  updatedBy: string | null;
}

/** Resolve the live credentials for a factory: DB store first, then env. */
export async function getBgmeaCredentials(factoryId: string): Promise<BgmeaCredentials | null> {
  if (!isKnownFactory(factoryId)) return null;
  const row = await prisma.portalCredential.findUnique({ where: { portal: portalKey(factoryId) } }).catch(() => null);
  if (row && row.username && row.secretEnc) {
    try {
      const password = decryptSecret(row.secretEnc);
      if (password) return { username: row.username, password };
    } catch {
      /* corrupt/old key — fall through to env so a run can still proceed */
    }
  }
  const envc = envCredsFor(factoryId);
  if (envc.username && envc.password) return envc;
  return null;
}

/** Status for the UI (never returns the password). */
export async function getBgmeaCredentialStatus(factoryId: string): Promise<BgmeaCredentialStatus> {
  const base: BgmeaCredentialStatus = { factoryId, configured: false, source: "none", username: "", updatedAt: null, updatedBy: null };
  if (!isKnownFactory(factoryId)) return base;
  const row = await prisma.portalCredential.findUnique({ where: { portal: portalKey(factoryId) } }).catch(() => null);
  if (row && row.username && row.secretEnc) {
    let ok = false;
    try {
      ok = decryptSecret(row.secretEnc).length > 0;
    } catch {
      ok = false;
    }
    if (ok) {
      return { factoryId, configured: true, source: "store", username: row.username, updatedAt: row.updatedAt.toISOString(), updatedBy: row.updatedBy || null };
    }
  }
  const envc = envCredsFor(factoryId);
  if (envc.username && envc.password) {
    return { ...base, configured: true, source: "env", username: envc.username };
  }
  return { ...base, username: row?.username ?? envc.username ?? "" };
}

/** Save/replace one factory's BGMEA credentials (encrypted). Password never stored plaintext. */
export async function saveBgmeaCredentials(input: { factoryId: string; username: string; password: string; actor: string }): Promise<{ ok: boolean; message: string }> {
  if (!isKnownFactory(input.factoryId)) return { ok: false, message: "Unknown factory." };
  const username = input.username.trim();
  const password = input.password; // not trimmed — a portal password may contain spaces
  if (!username) return { ok: false, message: "Username is required." };
  if (!password) return { ok: false, message: "Password is required." };

  const secretEnc = encryptSecret(password);
  await prisma.portalCredential.upsert({
    where: { portal: portalKey(input.factoryId) },
    create: { portal: portalKey(input.factoryId), username, secretEnc, updatedBy: input.actor },
    update: { username, secretEnc, updatedBy: input.actor },
  });
  // Audit WITHOUT the password (username + factory only).
  await audit({ entityType: "integration", entityId: `credential:${portalKey(input.factoryId)}`, action: "ud.credentials.updated", actor: input.actor, data: { factoryId: input.factoryId, username } });
  return { ok: true, message: "BGMEA credentials saved for this factory." };
}
