import { spawn } from "child_process";
import { mkdirSync } from "fs";
import { resolve } from "path";
import { chromium } from "playwright";
import { env } from "@/lib/env";

// Opens a VISIBLE Chromium at the single authorised entry URL for an operator to
// sign in manually. Credentials are never read or typed by this script.
// The CDP port is bound to 127.0.0.1 only and is for local selector discovery.
export const CDP_PORT = 9333;

async function cdpUp(): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
    return r.ok;
  } catch {
    return false;
  }
}

async function main() {
  if (await cdpUp()) {
    console.log(`Damco browser already running (CDP 127.0.0.1:${CDP_PORT}).`);
    return;
  }
  const profile = resolve(env.DAMCO_SESSION_DIR, "profile");
  mkdirSync(profile, { recursive: true });
  const child = spawn(
    chromium.executablePath(),
    [
      `--remote-debugging-port=${CDP_PORT}`,
      "--remote-debugging-address=127.0.0.1",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      env.DAMCO_PORTAL_URL,
    ],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
  for (let i = 0; i < 60; i++) {
    if (await cdpUp()) {
      console.log(`Damco browser opened at ${env.DAMCO_PORTAL_URL} (pid ${child.pid}).`);
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("Browser did not expose the debugging endpoint within 30s.");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
