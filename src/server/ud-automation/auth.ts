import "server-only";
import type { Page } from "playwright";
import { env } from "@/lib/env";
import { getBgmeaPage } from "./browser";
import { getBgmeaCredentials } from "./credentials";
import { assertSafeToClickUd } from "./guards";
import { FACTORIES } from "./factories";
import { BGMEA_LOGIN } from "./selectors";

/**
 * Factory-isolated BGMEA sign-in.
 *
 * The BGMEA browser keeps ONE persistent profile, so a session left signed in as one
 * factory must never be reused for another. Every run therefore:
 *   1. reads which factory the portal is currently signed in as (the home page shows
 *      "<membership id> - <factory name>");
 *   2. if it is a different factory, clears the portal cookies (signs out) first;
 *   3. signs in with THIS factory's own stored credentials (encrypted store or the
 *      server-side .env — never the client, never logs);
 *   4. re-verifies the signed-in factory; any mismatch fails closed.
 *
 * CAPTCHA / OTP / other challenges are never bypassed: the run stops with
 * `needsManual` so the operator can complete it in the visible browser window.
 */

export interface AuthResult {
  ok: boolean;
  message: string;
  /** True when the operator must complete a CAPTCHA/OTP/security challenge in the window. */
  needsManual?: boolean;
}

export function portalOrigin(): string {
  try {
    return new URL(env.BGMEA_PORTAL_URL).origin;
  } catch {
    return "https://bgmea.org";
  }
}

function onLoginPage(page: Page): boolean {
  return page.url().toLowerCase().includes(BGMEA_LOGIN.loginPathFragment.toLowerCase());
}

// Visible challenge widgets only. NOTE: the login form always carries a HIDDEN
// `__RequestVerificationToken` (ASP.NET anti-forgery) — that is not a challenge.
const CHALLENGE_SELECTOR =
  '.g-recaptcha, iframe[src*="recaptcha" i], iframe[src*="hcaptcha" i], iframe[src*="turnstile" i], [class*="captcha" i], input[name*="otp" i]:not([type=hidden]), input[id*="otp" i]:not([type=hidden]), input[name*="verificationcode" i]:not([type=hidden])';

async function hasChallenge(page: Page): Promise<boolean> {
  return page
    .locator(CHALLENGE_SELECTOR)
    .evaluateAll((els) => els.some((e) => (e as HTMLElement).offsetParent !== null || e.tagName === "IFRAME"))
    .catch(() => false);
}

/**
 * Which known factory is the portal signed in as? Reads the home page banner
 * ("1095 - ABM FASHIONS LTD.") — returns the factory id or null when unknown.
 */
export async function signedInFactory(page: Page): Promise<string | null> {
  const text = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
  for (const f of FACTORIES) {
    if (new RegExp(`(^|\\s)${f.id}\\s*-\\s*\\S`).test(text)) return f.id;
  }
  return null;
}

async function signOut(page: Page): Promise<void> {
  // Clearing the portal cookies ends the server session for this browser profile.
  await page.context().clearCookies().catch(() => undefined);
}

export async function ensureBgmeaAuth(factoryId: string): Promise<AuthResult> {
  const creds = await getBgmeaCredentials(factoryId);
  if (!creds) return { ok: false, message: `No BGMEA credentials are configured for factory ${factoryId}. An admin must add them (encrypted store or server .env).` };

  const page = await getBgmeaPage();
  const home = `${portalOrigin()}/`;

  await page.goto(home, { waitUntil: "domcontentloaded" }).catch(() => undefined);
  if (!onLoginPage(page)) {
    const current = await signedInFactory(page);
    if (current === factoryId) return { ok: true, message: `Signed in as factory ${factoryId}.` };
    // Signed in as another factory (or unknown) → sign out before using this factory's account.
    await signOut(page);
    await page.goto(env.BGMEA_PORTAL_URL, { waitUntil: "domcontentloaded" }).catch(() => undefined);
    if (!onLoginPage(page)) {
      return { ok: false, message: "Could not end the previous BGMEA session to switch factory. Nothing was read or written." };
    }
  }

  if (await hasChallenge(page)) {
    return { ok: false, needsManual: true, message: "BGMEA is showing a CAPTCHA / verification challenge. Complete it in the BGMEA browser window, then retry." };
  }

  try {
    await page.fill(BGMEA_LOGIN.usernameSelector, creds.username);
    await page.fill(BGMEA_LOGIN.passwordSelector, creds.password);
    const submit = page.locator(BGMEA_LOGIN.submitSelector).first();
    await assertSafeToClickUd(submit, "login");
    await Promise.all([page.waitForLoadState("domcontentloaded").catch(() => undefined), submit.click()]);
    await page.waitForTimeout(800);
  } catch (e) {
    // Never echo the exception verbatim if it could contain typed input; Playwright errors carry selectors only.
    return { ok: false, message: `BGMEA sign-in step failed: ${e instanceof Error ? e.message.split("\n")[0] : "unknown error"}` };
  }

  if (onLoginPage(page)) {
    if (await hasChallenge(page)) return { ok: false, needsManual: true, message: "A CAPTCHA / verification step appeared during BGMEA sign-in. Complete it in the BGMEA browser window, then retry." };
    return { ok: false, message: `BGMEA rejected the sign-in for factory ${factoryId} (check that factory's stored credentials).` };
  }

  await page.goto(home, { waitUntil: "domcontentloaded" }).catch(() => undefined);
  const now = await signedInFactory(page);
  if (now !== factoryId) {
    await signOut(page);
    return { ok: false, message: `The BGMEA account signed in does not belong to factory ${factoryId}${now ? ` (it is ${now})` : ""}. Signed out; nothing was read or written.` };
  }
  return { ok: true, message: `Signed in as factory ${factoryId}.` };
}
