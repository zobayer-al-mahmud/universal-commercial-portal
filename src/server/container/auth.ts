import type { Page } from "playwright";
import { env } from "@/lib/env";
import { getContainerPage } from "./browser";

/**
 * CTG Port (cpatos.gov.bd) Port Community System authentication.
 *
 * IMPORTANT: the container-location search is a PUBLIC form — it needs no login.
 * This module exists because the operator's workflow signs in first (an
 * authenticated session may expose richer records). It is therefore BEST-EFFORT:
 * when credentials are configured it signs in; a login failure does NOT abort
 * the public search (the caller decides).
 *
 * Real selectors, verified live 2026-10-24 against the PCS login modal:
 *   form[name=frmmodal]  → POST /pcs/index.php/login/
 *   #username  (name=username)   — "Type Your User ID"
 *   #password  (name=password)   — "Type Your Password"
 *   input[name=submit_login]     — the "Login" submit
 *
 * Credentials come ONLY from env; they are never logged, returned, or screenshot.
 * CAPTCHA / OTP / MFA are detected and reported, never bypassed.
 */

export type ContainerAuthOutcome =
  | "AUTHENTICATED" // signed in (or an existing session was reused)
  | "NOT_CONFIGURED" // no credentials set — skip login, search is public anyway
  | "VERIFICATION_REQUIRED" // CAPTCHA / OTP / MFA — paused for the operator
  | "LOGIN_FAILED"; // portal rejected the credentials / changed its form

export interface ContainerAuthResult {
  outcome: ContainerAuthOutcome;
  message: string;
}

const SEL = {
  loginLink: "a:has-text('Login'), #loginbtn, [data-target='#loginModal']",
  username: "#username",
  password: "#password",
  submit: "input[name='submit_login'], button[name='submit_login'], #submit_login",
};

async function isVisible(page: Page, selector: string, timeout = 1200): Promise<boolean> {
  try {
    return await page.locator(selector).first().isVisible({ timeout });
  } catch {
    return false;
  }
}

/** True once a PCS page shows a logged-in indicator (a Logout control). */
async function isAuthenticated(page: Page): Promise<boolean> {
  if (!/cpatos\.gov\.bd/i.test(page.url())) return false;
  return await isVisible(page, "a:has-text('Logout'), a:has-text('Log out'), a[href*='logout']", 800);
}

async function detectVerification(page: Page): Promise<string | null> {
  const body = (await page.content().catch(() => "")).toLowerCase();
  if (/recaptcha|hcaptcha|g-recaptcha|captcha|are you human|cf-challenge/.test(body)) return "A CAPTCHA / anti-bot challenge is shown.";
  if (/one-time (pass)?code|verification code|authenticator app|\botp\b|two-factor|multi-factor/.test(body)) return "A one-time-code / MFA step is shown.";
  return null;
}

/**
 * Best-effort sign-in. Opens the PCS entry page, reuses an existing session,
 * otherwise opens the login modal and submits the env credentials. Never throws
 * — the caller runs the (public) search regardless of the outcome.
 */
export async function ensureContainerAuth(): Promise<ContainerAuthResult> {
  if (!env.CTG_PORT_USERNAME || !env.CTG_PORT_PASSWORD) {
    return { outcome: "NOT_CONFIGURED", message: "No PCS credentials configured — running the public container search without login." };
  }

  const page = await getContainerPage();
  if (!/cpatos\.gov\.bd/i.test(page.url())) {
    await page.goto(env.CTG_PORT_PCS_URL, { waitUntil: "domcontentloaded" }).catch(() => undefined);
  }
  await page.waitForLoadState("domcontentloaded").catch(() => undefined);

  if (await isAuthenticated(page)) return { outcome: "AUTHENTICATED", message: "Existing PCS session reused." };

  // Open the login modal if the username field is not already on screen.
  if (!(await isVisible(page, SEL.username))) {
    await page.locator(SEL.loginLink).first().click({ timeout: 4000 }).catch(() => undefined);
    await page.waitForTimeout(600);
  }

  const verif = await detectVerification(page);
  if (verif) return { outcome: "VERIFICATION_REQUIRED", message: `${verif} Complete it in the visible browser; the search continues once resolved.` };

  if (!(await isVisible(page, SEL.username)) || !(await isVisible(page, SEL.password))) {
    return { outcome: "LOGIN_FAILED", message: "The PCS login form did not appear as expected. Sign in manually in the visible browser; the public search will still run." };
  }

  // Fill + submit. Values come only from env and are never logged.
  await page.fill(SEL.username, env.CTG_PORT_USERNAME).catch(() => undefined);
  await page.fill(SEL.password, env.CTG_PORT_PASSWORD).catch(() => undefined);
  await Promise.all([
    page.waitForLoadState("networkidle").catch(() => undefined),
    page.locator(SEL.submit).first().click({ timeout: 4000 }).catch(() => undefined),
  ]);
  await page.waitForTimeout(1500);

  if (await isAuthenticated(page)) return { outcome: "AUTHENTICATED", message: "Signed in to the PCS." };

  const verifAfter = await detectVerification(page);
  if (verifAfter) return { outcome: "VERIFICATION_REQUIRED", message: `${verifAfter} Complete it in the visible browser; the search continues once resolved.` };

  return { outcome: "LOGIN_FAILED", message: "PCS login did not reach an authenticated page. The public container search will still run." };
}
