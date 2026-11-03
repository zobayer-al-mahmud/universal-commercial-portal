import type { Locator, Page } from "playwright";

/**
 * Submit-safety guard for the EXP correction + duplicate workflows.
 *
 * Default posture (no policy): the bot FILLS and VERIFIES the form, then stops —
 * it performs NO final save/apply/acknowledge. Two actions can be unlocked, each
 * by its own explicit opt-in passed as a {@link ClickPolicy}:
 *   - `allowApply`       → the form's **Apply Changes** save button (EXP_AUTO_UPDATE)
 *   - `allowAcknowledge` → the Duplicate "Acknowledge/Duplicate Export" checkbox
 *                          (EXP_AUTO_ACKNOWLEDGE; the irreversible acknowledgement)
 *
 * Everything else — Submit, Save, Approve, Confirm, Process, Delete, a generic
 * "Update" — stays hard-forbidden regardless of any flag. This is defence in
 * depth: the drivers also only ever click the specific controls they name
 * (Search / Apply Changes / the Acknowledge checkbox), never a generic submit.
 */

/** Which final-action controls the driver is explicitly allowed to operate. */
export interface ClickPolicy {
  /** Allow clicking the form's "Apply Changes" save button. */
  allowApply?: boolean;
  /** Allow ticking the Duplicate "Acknowledge/Duplicate Export" checkbox. */
  allowAcknowledge?: boolean;
}

// Words that are NEVER clickable, whatever the policy. (The real save button is
// "Apply Changes", so a bare "Update" is treated as always-forbidden here.)
const HARD_FORBIDDEN_RE = /\b(submit|save|approve|confirm|process|delete|update)\b/i;
// "Apply" / "Apply Changes" — only when allowApply.
const APPLY_RE = /\bapply\b/i;
// "Acknowledge" / "Acknowledgement" — only when allowAcknowledge.
const ACK_RE = /\back(nowledge|nowledgement)?\b/i;

/** Acknowledge / final-action selectors (attribute-only; used by neutralize). */
export const ACKNOWLEDGE_SELECTORS = [
  "[id*='ACKNOWLEDGE' i]",
  "[id*='DUPLICATE_EXPORT' i]",
  "[id*='DUP_FLAG' i]",
  "[value='Acknowledge' i]",
  "[value='Submit' i]",
  "#SUBMIT",
];

/**
 * True when a control's visible label would perform a forbidden action under the
 * given policy. An empty policy forbids every final action.
 */
export function isForbiddenActionLabel(label: string, policy: ClickPolicy = {}): boolean {
  const t = (label || "").trim();
  if (!t) return false;
  if (HARD_FORBIDDEN_RE.test(t)) return true; // submit / save / update / … — never
  if (APPLY_RE.test(t)) return !policy.allowApply; // apply — only when opted in
  if (ACK_RE.test(t)) return !policy.allowAcknowledge; // acknowledge — only when opted in
  return false; // Search / Back / Edit / Print EXP / … are fine
}

/**
 * Assert that a control we are ABOUT to click is safe. Throws if forbidden — so a
 * mistaken selector can never submit/acknowledge against the policy.
 */
export async function assertSafeToClick(locator: Locator, intent: string, policy: ClickPolicy = {}): Promise<void> {
  let label = "";
  try {
    label = ((await locator.getAttribute("value")) || (await locator.innerText().catch(() => "")) || "").trim();
  } catch {
    /* if we can't read it, fall through — the intent check below still applies */
  }
  if (isForbiddenActionLabel(intent, policy)) {
    throw new Error(`Refused to click a forbidden control (intent="${intent}").`);
  }
  if (label && isForbiddenActionLabel(label, policy)) {
    throw new Error(`Refused to click control labelled "${label}".`);
  }
}

/**
 * Best-effort page hardening: disable (not remove) final-action controls that the
 * current policy does NOT permit, so an accidental Enter/click can't submit. The
 * permitted control(s) are left enabled so the driver can click them; everything
 * else — including the Duplicate acknowledge checkbox when allowAcknowledge is
 * off — is disabled. Non-fatal.
 */
export async function neutralizeFinalControls(page: Page, policy: ClickPolicy = {}): Promise<number> {
  try {
    return await page.evaluate(
      (pol) => {
        const HARD = /\b(submit|save|approve|confirm|process|delete|update)\b/i;
        const APPLY = /\bapply\b/i;
        const ACK = /\back(nowledge|nowledgement)?\b/i;
        const forbidden = (s: string): boolean => {
          const t = (s || "").trim();
          if (!t) return false;
          if (HARD.test(t)) return true;
          if (APPLY.test(t)) return !pol.allowApply;
          if (ACK.test(t)) return !pol.allowAcknowledge;
          return false;
        };
        let n = 0;
        const nodes = Array.from(
          document.querySelectorAll("button, input[type=submit], input[type=button], input[type=checkbox], a"),
        );
        for (const node of nodes) {
          const he = node as HTMLElement & { disabled?: boolean; value?: string };
          const id = he.id || "";
          // The acknowledge checkbox is identified by id even when its label is elsewhere.
          const isAckControl = /ACKNOWLEDGE|DUPLICATE_EXPORT|DUP_FLAG/i.test(id);
          const label = (he.value || he.textContent || he.getAttribute("title") || "").trim();
          const block = isAckControl ? !pol.allowAcknowledge : forbidden(label);
          if (!block) continue;
          try {
            he.setAttribute("data-ucp-disabled", "1");
            if ("disabled" in he) he.disabled = true;
            he.style.pointerEvents = "none";
            he.style.opacity = "0.4";
            n++;
          } catch {
            /* ignore individual control */
          }
        }
        return n;
      },
      { allowApply: !!policy.allowApply, allowAcknowledge: !!policy.allowAcknowledge },
    );
  } catch {
    return 0;
  }
}
