import type { Page } from "playwright";
import { env } from "@/lib/env";
import { getDamcoPage } from "./damco-browser";

/**
 * Damco Shipper Portal authentication.
 *
 * The portal federates to an ADFS form (auth.damco.com/adfs/ls). This service:
 *   1. navigates to the authorised entry URL,
 *   2. reuses an existing authenticated session when the persistent profile
 *      still has one,
 *   3. otherwise fills the username/password from server-side env and submits,
 *   4. verifies success with a real authenticated-page indicator,
 *   5. never bypasses CAPTCHA/MFA/block pages — it detects and reports them.
 *
 * Credentials are read only from env and are never logged, returned, or written
 * to screenshots. Only non-secret status strings leave this module.
 */

export type AuthOutcome =
  | "AUTHENTICATED" // a valid authenticated session is active
  | "LOGIN_FAILED" // credentials rejected / portal error
  | "VERIFICATION_REQUIRED" // CAPTCHA / MFA / other human step — paused, not bypassed
  | "CONFIG_MISSING"; // credentials not configured

export interface AuthResult {
  outcome: AuthOutcome;
  message: string;
}

const LOGIN_HOST = /auth\.damco\.com|adfs|login|logon|signin/i;
const SEL = {
  username: "#ctl00_ContentPlaceHolder1_UsernameTextBox",
  password: "#ctl00_ContentPlaceHolder1_PasswordTextBox",
  submit: "#ctl00_ContentPlaceHolder1_SubmitButton",
};

function onLoginPage(page: Page): boolean {
  return LOGIN_HOST.test(page.url());
}

async function hasVisible(page: Page, selector: string): Promise<boolean> {
  try {
    return await page.locator(selector).first().isVisible({ timeout: 1500 });
  } catch {
    return false;
  }
}

/** True once the browser is on a Damco page that is NOT the login form. */
async function isAuthenticated(page: Page): Promise<boolean> {
  if (!/booking\.damco\.com/i.test(page.url())) return false;
  if (onLoginPage(page)) return false;
  return !(await hasVisible(page, SEL.password));
}

async function detectVerification(page: Page): Promise<string | null> {
  const body = (await page.content()).toLowerCase();
  if (/recaptcha|hcaptcha|g-recaptcha|captcha|cf-challenge|are you human/.test(body)) return "A CAPTCHA / anti-bot challenge is shown.";
  if (/one-time (pass)?code|verification code|authenticator app|\botp\b|two-factor|multi-factor/.test(body)) return "A one-time-code / MFA step is shown.";
  return null;
}

/** Non-secret summary of a visible login error, if any. */
async function readLoginError(page: Page): Promise<string> {
  const candidates = ["#errorText", ".error", ".fieldMargin.error", "#ctl00_ContentPlaceHolder1_ErrorTextLabel"];
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

export async function ensureAuthenticated(): Promise<AuthResult> {
  const page = await getDamcoPage();

  if (!/booking\.damco\.com|auth\.damco\.com/i.test(page.url())) {
    await page.goto(env.DAMCO_PORTAL_URL, { waitUntil: "domcontentloaded" }).catch(() => undefined);
  }
  await page.waitForLoadState("domcontentloaded").catch(() => undefined);

  if (await isAuthenticated(page)) return { outcome: "AUTHENTICATED", message: "Existing Damco session reused." };

  const verif = await detectVerification(page);
  if (verif) return { outcome: "VERIFICATION_REQUIRED", message: `${verif} Complete it in the visible browser; the run will resume once the session is valid.` };

  if (!onLoginPage(page) || !(await hasVisible(page, SEL.username))) {
    return { outcome: "VERIFICATION_REQUIRED", message: "The portal did not present the expected login form. Check the visible browser and sign in; the run will resume once the session is valid." };
  }

  if (!env.DAMCO_USERNAME || !env.DAMCO_PASSWORD) {
    return { outcome: "CONFIG_MISSING", message: "DAMCO_USERNAME / DAMCO_PASSWORD are not configured on the server." };
  }

  // Fill + submit the real login form. Values come only from env.
  await page.fill(SEL.username, env.DAMCO_USERNAME);
  await page.fill(SEL.password, env.DAMCO_PASSWORD);
  await Promise.all([
    page.waitForLoadState("networkidle").catch(() => undefined),
    page.click(SEL.submit),
  ]);
  await page.waitForLoadState("domcontentloaded").catch(() => undefined);
  await page.waitForTimeout(1500);

  if (await isAuthenticated(page)) return { outcome: "AUTHENTICATED", message: "Logged in to the Damco portal." };

  const verifAfter = await detectVerification(page);
  if (verifAfter) return { outcome: "VERIFICATION_REQUIRED", message: `${verifAfter} Complete it in the visible browser; the run will resume once the session is valid.` };

  const err = await readLoginError(page);
  return { outcome: "LOGIN_FAILED", message: err ? `Portal rejected the login: ${err}` : "Login did not reach an authenticated page. The portal may have rejected the credentials or changed its login flow." };
}
