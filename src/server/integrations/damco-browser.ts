import { spawn } from "child_process";
import { existsSync, mkdirSync } from "fs";
import { resolve } from "path";
import { chromium, type Browser } from "playwright";
import { env } from "@/lib/env";

/**
 * Local VISIBLE browser for the Damco live workflow.
 *
 * A single Chrome/Edge/Brave window is launched on this PC with a dedicated,
 * persistent profile (so a portal session survives across runs) and a
 * loopback-only DevTools port. Playwright attaches over CDP and drives that one
 * window. The window is never hidden and is never closed automatically mid-run.
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

function resolveBrowserPath(): string {
  if (env.DAMCO_BROWSER_PATH && existsSync(env.DAMCO_BROWSER_PATH)) return env.DAMCO_BROWSER_PATH;
  const candidates = [
    `${process.env.LOCALAPPDATA}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`,
    "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ];
  for (const c of candidates) if (c && existsSync(c)) return c;
  throw new Error("No local browser found. Set DAMCO_BROWSER_PATH to chrome.exe / msedge.exe / brave.exe.");
}

/** Launch (or reuse) the one visible browser window and return a Playwright Browser. */
export async function getDamcoBrowser(): Promise<Browser> {
  if (browser?.isConnected()) return browser;

  const port = env.DAMCO_CDP_PORT;
  if (!(await cdpVersion(port))) {
    const exe = resolveBrowserPath();
    const child = spawn(
      exe,
      [
        `--remote-debugging-port=${port}`,
        "--remote-debugging-address=127.0.0.1",
        `--user-data-dir=${profileDir()}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--start-maximized",
        "about:blank",
      ],
      { detached: true, stdio: "ignore", windowsHide: false },
    );
    child.unref();
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (await cdpVersion(port)) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!(await cdpVersion(port))) throw new Error("Visible browser did not expose its local debugging port within 30s.");
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
