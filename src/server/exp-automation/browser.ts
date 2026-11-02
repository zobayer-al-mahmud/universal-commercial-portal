import { spawn } from "child_process";
import { mkdirSync } from "fs";
import { resolve } from "path";
import { chromium, type Browser } from "playwright";
import { env } from "@/lib/env";
import { resolveChromiumExecutable, cdpLaunchArgs, isHeadless } from "@/server/automation/browser-launch";

/**
 * Backend browser for the EXP (Bangladesh Bank) live workflow — a single
 * Chromium (Chrome/Edge/Brave) instance with its own persistent profile and a
 * loopback-only DevTools port, driven over CDP. Runs on a dedicated port +
 * profile so it never clashes with the Damco or Container instances. On a Linux
 * server (AUTOMATION_HEADLESS=true) it runs HEADLESS with no window; on Windows
 * dev it is a visible window (so the operator can watch / complete any OTP).
 * Credentials are NOT handled here — see auth.ts.
 */

let browser: Browser | null = null;

function profileDir(): string {
  const dir = resolve(env.EXP_SESSION_DIR, "profile");
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function cdpVersion(port: number): Promise<{ webSocketDebuggerUrl: string } | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) });
    return r.ok ? ((await r.json()) as { webSocketDebuggerUrl: string }) : null;
  } catch {
    return null;
  }
}

/** Launch (or reuse) the EXP browser instance and return a Playwright Browser. */
export async function getExpBrowser(): Promise<Browser> {
  if (browser?.isConnected()) return browser;

  const port = env.EXP_CDP_PORT;
  if (!(await cdpVersion(port))) {
    const exe = resolveChromiumExecutable(env.EXP_BROWSER_PATH);
    const child = spawn(exe, cdpLaunchArgs({ profileDir: profileDir(), port }), {
      detached: true,
      stdio: "ignore",
      windowsHide: isHeadless(),
    });
    child.unref();
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (await cdpVersion(port)) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!(await cdpVersion(port))) throw new Error("EXP browser did not expose its local debugging port within 30s.");
  }

  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  return browser;
}

/** The working page in the visible window (reuses the first tab, else opens one). */
export async function getExpPage() {
  const b = await getExpBrowser();
  const ctx = b.contexts()[0] ?? (await b.newContext());
  const pages = ctx.pages();
  const page = pages.find((p) => !p.isClosed()) ?? (await ctx.newPage());
  page.setDefaultNavigationTimeout(env.EXP_NAV_TIMEOUT_MS);
  page.setDefaultTimeout(env.EXP_NAV_TIMEOUT_MS);
  return page;
}

/** Detach Playwright WITHOUT closing the visible window (operator may inspect/submit). */
export async function detachExpBrowser(): Promise<void> {
  try {
    await browser?.close();
  } catch {
    /* ignore */
  }
  browser = null;
}
