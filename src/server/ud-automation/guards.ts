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
// Final / destructive actions — never clicked by automation in ANY context (delete/cancel
// included: UCP never removes a BGMEA row, cancels a UD, or pays a fee).
const UD_SUBMIT_RE = /\b(submit|submission|approve|finalize|finalise|finish|lock|send|complete|post|acknowledge|authori[sz]e|confirm|delete|remove|cancel|cancellation|pay|payment)\b/i;
const UD_FORBIDDEN_RE = /\b(submit|submission|save|approve|confirm|finalize|finalise|finish|lock|send|complete|post|apply|acknowledge|authori[sz]e|update|delete|remove|cancel|cancellation|pay|payment)\b/i;

/** Controls that are safe to click during fill/verify (navigation + row editing only). */
const UD_ALLOWED_RE = /\b(login|sign in|search|find|next|previous|back|add|new row|edit|open|select|browse|choose file|upload|close)\b/i;

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
      const SUBMIT = /\b(submit|submission|approve|finalize|finalise|finish|lock|send|complete|post|acknowledge|authori[sz]e|confirm|delete|remove|cancellation|payment)\b/i;
      const ALLOWED = /\b(login|sign in|search|find|next|previous|back|add|new row|edit|open|select|browse|choose file|upload|close)\b/i;
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
// Write-back gate — "Confirm Ready for BGMEA"
// ---------------------------------------------------------------------------

export type WriteBackTarget = "live";

export interface BgmeaWriteBackGate {
  /** Feature switched on by config (BGMEA_WRITEBACK_ENABLED). */
  enabled: boolean;
  target: WriteBackTarget;
  /** May a write-back run for this factory right now (config + factory credentials)? */
  allowed: boolean;
  reason: string;
}

/**
 * Whether BGMEA write-back may run for a factory. Fail-closed:
 *  - disabled unless BGMEA_WRITEBACK_ENABLED is true (the kill switch);
 *  - requires live access (BGMEA_LIVE_ENABLED) and this factory's own credentials.
 * Even when allowed, every run additionally needs the operator's explicit
 * "Confirm Ready for BGMEA" for that exact factory + UD (checked by the action and
 * the writer), the UD must be editable in BGMEA, and the final submission is never
 * performed (`UD_NEVER_AUTO_SUBMITS`).
 */
export async function bgmeaWriteBackGate(factoryId: string): Promise<BgmeaWriteBackGate> {
  const enabled = env.BGMEA_WRITEBACK_ENABLED;
  if (!enabled) {
    return { enabled, target: "live", allowed: false, reason: "BGMEA write-back is switched off (BGMEA_WRITEBACK_ENABLED is not true). Nothing can be saved to BGMEA." };
  }
  const live = await bgmeaLiveGate(factoryId);
  if (!live.allowed) return { enabled, target: "live", allowed: false, reason: live.reason };
  return { enabled, target: "live", allowed: true, reason: "" };
}

/** The exact confirmation the operator must give: same factory AND same UD as the record. */
export function confirmationMatches(input: { confirmFactoryId: string; confirmUdNumber: string }, record: { factoryId: string; udNumber: string }): boolean {
  const ud = (record.udNumber || "").trim().toUpperCase();
  return !!ud && input.confirmFactoryId === record.factoryId && (input.confirmUdNumber || "").trim().toUpperCase() === ud;
}
