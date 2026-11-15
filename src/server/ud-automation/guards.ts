import "server-only";
import type { Locator, Page } from "playwright";
import { env } from "@/lib/env";
import { getBgmeaCredentials } from "./credentials";

/**
 * UD Automation — fail-closed safety gate.
 *
 * HARD INVARIANT: UD Automation never submits a UD to BGMEA on its own. The
 * workflow fills + reviews only; final BGMEA submission is always a deliberate,
 * operator-confirmed action. No configuration flag can turn this off.
 */
export const UD_NEVER_AUTO_SUBMITS = true as const;

export interface BgmeaLiveGate {
  /** Live BGMEA driving is enabled by config. */
  liveEnabled: boolean;
  /** This factory has usable credentials (store or env). */
  credsConfigured: boolean;
  /** Overall: may a (future) live driver run for this factory right now? */
  allowed: boolean;
  reason: string;
}

/**
 * Whether live BGMEA automation may run for a factory. Fail-closed: disabled
 * unless BGMEA_LIVE_ENABLED is true AND the factory has credentials. Even when
 * allowed, the live path only fills/reviews — it never submits.
 */
export async function bgmeaLiveGate(factoryId: string): Promise<BgmeaLiveGate> {
  const liveEnabled = env.BGMEA_LIVE_ENABLED;
  const creds = await getBgmeaCredentials(factoryId);
  const credsConfigured = creds !== null;
  if (!liveEnabled) {
    return { liveEnabled, credsConfigured, allowed: false, reason: "BGMEA live automation is disabled (fail-closed). Set BGMEA_LIVE_ENABLED=true to enable." };
  }
  if (!credsConfigured) {
    return { liveEnabled, credsConfigured, allowed: false, reason: "No BGMEA credentials configured for this factory." };
  }
  return { liveEnabled, credsConfigured, allowed: true, reason: "" };
}

/**
 * Control classification. Two tiers, because Q-UD-13 was resolved to allow an
 * explicit, user-confirmed page SAVE while final SUBMISSION stays a separate action
 * that is never automated:
 *
 *   - FINAL-SUBMIT controls (submit/finalise/approve/lock/…): NEVER clicked by
 *     automation. No flag unlocks this — `UD_NEVER_AUTO_SUBMITS` is absolute.
 *   - PAGE-SAVE controls (save/add/update/next/…): forbidden during a READ/scrape,
 *     but permitted during a write-back page save (which is gated + user-confirmed).
 *
 * `UD_FORBIDDEN_RE` (read context) therefore spans BOTH tiers; `UD_SUBMIT_RE` is the
 * final-submit tier alone, which is forbidden in every context.
 */
const UD_SUBMIT_RE = /\b(submit|approve|finalize|finalise|finish|lock|send|complete|post|acknowledge|authori[sz]e|confirm)\b/i;
const UD_SAVE_RE = /\b(save|update|apply|next|continue|ok)\b/i;
const UD_FORBIDDEN_RE = /\b(submit|save|approve|confirm|finalize|finalise|finish|lock|send|complete|post|apply|acknowledge|authori[sz]e|update)\b/i;

/** Controls that are safe to click during fill/verify (navigation + row editing only). */
const UD_ALLOWED_RE = /\b(login|sign in|search|find|next|previous|back|add|new row|edit|open|select|browse|choose file|upload|cancel|close)\b/i;

/** A final-submission control — never clicked by automation, in any context. */
export function isFinalSubmitControl(label: string): boolean {
  const t = (label || "").trim();
  if (!t) return false;
  return UD_SUBMIT_RE.test(t);
}

/** Forbidden in a READ/scrape context (both save and submit). */
export function isForbiddenUdControl(label: string): boolean {
  const t = (label || "").trim();
  if (!t) return false;
  return UD_FORBIDDEN_RE.test(t);
}

/**
 * Assert a control we are about to click is safe. Final-submit controls are always
 * refused. Page-save controls are refused UNLESS `allowSave` is set (a gated,
 * user-confirmed write-back page save); read/scrape callers leave it off.
 */
export async function assertSafeToClickUd(locator: Locator, intent: string, opts: { allowSave?: boolean } = {}): Promise<void> {
  const forbids = (s: string) => (opts.allowSave ? isFinalSubmitControl(s) : isForbiddenUdControl(s));
  const tier = opts.allowSave ? "a final-action" : "a submit/save";
  if (forbids(intent)) {
    throw new Error(`UD Automation refused to click ${tier} control (intent="${intent}").`);
  }
  let label = "";
  try {
    label = ((await locator.getAttribute("value")) || (await locator.innerText().catch(() => "")) || "").trim();
  } catch {
    /* unreadable — the intent check above still applies */
  }
  if (label && forbids(label) && !UD_ALLOWED_RE.test(label)) {
    throw new Error(`UD Automation refused to click control labelled "${label}".`);
  }
}

/**
 * Best-effort: disable every FINAL-SUBMIT control on the page so an accidental Enter
 * can't submit. Save controls are left alone so a confirmed write-back can save.
 * Non-fatal.
 */
export async function neutralizeUdSubmitControls(page: Page): Promise<number> {
  try {
    return await page.evaluate(() => {
      const SUBMIT = /\b(submit|approve|finalize|finalise|finish|lock|send|complete|post|acknowledge|authori[sz]e|confirm)\b/i;
      const ALLOWED = /\b(login|sign in|search|find|next|previous|back|add|new row|edit|open|select|browse|choose file|upload|cancel|close)\b/i;
      let n = 0;
      for (const node of Array.from(document.querySelectorAll("button, input[type=submit], input[type=button]"))) {
        const he = node as HTMLElement & { disabled?: boolean; value?: string };
        const label = (he.value || he.textContent || he.getAttribute("title") || "").trim();
        if (!label || !SUBMIT.test(label) || ALLOWED.test(label)) continue;
        try {
          he.setAttribute("data-ucp-disabled", "1");
          if ("disabled" in he) he.disabled = true;
          he.style.pointerEvents = "none";
          he.style.opacity = "0.4";
          n++;
        } catch {
          /* ignore */
        }
      }
      return n;
    });
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Write-back gate (Q-UD-13) — fail-closed; production stays disabled.
// ---------------------------------------------------------------------------

export type WriteBackTarget = "mock" | "nonprod";

export interface BgmeaWriteBackGate {
  /** Feature switched on by config at all. */
  enabled: boolean;
  /** Resolved target for a run. */
  target: WriteBackTarget;
  /** May a write-back run right now? */
  allowed: boolean;
  /** Would this run touch a production host? (Always refused unless explicitly allowed.) */
  production: boolean;
  reason: string;
}

const PRODUCTION_HOST_RE = /(^|\.)bgmea\.org$/i;

function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Whether BGMEA write-back may run for a factory. Fail-closed:
 *  - disabled unless BGMEA_WRITEBACK_ENABLED.
 *  - target "mock": allowed (simulated; no portal, no creds) — the dev/verify path.
 *  - target "nonprod": requires live creds + confirmed selectors + a non-production
 *    BGMEA_NONPROD_URL. A production host is refused unless BGMEA_ALLOW_PRODUCTION_WRITE
 *    is true (which must only be set on explicit owner authorization).
 */
export async function bgmeaWriteBackGate(factoryId: string): Promise<BgmeaWriteBackGate> {
  const enabled = env.BGMEA_WRITEBACK_ENABLED;
  const target = env.BGMEA_WRITEBACK_TARGET as WriteBackTarget;
  if (!enabled) {
    return { enabled, target, allowed: false, production: false, reason: "BGMEA write-back is disabled (fail-closed). Set BGMEA_WRITEBACK_ENABLED=true to enable." };
  }
  if (target === "mock") {
    return { enabled, target, allowed: true, production: false, reason: "" };
  }
  // target === "nonprod" — this requires a confirmed non-production environment.
  const url = env.BGMEA_NONPROD_URL || "";
  const host = hostOf(url);
  const isProd = host !== "" && PRODUCTION_HOST_RE.test(host);
  if (isProd && !env.BGMEA_ALLOW_PRODUCTION_WRITE) {
    return { enabled, target, allowed: false, production: true, reason: "Production write-back is disabled. BGMEA_NONPROD_URL points at a production host; set a non-production URL (production stays off until explicitly authorized)." };
  }
  if (!url || host === "") {
    return { enabled, target, allowed: false, production: false, reason: "Set BGMEA_NONPROD_URL to a confirmed non-production BGMEA environment for write-back." };
  }
  const live = await bgmeaLiveGate(factoryId);
  if (!live.allowed) {
    return { enabled, target, allowed: false, production: isProd, reason: live.reason };
  }
  return { enabled, target, allowed: true, production: isProd, reason: "" };
}
