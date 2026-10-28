import type { Locator, Page } from "playwright";

/**
 * Hard, non-negotiable no-submit guard for the EXP correction + duplicate
 * workflows. The bot FILLS and VERIFIES the form, then stops — it must never
 * perform the final save / submit / acknowledge. There is no configuration flag
 * that enables it: the forbidden controls are simply never clicked, and before
 * any click the driver asserts the control is NOT one of these.
 *
 * This is defence in depth, not the only safeguard: the drivers only ever click
 * the explicit Search / menu-navigation controls they name, never a generic
 * "submit the form" button.
 */

/** Button / control labels the bot must never click on a correction/duplicate form. */
export const FORBIDDEN_ACTION_RE =
  /\b(update|submit|save|acknowledge|acknowledgement|confirm|approve|process|apply)\b/i;

/** Control values/ids on the EXP forms that perform a final save. */
export const FORBIDDEN_SELECTORS = [
  "input[type=submit]",
  "button[type=submit]",
  "#UPDATE",
  "#SUBMIT",
  "[id*='ACKNOWLEDGE' i]",
  "[id*='DUPLICATE_EXPORT' i]",
  "[value='Update' i]",
  "[value='Submit' i]",
  "[value='Acknowledge' i]",
];

/** True when a control's visible label would perform a forbidden final action. */
export function isForbiddenActionLabel(label: string): boolean {
  const t = (label || "").trim();
  if (!t) return false;
  // "Search" / "Back" are allowed even if they contain no forbidden word.
  return FORBIDDEN_ACTION_RE.test(t);
}

/**
 * Assert that a located control we are ABOUT to click is safe (not a final-save
 * control). Throws if it is forbidden — so a mistaken selector can never submit.
 */
export async function assertSafeToClick(locator: Locator, intent: string): Promise<void> {
  let label = "";
  try {
    label = ((await locator.getAttribute("value")) || (await locator.innerText().catch(() => "")) || "").trim();
  } catch {
    /* if we can't read it, fall through — the intent check below still applies */
  }
  if (isForbiddenActionLabel(intent)) {
    throw new Error(`Refused to click a forbidden control (intent="${intent}"): the EXP bot never submits.`);
  }
  if (label && isForbiddenActionLabel(label)) {
    throw new Error(`Refused to click control labelled "${label}": the EXP bot never submits.`);
  }
}

/**
 * Best-effort page hardening: disable (not remove) any final-save controls on
 * the current form so an accidental Enter/click can't submit. Non-fatal.
 */
export async function neutralizeSubmitControls(page: Page): Promise<number> {
  try {
    return await page.evaluate((selectors) => {
      let n = 0;
      const seen = new Set<Element>();
      for (const sel of selectors) {
        document.querySelectorAll(sel).forEach((el) => {
          if (seen.has(el)) return;
          seen.add(el);
          const he = el as HTMLElement & { disabled?: boolean };
          try {
            he.setAttribute("data-ucp-disabled", "1");
            if ("disabled" in he) he.disabled = true;
            he.style.pointerEvents = "none";
            he.style.opacity = "0.4";
            n++;
          } catch {
            /* ignore individual control */
          }
        });
      }
      return n;
    }, FORBIDDEN_SELECTORS);
  } catch {
    return 0;
  }
}
