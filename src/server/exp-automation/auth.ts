import type { Page } from "playwright";
import { env } from "@/lib/env";
import { getExpPage } from "./browser";
import { getExpCredentials } from "./credentials";

/**
 * Bangladesh Bank EXP portal authentication (Oracle APEX, app 112).
 *
 *   1. navigate to the login entry URL,
 *   2. reuse an existing authenticated session when the persistent profile has one,
 *   3. otherwise fill username/password from server-side env and submit the LOGIN form,
 *   4. verify success with a real authenticated-page indicator (Logout + Transaction menu),
 *   5. never bypass CAPTCHA / OTP / lockout — detect and report, pausing for the operator.
 *
 * Credentials are read ONLY from env and never logged, returned, or written to
 * disk. Submitting the LOGIN form is the one authorised "submit" in this module
 * (it signs in); the correction/duplicate data forms are never submitted.
 */

export type AuthOutcome =
  | "AUTHENTICATED"
  | "LOGIN_FAILED"
  | "VERIFICATION_REQUIRED"
  | "CONFIG_MISSING";

export interface AuthResult {
  outcome: AuthOutcome;
  message: string;
}

// APEX login item ids vary by page number; try the common ones + label-anchored.
const USERNAME_SELECTORS = ["#P101_USERNAME", "#P9999_USERNAME", "input[name='p_t01']", "input[id$='_USERNAME']", "input[type='text'][id*='USER' i]"];
const PASSWORD_SELECTORS = ["#P101_PASSWORD", "#P9999_PASSWORD", "input[name='p_t02']", "input[id$='_PASSWORD']", "input[type='password']"];
const LOGIN_BUTTON_SELECTORS = ["#P101_LOGIN", "button:has-text('Login')", "a:has-text('Login')", "input[value='Login' i]", "button:has-text('Sign In')"];

async function firstVisible(page: Page, selectors: string[]): Promise<string | null> {
  for (const sel of selectors) {
    try {
      if (await page.locator(sel).first().isVisible({ timeout: 800 })) return sel;
    } catch {
      /* try next */
    }
  }
  return null;
}

async function hasVisibleText(page: Page, re: RegExp): Promise<boolean> {
  try {
    const body = (await page.content()).replace(/<[^>]+>/g, " ");
    return re.test(body);
  } catch {
    return false;
  }
}

/** True once we are on an authenticated EXP page (Logout present, no password box). */
export async function isAuthenticated(page: Page): Promise<boolean> {
  if (!/exp\.bb\.org\.bd/i.test(page.url())) return false;
  const pwd = await firstVisible(page, ["input[type='password']"]);
  if (pwd) return false;
  // The authenticated shell shows a Logout link and the Transaction menu.
  const logout = await page.locator("a:has-text('Logout'), a:has-text('Log out')").first().isVisible({ timeout: 800 }).catch(() => false);
  const menu = await page.locator("a:has-text('Transaction')").first().isVisible({ timeout: 800 }).catch(() => false);
  return logout || menu;
}

async function detectVerification(page: Page): Promise<string | null> {
  const body = (await page.content().catch(() => "")).toLowerCase();
  if (/recaptcha|hcaptcha|g-recaptcha|captcha|are you human/.test(body)) return "A CAPTCHA challenge is shown.";
  if (/one-time (pass)?code|verification code|\botp\b|two-factor|multi-factor/.test(body)) return "A one-time-code / MFA step is shown.";
  if (/account.*(locked|disabled)|too many (login|attempts)/.test(body)) return "The account appears locked / rate-limited.";
  return null;
}

async function readLoginError(page: Page): Promise<string> {
  const candidates = [".t-Alert--danger", ".a-Notification--error", "#P101_LOGIN_ERROR", ".apex-page-error", ".uMessageRegion", "#notification_message"];
  for (const sel of candidates) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 500 })) {
        const t = (await el.innerText()).replace(/\s+/g, " ").trim();
        if (t) return t.slice(0, 200);
      }
    } catch {
      /* ignore */
    }
  }
  return "";
}

export async function ensureExpAuth(): Promise<AuthResult> {
  const page = await getExpPage();

  if (!/exp\.bb\.org\.bd/i.test(page.url())) {
    await page.goto(env.EXP_PORTAL_URL, { waitUntil: "domcontentloaded" }).catch(() => undefined);
  }
  await page.waitForLoadState("domcontentloaded").catch(() => undefined);

  if (await isAuthenticated(page)) return { outcome: "AUTHENTICATED", message: "Existing EXP session reused." };

  const verif = await detectVerification(page);
  if (verif) return { outcome: "VERIFICATION_REQUIRED", message: `${verif} Complete it in the visible browser; the run resumes once the session is valid.` };

  const userSel = await firstVisible(page, USERNAME_SELECTORS);
  const passSel = await firstVisible(page, PASSWORD_SELECTORS);
  if (!userSel || !passSel) {
    // Maybe we need to navigate to the login page explicitly.
    await page.goto(env.EXP_PORTAL_URL, { waitUntil: "domcontentloaded" }).catch(() => undefined);
    const u2 = await firstVisible(page, USERNAME_SELECTORS);
    const p2 = await firstVisible(page, PASSWORD_SELECTORS);
    if (!u2 || !p2) {
      if (await isAuthenticated(page)) return { outcome: "AUTHENTICATED", message: "Existing EXP session reused." };
      return { outcome: "VERIFICATION_REQUIRED", message: "The EXP login form was not found. Open the visible browser, sign in manually; the run resumes once a session is valid." };
    }
  }

  const creds = await getExpCredentials();
  if (!creds) {
    return { outcome: "CONFIG_MISSING", message: "EXP portal credentials are not configured. Set them in EXP Automation → Credentials." };
  }

  const u = (await firstVisible(page, USERNAME_SELECTORS))!;
  const p = (await firstVisible(page, PASSWORD_SELECTORS))!;
  await page.fill(u, creds.username);
  await page.fill(p, creds.password);
  const btn = await firstVisible(page, LOGIN_BUTTON_SELECTORS);
  await Promise.all([
    page.waitForLoadState("networkidle").catch(() => undefined),
    btn ? page.click(btn) : page.press(p, "Enter"),
  ]);
  await page.waitForLoadState("domcontentloaded").catch(() => undefined);
  await page.waitForTimeout(1500);

  if (await isAuthenticated(page)) return { outcome: "AUTHENTICATED", message: "Logged in to the EXP portal." };

  const verifAfter = await detectVerification(page);
  if (verifAfter) return { outcome: "VERIFICATION_REQUIRED", message: `${verifAfter} Complete it in the visible browser; the run resumes once the session is valid.` };

  const err = await readLoginError(page);
  const changePw = await hasVisibleText(page, /change.*password|password.*expired|new password/i);
  if (changePw) return { outcome: "VERIFICATION_REQUIRED", message: "The portal is requesting a password change. Complete it in the visible browser; the run resumes once a session is valid." };
  return { outcome: "LOGIN_FAILED", message: err ? `Portal rejected the login: ${err}` : "Login did not reach an authenticated page. Check the credentials / portal in the visible browser." };
}
