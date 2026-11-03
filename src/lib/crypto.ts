import "server-only";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";
import { env } from "./env";

/**
 * Symmetric encryption for secrets at rest (portal passwords stored in the DB).
 *
 * AES-256-GCM with a fresh random 96-bit IV per value. The stored blob is
 * `base64( iv(12) || authTag(16) || ciphertext )`. The key is derived with
 * scrypt from EXP_CRED_KEY when configured (recommended on prod), otherwise from
 * AUTH_SECRET, with a fixed application salt — so a value encrypted on one boot
 * decrypts on the next as long as that key material is unchanged.
 *
 * Plaintext secrets never leave this module except via decryptSecret(); the
 * ciphertext is the only form that is logged, returned, or written to disk.
 */

const KEY_SALT = "aucp.portal-credential.v1";
let cachedKey: Buffer | null = null;

function key(): Buffer {
  if (cachedKey) return cachedKey;
  const material = env.EXP_CRED_KEY && env.EXP_CRED_KEY.length >= 16 ? env.EXP_CRED_KEY : env.AUTH_SECRET;
  cachedKey = scryptSync(material, KEY_SALT, 32);
  return cachedKey;
}

/** Encrypt a UTF-8 secret to the base64 GCM blob described above. */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString("base64");
}

/** Decrypt a blob produced by encryptSecret(). Throws on tampering / wrong key. */
export function decryptSecret(blob: string): string {
  const raw = Buffer.from(blob, "base64");
  if (raw.length < 28) throw new Error("ciphertext too short");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ct = raw.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

/** True when a blob decrypts cleanly with the current key (non-throwing probe). */
export function canDecrypt(blob: string): boolean {
  try {
    return decryptSecret(blob).length >= 0;
  } catch {
    return false;
  }
}
