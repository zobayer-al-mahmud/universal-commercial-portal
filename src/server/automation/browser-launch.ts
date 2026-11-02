import { existsSync } from "fs";
import { env } from "@/lib/env";

/**
 * Shared Chromium launch helper for every UCP portal automation (EXP, Damco,
 * Container). Each module still spawns its OWN Chromium with a dedicated profile
 * + loopback CDP port (so the windows/sessions never clash) and attaches over
 * CDP; this module only centralises the two things that differ by host:
 *
 *   - resolveChromiumExecutable(): finds chrome/chromium/edge/brave on Windows
 *     OR Linux (production), honouring an explicit per-module path first.
 *   - cdpLaunchArgs(): the argv, adding headless + container-safe flags when
 *     AUTOMATION_HEADLESS is on (Linux servers run with no window).
 *
 * Chromium is required: the Container module captures its PDF via CDP
 * Page.printToPDF, which only Chromium provides. AUTOMATION_BROWSER_ENGINE is a
 * documented forward-compat hook; "firefox" is not wired here.
 */

/** True when the backend browser should run with no window (Linux/production). */
export function isHeadless(): boolean {
  return env.AUTOMATION_HEADLESS;
}

const LINUX_CANDIDATES = [
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/snap/bin/chromium",
  "/usr/bin/brave-browser",
  "/usr/bin/microsoft-edge",
];

const WINDOWS_CANDIDATES = [
  `${process.env.LOCALAPPDATA}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`,
  "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];

/**
 * Resolve a Chromium-family executable. Priority: the per-module path (e.g.
 * EXP_BROWSER_PATH), then the cross-cutting AUTOMATION_BROWSER_PATH, then the
 * platform's well-known install locations. Throws with an actionable message.
 */
export function resolveChromiumExecutable(...preferred: Array<string | undefined>): string {
  for (const p of [...preferred, env.AUTOMATION_BROWSER_PATH]) {
    if (p && existsSync(p)) return p;
  }
  const candidates = process.platform === "win32" ? WINDOWS_CANDIDATES : LINUX_CANDIDATES;
  for (const c of candidates) if (c && existsSync(c)) return c;
  const hint = process.platform === "win32"
    ? "set the module's *_BROWSER_PATH (or AUTOMATION_BROWSER_PATH) to chrome.exe / msedge.exe / brave.exe"
    : "install Chromium (e.g. `apt-get install -y chromium` or Google Chrome) or set AUTOMATION_BROWSER_PATH";
  throw new Error(`No Chromium-family browser found. On ${process.platform}, ${hint}.`);
}

/**
 * CDP launch argv. In headless mode (Linux/production) adds the flags a
 * containerised/rootless Chromium needs (`--headless=new`, `--no-sandbox`,
 * `--disable-dev-shm-usage`, `--disable-gpu`); otherwise launches a maximised
 * window (Windows dev — unchanged behaviour).
 */
export function cdpLaunchArgs(opts: { profileDir: string; port: number }): string[] {
  const args = [
    `--remote-debugging-port=${opts.port}`,
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${opts.profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
  ];
  if (isHeadless()) {
    args.push("--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--window-size=1600,1200");
  } else {
    args.push("--start-maximized");
  }
  args.push("about:blank");
  return args;
}
