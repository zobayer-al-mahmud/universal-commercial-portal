/**
 * BGMEA portal selector map.
 *
 * LOGIN selectors are confirmed from the PUBLIC login page
 * (https://bgmea.org/Account/Login — ASP.NET MVC form, anti-forgery token, no
 * CAPTCHA as of inspection). They are safe to use: logging in is not a UD submit.
 *
 * The per-step UD FIELD selectors are NOT known — mapping them requires an
 * authenticated session, which we do not drive with chat credentials. Until they
 * are confirmed against the real portal (Q-UD-09), `UD_SELECTORS_CONFIRMED` stays
 * false and the live driver FAILS CLOSED per step rather than guessing a field.
 */

export const BGMEA_LOGIN = {
  usernameSelector: "#Username",
  passwordSelector: "#Password",
  // The login form's submit button (text "Login"); the form carries the
  // __RequestVerificationToken automatically.
  submitSelector: 'form button[type="submit"]',
  // A URL still on /Account/Login after submit ⇒ not signed in.
  loginPathFragment: "/Account/Login",
};

/** One UD step's portal location + its field→selector map. */
export interface StepSelectorSet {
  /** Path/URL to the portal section for this step (relative to the portal origin). */
  path?: string;
  /** fieldKey → CSS/locator for the input on the portal form. */
  fields: Record<string, string>;
  /** Selector that opens a new repeating row (lien bank / size / etc.), if any. */
  addRowSelector?: string;
}

/**
 * EMPTY until confirmed against the authenticated portal. Populate per step once
 * the real DOM is mapped (from the operator's confirmed sample/screenshots), e.g.
 *   "buyer": { path: "/UD/Buyer", fields: { buyerName: "#BuyerName", ... } }
 * The live driver only writes a field when a confirmed selector exists for it.
 */
export const UD_PORTAL_SELECTORS: Record<string, StepSelectorSet> = {};

/** Flip to true only after the UD field selectors above are confirmed + reviewed. */
export const UD_SELECTORS_CONFIRMED = false;

export function stepSelectors(stepKey: string): StepSelectorSet | undefined {
  return UD_PORTAL_SELECTORS[stepKey];
}
