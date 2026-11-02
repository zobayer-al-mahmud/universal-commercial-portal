import { spawn } from "child_process";
import { mkdirSync } from "fs";
import { resolve } from "path";
import { chromium, type Browser } from "playwright";
import { env } from "@/lib/env";
import { resolveChromiumExecutable, cdpLaunchArgs, isHeadless } from "@/server/automation/browser-launch";

/**
 * Backend browser for the Damco live workflow.
 *
 * A single Chromium instance with a dedicated, persistent profile (so a portal
 * session survives across runs) and a loopback-only DevTools port. Playwright
 * attaches over CDP and drives it. On a Linux server (AUTOMATION_HEADLESS=true)
 * it runs HEADLESS; on Windows dev it is a visible window.
 *
 * Credentials are NOT handled here — see damco-auth.ts.
 */

let browser: Browser | null = null;

function profileDir(): string {
  const dir = resolve(env.DAMCO_SESSION_DIR, "profile");
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

/** Launch (or reuse) the Damco browser instance and return a Playwright Browser. */
export async function getDamcoBrowser(): Promise<Browser> {
  if (browser?.isConnected()) return browser;

  const port = env.DAMCO_CDP_PORT;
  if (!(await cdpVersion(port))) {
    const exe = resolveChromiumExecutable(env.DAMCO_BROWSER_PATH);
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
    if (!(await cdpVersion(port))) throw new Error("Damco browser did not expose its local debugging port within 30s.");
  }

  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  return browser;
}

/** The working page in the visible window (reuses the first tab, else opens one). */
export async function getDamcoPage() {
  const b = await getDamcoBrowser();
  const ctx = b.contexts()[0] ?? (await b.newContext());
  const pages = ctx.pages();
  const page = pages.find((p) => !p.isClosed()) ?? (await ctx.newPage());
  page.setDefaultNavigationTimeout(env.DAMCO_NAV_TIMEOUT_MS);
  page.setDefaultTimeout(env.DAMCO_NAV_TIMEOUT_MS);
  return page;
}

/** Detach Playwright WITHOUT closing the visible window (operator may inspect it). */
export async function detachDamcoBrowser(): Promise<void> {
  try {
    await browser?.close();
  } catch {
    /* ignore */
  }
  browser = null;
}
