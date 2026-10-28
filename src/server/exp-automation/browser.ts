import { spawn } from "child_process";
import { existsSync, mkdirSync } from "fs";
import { resolve } from "path";
import { chromium, type Browser } from "playwright";
import { env } from "@/lib/env";

/**
 * Local VISIBLE browser for the EXP (Bangladesh Bank) live workflow — a single
 * Chrome/Edge/Brave window on this PC with its own persistent profile and a
 * loopback-only DevTools port, driven over CDP. Runs on a dedicated port +
 * profile so it never clashes with the Damco or Container windows. The window
 * is never hidden and is never closed automatically mid-run (so the operator can
 * review the prepared form, and complete any CAPTCHA/OTP). Credentials are NOT
 * handled here — see auth.ts.
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

function resolveBrowserPath(): string {
  if (env.EXP_BROWSER_PATH && existsSync(env.EXP_BROWSER_PATH)) return env.EXP_BROWSER_PATH;
  const candidates = [
    `${process.env.LOCALAPPDATA}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`,
    "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ];
  for (const c of candidates) if (c && existsSync(c)) return c;
  throw new Error("No local browser found. Set EXP_BROWSER_PATH to chrome.exe / msedge.exe / brave.exe.");
}

/** Launch (or reuse) the one visible EXP browser window and return a Playwright Browser. */
export async function getExpBrowser(): Promise<Browser> {
  if (browser?.isConnected()) return browser;

  const port = env.EXP_CDP_PORT;
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
    if (!(await cdpVersion(port))) throw new Error("Visible EXP browser did not expose its local debugging port within 30s.");
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
