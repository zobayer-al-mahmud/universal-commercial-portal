import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { isInvalidCredentialError } from "@/server/exp-automation/auth";
import {
  readExpAuthLock,
  isExpAuthLocked,
  lockExpAuth,
  clearExpAuthLock,
  __resetExpAuthLockCache,
} from "@/server/exp-automation/auth-lock";

/**
 * EXP (Bangladesh Bank) wrong-password handling:
 *  - a portal login-error is classified as a credential rejection, and
 *  - the durable sign-in lock latches, exposes its state, and clears cleanly.
 */

describe("isInvalidCredentialError", () => {
  it("flags real portal wrong-credential messages", () => {
    for (const s of [
      "Invalid Login Credentials",
      "Invalid username or password",
      "Incorrect password",
      "Authentication failed",
      "Login failed. Please try again.",
      "Wrong password",
      "The password is incorrect",
      "User does not exist",
    ]) {
      expect(isInvalidCredentialError(s)).toBe(true);
    }
  });

  it("does not flag non-credential / transient noise", () => {
    for (const s of [
      "Session timed out",
      "Service temporarily unavailable",
      "Please complete the CAPTCHA",
      "Your session has expired",
      "",
    ]) {
      expect(isInvalidCredentialError(s)).toBe(false);
    }
  });
});

describe("exp auth lock (durable latch)", () => {
  beforeEach(async () => {
    __resetExpAuthLockCache();
    await clearExpAuthLock();
  });
  afterEach(async () => {
    await clearExpAuthLock();
  });

  it("starts unlocked", async () => {
    expect(await isExpAuthLocked()).toBe(false);
    const l = await readExpAuthLock();
    expect(l.locked).toBe(false);
    expect(l.jobIds).toEqual([]);
  });

  it("latches with reason + username + job ids, never a password", async () => {
    const lock = await lockExpAuth({ reason: "rejected", username: "ADSUSER", jobIds: ["j1", "j2"] });
    expect(lock.locked).toBe(true);
    expect(lock.username).toBe("ADSUSER");
    expect(lock.at).toBeTruthy();
    expect(new Set(lock.jobIds)).toEqual(new Set(["j1", "j2"]));
    expect(JSON.stringify(lock)).not.toMatch(/password/i);
    expect(await isExpAuthLocked()).toBe(true);
  });

  it("accumulates job ids and keeps the first timestamp across repeated signals", async () => {
    const first = await lockExpAuth({ reason: "rejected", jobIds: ["j1"] });
    const second = await lockExpAuth({ reason: "rejected again", jobIds: ["j2"] });
    expect(new Set(second.jobIds)).toEqual(new Set(["j1", "j2"]));
    expect(second.at).toBe(first.at); // first lock wins its timestamp
  });

  it("clears back to unlocked", async () => {
    await lockExpAuth({ reason: "rejected", jobIds: ["j1"] });
    await clearExpAuthLock();
    expect(await isExpAuthLocked()).toBe(false);
    expect((await readExpAuthLock()).jobIds).toEqual([]);
  });
});
