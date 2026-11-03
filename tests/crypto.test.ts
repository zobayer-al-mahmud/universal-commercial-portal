import { describe, it, expect } from "vitest";
import { encryptSecret, decryptSecret, canDecrypt } from "@/lib/crypto";

/**
 * Secrets-at-rest encryption used by the portal credential store. Verifies a
 * clean round-trip, that each ciphertext is unique (random IV), and that tampered
 * or foreign blobs fail closed instead of returning garbage.
 */
describe("crypto — encryptSecret / decryptSecret", () => {
  it("round-trips arbitrary secrets", () => {
    for (const s of ["000000", "p@ss word with spaces", "unicode ✓ ñ 密码", "a".repeat(500)]) {
      expect(decryptSecret(encryptSecret(s))).toBe(s);
    }
  });

  it("produces a different ciphertext each time (random IV)", () => {
    const a = encryptSecret("same-secret");
    const b = encryptSecret("same-secret");
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe("same-secret");
    expect(decryptSecret(b)).toBe("same-secret");
  });

  it("fails closed on a tampered or non-credential blob", () => {
    const enc = encryptSecret("secret");
    const tampered = enc.slice(0, -4) + (enc.endsWith("AAAA") ? "BBBB" : "AAAA");
    expect(canDecrypt(tampered)).toBe(false);
    expect(() => decryptSecret(tampered)).toThrow();
    expect(canDecrypt("not-base64-or-ours")).toBe(false);
    expect(canDecrypt(enc)).toBe(true);
  });
});
