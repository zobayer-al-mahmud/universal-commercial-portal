import { spawn } from "child_process";
import { mkdirSync } from "fs";
import { resolve } from "path";
import { chromium, type Browser, type Page } from "playwright";
import { env } from "@/lib/env";
import { resolveChromiumExecutable, cdpLaunchArgs, isHeadless } from "@/server/automation/browser-launch";

/**
 * Backend browser for the CTG Port container-search automation.
 *
 * One Chromium instance with a dedicated persistent profile and a loopback-only
 * DevTools port (separate from the Damco port so the two never clash). Playwright
 * attaches over CDP and drives it; the result PDF is captured via CDP
 * Page.printToPDF (Chromium-only — hence Chromium, not Firefox). On a Linux
 * server (AUTOMATION_HEADLESS=true) it runs HEADLESS. The container search is a
 * public lookup; no credentials are handled here.
 */

let browser: Browser | null = null;

function profileDir(): string {
  const dir = resolve(env.CONTAINER_SESSION_DIR, "profile");
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

/** Launch (or reuse) the Container browser instance and return a Playwright Browser. */
export async function getContainerBrowser(): Promise<Browser> {
  if (browser?.isConnected()) return browser;
  const port = env.CONTAINER_CDP_PORT;
  if (!(await cdpVersion(port))) {
    const exe = resolveChromiumExecutable(env.CONTAINER_BROWSER_PATH, env.DAMCO_BROWSER_PATH);
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
    if (!(await cdpVersion(port))) throw new Error("Container browser did not expose its local debugging port within 30s.");
  }
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  return browser;
}

/** The working page in the visible window (reuses the first tab, else opens one). */
export async function getContainerPage(): Promise<Page> {
  const b = await getContainerBrowser();
  const ctx = b.contexts()[0] ?? (await b.newContext());
  const page = ctx.pages().find((p) => !p.isClosed()) ?? (await ctx.newPage());
  page.setDefaultNavigationTimeout(env.CONTAINER_NAV_TIMEOUT_MS);
  page.setDefaultTimeout(env.CONTAINER_NAV_TIMEOUT_MS);
  return page;
}

/** Detach Playwright WITHOUT closing the visible window (operator may inspect it). */
export async function detachContainerBrowser(): Promise<void> {
  try { await browser?.close(); } catch { /* ignore */ }
  browser = null;
}
