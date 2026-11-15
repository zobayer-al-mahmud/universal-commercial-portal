import "server-only";
import type { Page } from "playwright";
import { env } from "@/lib/env";
import { getBgmeaPage } from "./browser";
import { getBgmeaCredentials } from "./credentials";
import { assertSafeToClickUd } from "./guards";
import { BGMEA_LOGIN } from "./selectors";

/**
 * Ensure the BGMEA portal is signed in for a factory, using that factory's stored
 * credentials (encrypted store or env). Login is the only authentication action —
 * it is never a UD submit. If a sign-in page shows a CAPTCHA/OTP, the driver PAUSES
 * for the operator to complete it in the visible window; it never bypasses it.
 *
 * Passwords are read here only to type into the portal's own form; they are never
 * logged or returned.
 */

export interface AuthResult {
  ok: boolean;
  message: string;
  /** True when the operator must complete a CAPTCHA/OTP in the window. */
  needsManual?: boolean;
}

function onLoginPage(page: Page): boolean {
  return page.url().includes(BGMEA_LOGIN.loginPathFragment);
}

export async function ensureBgmeaAuth(factoryId: string): Promise<AuthResult> {
  const creds = await getBgmeaCredentials(factoryId);
  if (!creds) return { ok: false, message: "No BGMEA credentials configured for this factory." };

  const page = await getBgmeaPage();

  // Visit the portal root; a valid session lands past the login page.
  await page.goto(env.BGMEA_PORTAL_URL, { waitUntil: "domcontentloaded" }).catch(() => undefined);
  if (!onLoginPage(page)) return { ok: true, message: "Already signed in." };

  // CAPTCHA / OTP present → never bypass; pause for the operator.
  const hasChallenge = await page
    .locator('.g-recaptcha, iframe[src*="recaptcha" i], [class*="captcha" i], input[name*="otp" i]')
    .count()
    .catch(() => 0);
  if (hasChallenge > 0) {
    return { ok: false, needsManual: true, message: "A CAPTCHA/OTP is shown. Complete it in the browser window, then retry." };
  }

  // Fill the login form and submit (login only).
  try {
    await page.fill(BGMEA_LOGIN.usernameSelector, creds.username);
    await page.fill(BGMEA_LOGIN.passwordSelector, creds.password);
    const submit = page.locator(BGMEA_LOGIN.submitSelector).first();
    await assertSafeToClickUd(submit, "login");
    await Promise.all([
      page.waitForLoadState("domcontentloaded").catch(() => undefined),
      submit.click(),
    ]);
  } catch (e) {
    return { ok: false, message: `Login step failed: ${e instanceof Error ? e.message : String(e)}` };
  }

  // Re-check: still on the login page ⇒ rejected (or a challenge appeared).
  if (onLoginPage(page)) {
    const challenge = await page.locator('.g-recaptcha, [class*="captcha" i], input[name*="otp" i]').count().catch(() => 0);
    if (challenge > 0) return { ok: false, needsManual: true, message: "A CAPTCHA/OTP appeared during sign-in. Complete it in the window and retry." };
    return { ok: false, message: "Sign-in was rejected (check the factory credentials)." };
  }
  return { ok: true, message: "Signed in." };
}
