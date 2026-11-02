import type { Locator, Page } from "playwright";

/**
 * Submit-safety guard for the EXP correction + duplicate workflows.
 *
 * Default posture: the bot FILLS and VERIFIES the form, then stops — it performs
 * NO final save/submit/acknowledge. The ONLY action that can ever be automated is
 * the form's **Update** button, and only when the operator has opted in via
 * EXP_AUTO_UPDATE (passed here as `allowUpdate`). Everything else — Acknowledge,
 * Submit, Save, Approve, the Duplicate "Click for Acknowledgement" flag — stays
 * hard-forbidden regardless of any flag. This is defence in depth: the drivers
 * also only ever click the specific controls they name (Search / Update), never a
 * generic "submit the form".
 */

// Labels that are NEVER clickable — the final, acknowledge-style actions.
const ALWAYS_FORBIDDEN_RE = /\b(acknowledge|acknowledgement|approve|confirm|process|apply|submit|save|delete)\b/i;
// The one action that MAY be automated, and only when allowUpdate is true.
const UPDATE_RE = /\bupdate\b/i;

/** Acknowledge / final-action selectors — disabled on every run, flag or not. */
export const ACKNOWLEDGE_SELECTORS = [
  "[id*='ACKNOWLEDGE' i]",
  "[id*='DUPLICATE_EXPORT' i]",
  // Duplicate EXP Reporting: the "Click for Acknowledgement" checkbox (P3_DUP_FLAG_0)
  // is the final acknowledge action — never ticked by the bot.
  "[id*='DUP_FLAG' i]",
  "[value='Acknowledge' i]",
  "[value='Submit' i]",
  "#SUBMIT",
];
/** Generic submit controls — disabled only when Update is NOT being automated. */
const GENERIC_SUBMIT_SELECTORS = ["input[type=submit]", "button[type=submit]"];
/** The Update control — disabled only when Update is NOT being automated. */
const UPDATE_SELECTORS = ["#UPDATE", "[value='Update' i]"];

/**
 * True when a control's visible label would perform a forbidden action.
 * `allowUpdate` carves out ONLY the Update action; acknowledge/submit/save/etc.
 * stay forbidden.
 */
export function isForbiddenActionLabel(label: string, allowUpdate = false): boolean {
  const t = (label || "").trim();
  if (!t) return false;
  if (ALWAYS_FORBIDDEN_RE.test(t)) return true; // acknowledge / submit / save / … — never
  if (UPDATE_RE.test(t)) return !allowUpdate; // update — only when opted in
  return false; // Search / Back / etc. are fine
}

/**
 * Assert that a control we are ABOUT to click is safe. Throws if forbidden — so a
 * mistaken selector can never submit/acknowledge. Update is permitted only when
 * `allowUpdate` is true (EXP_AUTO_UPDATE).
 */
export async function assertSafeToClick(locator: Locator, intent: string, allowUpdate = false): Promise<void> {
  let label = "";
  try {
    label = ((await locator.getAttribute("value")) || (await locator.innerText().catch(() => "")) || "").trim();
  } catch {
    /* if we can't read it, fall through — the intent check below still applies */
  }
  if (isForbiddenActionLabel(intent, allowUpdate)) {
    throw new Error(`Refused to click a forbidden control (intent="${intent}").`);
  }
  if (label && isForbiddenActionLabel(label, allowUpdate)) {
    throw new Error(`Refused to click control labelled "${label}".`);
  }
}

/**
 * Best-effort page hardening: disable (not remove) final-action controls so an
 * accidental Enter/click can't submit. When `allowUpdate` is true the Update
 * control (and generic submits, since Update may itself be a submit) are LEFT
 * enabled so the driver can click Update; Acknowledge/final controls are still
 * disabled. Non-fatal.
 */
export async function neutralizeFinalControls(page: Page, opts: { allowUpdate: boolean }): Promise<number> {
  const selectors = opts.allowUpdate
    ? ACKNOWLEDGE_SELECTORS
    : [...ACKNOWLEDGE_SELECTORS, ...GENERIC_SUBMIT_SELECTORS, ...UPDATE_SELECTORS];
  try {
    return await page.evaluate((sels) => {
      let n = 0;
      const seen = new Set<Element>();
      for (const sel of sels) {
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
    }, selectors);
  } catch {
    return 0;
  }
}
