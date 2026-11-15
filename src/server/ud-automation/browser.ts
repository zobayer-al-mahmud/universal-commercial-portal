import { spawn, type ChildProcess } from "child_process";
import { mkdirSync } from "fs";
import { resolve } from "path";
import { chromium, type Browser } from "playwright";
import { env } from "@/lib/env";
import { resolveChromiumExecutable, cdpLaunchArgs, isHeadless } from "@/server/automation/browser-launch";

/**
 * Backend browser for the BGMEA UD live workflow — one Chromium instance with its
 * own persistent profile + loopback DevTools port, on a dedicated port so it never
 * clashes with the Damco / Container / EXP windows. Visible on Windows dev (so the
 * operator can watch and complete any OTP/CAPTCHA); headless on a Linux server
 * (AUTOMATION_HEADLESS=true). Credentials are NOT handled here (see auth.ts).
 */

let browser: Browser | null = null;
let proc: ChildProcess | null = null;

function profileDir(): string {
  const dir = resolve(env.BGMEA_SESSION_DIR, "profile");
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

export async function getBgmeaBrowser(): Promise<Browser> {
  if (browser?.isConnected()) return browser;

  const port = env.BGMEA_CDP_PORT;
  if (!(await cdpVersion(port))) {
    const exe = resolveChromiumExecutable(env.BGMEA_BROWSER_PATH);
    const child = spawn(exe, cdpLaunchArgs({ profileDir: profileDir(), port }), {
      detached: true,
      stdio: "ignore",
      windowsHide: isHeadless(),
    });
    proc = child;
    child.on("exit", () => { if (proc === child) proc = null; });
    child.unref();
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (await cdpVersion(port)) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!(await cdpVersion(port))) throw new Error("BGMEA browser did not expose its local debugging port within 30s.");
  }

  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  return browser;
}

export async function getBgmeaPage() {
  const b = await getBgmeaBrowser();
  const ctx = b.contexts()[0] ?? (await b.newContext());
  const pages = ctx.pages();
  const page = pages.find((p) => !p.isClosed()) ?? (await ctx.newPage());
  page.setDefaultNavigationTimeout(env.BGMEA_NAV_TIMEOUT_MS);
  page.setDefaultTimeout(env.BGMEA_NAV_TIMEOUT_MS);
  return page;
}

/** Detach Playwright WITHOUT closing the visible window (operator may inspect). */
export async function detachBgmeaBrowser(): Promise<void> {
  try {
    await browser?.close();
  } catch {
    /* ignore */
  }
  browser = null;
}

/** Fully stop the browser + terminate the spawned Chromium (unlocks the profile). */
export async function shutdownBgmeaBrowser(): Promise<void> {
  await detachBgmeaBrowser();
  const p = proc;
  proc = null;
  if (p && !p.killed) {
    try {
      p.kill();
    } catch {
      /* ignore */
    }
  }
}
