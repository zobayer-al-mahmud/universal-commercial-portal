/**
 * BGMEA portal selector map — READ-ONLY.
 *
 * UD Automation only READS from the BGMEA portal (scrapes a UD's data to import
 * into UCP). It never creates, edits or submits a portal record. These selectors
 * are used only to navigate and to READ values; nothing here fills a portal field.
 *
 * LOGIN selectors are confirmed from the PUBLIC login page
 * (https://bgmea.org/Account/Login — ASP.NET MVC form, anti-forgery token, no
 * CAPTCHA at inspection). Logging in is read-only usage of the account.
 *
 * The UD LOOKUP + per-section READ field maps are NOT known — mapping them needs
 * an authenticated session, which we do not drive with chat credentials. Until
 * confirmed against the real portal (Q-UD-09), `UD_SELECTORS_CONFIRMED` stays
 * false and the scraper FAILS CLOSED (reads nothing, imports nothing).
 */

export const BGMEA_LOGIN = {
  usernameSelector: "#Username",
  passwordSelector: "#Password",
  submitSelector: 'form button[type="submit"]',
  loginPathFragment: "/Account/Login",
};

/** How to locate a specific UD by its number (read-only). Pending confirmation. */
export interface UdLookup {
  /** Path to the UD list/search page. */
  path?: string;
  /** Input to type the UD number into (read-only search, not a record write). */
  udNumberField?: string;
  /** Control to run the search. */
  searchButton?: string;
  /** Link/row that opens the matched UD. */
  openResultSelector?: string;
}

export const BGMEA_UD_LOOKUP: UdLookup = {};

/** One UD section's portal location + the field→selector map to READ values from. */
export interface StepReadSet {
  /** Path/URL of the portal section for this step. */
  path?: string;
  /** fieldKey → CSS/locator to READ the value from (input value or text). */
  fields: Record<string, string>;
  /** For repeating sections: a selector that matches each row (read each one). */
  rowSelector?: string;
}

/**
 * EMPTY until confirmed against the authenticated portal. Populate per step once
 * the real DOM is mapped from the operator's confirmed sample/screenshots, e.g.
 *   "buyer": { path: "/UD/View/Buyer", fields: { buyerName: "#BuyerName", ... } }
 * The scraper only reads a field when a confirmed read-selector exists for it.
 */
export const UD_READ_SELECTORS: Record<string, StepReadSet> = {};

/** Flip to true only after the read selectors above are confirmed + reviewed. */
export const UD_SELECTORS_CONFIRMED = false;

export function stepReadSelectors(stepKey: string): StepReadSet | undefined {
  return UD_READ_SELECTORS[stepKey];
}
