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
 * Never-submit click allow-list. Unlike EXP (which has opt-in flags), UD has NO
 * opt-in: the driver may only Login, navigate, open/add rows, fill fields, and read
 * back. Any control that would submit/save/finalise/approve a UD is forbidden —
 * there is no flag to unlock it. Defence in depth: the driver also only ever
 * targets the specific fields it names, never a generic submit.
 */
const UD_FORBIDDEN_RE = /\b(submit|save|approve|confirm|finalize|finalise|finish|lock|send|complete|post|apply|acknowledge|authori[sz]e)\b/i;

/** Controls that are safe to click during fill/verify (navigation + row editing only). */
const UD_ALLOWED_RE = /\b(login|sign in|search|find|next|previous|back|add|new row|edit|open|select|browse|choose file|upload|cancel|close)\b/i;

export function isForbiddenUdControl(label: string): boolean {
  const t = (label || "").trim();
  if (!t) return false;
  if (UD_FORBIDDEN_RE.test(t)) return true;
  return false;
}

/** Assert a control we are about to click cannot submit/finalise a UD. Throws if it could. */
export async function assertSafeToClickUd(locator: Locator, intent: string): Promise<void> {
  if (isForbiddenUdControl(intent)) {
    throw new Error(`UD Automation refused to click a final-action control (intent="${intent}"). The workflow fills and verifies only.`);
  }
  let label = "";
  try {
    label = ((await locator.getAttribute("value")) || (await locator.innerText().catch(() => "")) || "").trim();
  } catch {
    /* unreadable — the intent check above still applies */
  }
  if (label && isForbiddenUdControl(label) && !UD_ALLOWED_RE.test(label)) {
    throw new Error(`UD Automation refused to click control labelled "${label}" (fill/verify only).`);
  }
}

/** Best-effort: disable every submit/finalise control on the page so an accidental Enter can't submit. Non-fatal. */
export async function neutralizeUdSubmitControls(page: Page): Promise<number> {
  try {
    return await page.evaluate(() => {
      const FORBIDDEN = /\b(submit|save|approve|confirm|finalize|finalise|finish|lock|send|complete|post|apply|acknowledge|authori[sz]e)\b/i;
      const ALLOWED = /\b(login|sign in|search|find|next|previous|back|add|new row|edit|open|select|browse|choose file|upload|cancel|close)\b/i;
      let n = 0;
      for (const node of Array.from(document.querySelectorAll("button, input[type=submit], input[type=button]"))) {
        const he = node as HTMLElement & { disabled?: boolean; value?: string };
        const label = (he.value || he.textContent || he.getAttribute("title") || "").trim();
        if (!label || !FORBIDDEN.test(label) || ALLOWED.test(label)) continue;
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
