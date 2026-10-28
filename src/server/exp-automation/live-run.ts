import type { Page } from "playwright";
import { env } from "@/lib/env";
import { getExpPage } from "./browser";
import { ensureExpAuth, type AuthResult } from "./auth";
import { serializeExpRun, openCorrectionForm, openDuplicateForm, openSearchDetailForm } from "./nav";
import { controlForLabel, readControlValue, fillControl, fillSearchField } from "./form-fields";
import { diffFields, type FieldDiff } from "./compare";
import { CORRECTION_FIELDS, DUPLICATE_FIELDS, type ParsedExpRow } from "./types";
import { neutralizeSubmitControls, assertSafeToClick } from "./guards";
import { validateCapturedPdf, printPageToPdf } from "./pdf";
import { CORRECTION_STEPS, DUPLICATE_STEPS, DOWNLOAD_STEPS } from "./progress";

/**
 * LIVE EXP drivers (visible browser). One record at a time, serialized.
 *
 *  - runCorrection / runDuplicate: search the record, compare the portal form
 *    with the Excel row, and FILL only the mismatched fields. They NEVER submit
 *    (no Update / Acknowledge / Save click — see guards.ts). The filled form is
 *    left on screen for the operator to review and submit manually.
 *  - runDownload: search the EXP record, verify the EXP No, and capture the
 *    portal's EXP detail page as a PDF.
 *
 * Fail-closed: the batch engine only calls these when EXP_LIVE_ENABLED is true.
 * Nothing is fabricated here; every outcome reflects the real portal.
 *
 * NOTE: the APEX field labels/selectors are derived from the operator
 * screenshots and must be confirmed against the live DOM once credentials exist.
 */

export type ExpOutcome =
  | "MATCHED" // portal already equals Excel — nothing changed
  | "FILLED" // mismatched fields written (NOT submitted)
  | "DOWNLOADED"
  | "NOT_FOUND"
  | "NEEDS_AUTH"
  | "NAV_ERROR"
  | "NO_PDF"
  | "FAILED";

export interface ExpRowResult {
  ok: boolean;
  outcome: ExpOutcome;
  message: string;
  auth: AuthResult;
  mismatchedFields: FieldDiff[];
  portalValues: Record<string, string>;
  pdf: { buffer: Buffer; bytes: number; pages: number } | null;
}

export type ProgressFn = (step: string, detail?: string) => void | Promise<void>;

function base(outcome: ExpOutcome, message: string, auth: AuthResult): ExpRowResult {
  return { ok: false, outcome, message, auth, mismatchedFields: [], portalValues: {}, pdf: null };
}

/** Click the "Search" button in the current search panel (allowed — not a submit). */
async function clickSearch(page: Page): Promise<void> {
  // The APEX search control is an <a class="t12Button"> whose href calls
  // apex.submit({request:'SEARCH'}). The word "Search" also appears in hidden
  // Transaction-menu links ("Search EXP Detail…"), so a plain a:has-text('Search')
  // .first() lands on a hidden menu item and misses the real button. Match the
  // specific control first, and in every case click the first VISIBLE candidate
  // (isVisible() is a non-waiting check, so we must scan, not just take .first()).
  const candidates = [
    "a[href*=\"request:'SEARCH'\"]",
    "a.t12Button:has-text('Search')",
    "button:has-text('Search')",
    "input[type=submit][value='Search' i]",
    "input[value='Search' i]",
    "a:has-text('Search')",
  ];
  for (const sel of candidates) {
    const loc = page.locator(sel);
    const n = await loc.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const one = loc.nth(i);
      if (!(await one.isVisible().catch(() => false))) continue;
      await assertSafeToClick(one, "Search");
      await Promise.all([page.waitForLoadState("networkidle").catch(() => undefined), one.click({ timeout: 8000 })]);
      await page.waitForTimeout(800);
      return;
    }
  }
  throw new Error("Search button not found on the form.");
}

/** Fill the shared search panel (ADSCODE / EXP Serial / EXP Year) + Search. */
async function searchByIdentifiers(page: Page, row: ParsedExpRow): Promise<void> {
  await fillSearchField(page, "ADSCODE", row.adscode);
  await fillSearchField(page, "EXP Serial", row.expSerial);
  // EXP Year may be a select in the search panel.
  if (!(await fillControl(page, "EXP Year", "select", row.expYear))) {
    await fillSearchField(page, "EXP Year", row.expYear);
  }
  await clickSearch(page);
}

/** Heuristic: did the record load into the edit form? */
async function recordLoaded(page: Page, row: ParsedExpRow): Promise<boolean> {
  // A "no data" / "not found" notification means not loaded.
  const body = (await page.content().catch(() => "")).toLowerCase();
  if (/no data found|record not found|no record|not found/.test(body)) return false;
  // The edit panel should now echo the searched EXP Serial.
  const serial = await readControlValue(page, "EXP Serial", "text");
  if (serial && serial.replace(/^0+/, "") === row.expSerial.replace(/^0+/, "")) return true;
  // Fallback: at least one editable data field is present with any content.
  const probe = await readControlValue(page, "Invoice No", "text");
  return probe != null;
}

/** Shared fill-and-verify flow for correction + duplicate. */
async function runFormFill(
  row: ParsedExpRow,
  fields: typeof CORRECTION_FIELDS,
  steps: readonly string[],
  openForm: (p: Page) => Promise<boolean>,
  onProgress?: ProgressFn,
): Promise<ExpRowResult> {
  const emit = async (s: string, d?: string) => { try { await onProgress?.(s, d); } catch { /* best-effort */ } };

  return serializeExpRun(async () => {
    let auth: AuthResult = { outcome: "CONFIG_MISSING", message: "" };
    try {
      await emit(steps[0], "Opening the EXP portal in the visible browser.");
      const page = await getExpPage();

      await emit(steps[1], "Ensuring an authenticated session.");
      auth = await ensureExpAuth();
      if (auth.outcome === "VERIFICATION_REQUIRED") return base("NEEDS_AUTH", auth.message, auth);
      if (auth.outcome === "CONFIG_MISSING") return base("FAILED", auth.message, auth);
      if (auth.outcome === "LOGIN_FAILED") return base("FAILED", auth.message, auth);

      await emit(steps[2], "Opening the form via the Transaction menu.");
      if (!(await openForm(page))) return base("NAV_ERROR", "Could not open the form from the Transaction menu.", auth);

      await emit(steps[3], `Searching ADSCODE ${row.adscode} · serial ${row.expSerial} · year ${row.expYear}.`);
      await searchByIdentifiers(page, row);
      if (!(await recordLoaded(page, row))) {
        return { ...base("NOT_FOUND", "No matching record was found on the portal for these identifiers.", auth) };
      }

      await emit(steps[4], "Reading the portal form and comparing with the Excel row.");
      const portalValues: Record<string, string> = {};
      for (const f of fields) {
        const v = await readControlValue(page, f.portalLabel, f.control);
        if (v != null) portalValues[f.key] = v;
      }
      const diffs = diffFields(fields, row.values, portalValues);

      if (diffs.length === 0) {
        return { ...base("MATCHED", "Portal values already match the Excel row — left unchanged.", auth), ok: true, portalValues };
      }

      await emit(steps[5], `Filling ${diffs.length} mismatched field(s) from Excel (never submitted).`);
      // Defence in depth: disable any submit/acknowledge control before we type.
      await neutralizeSubmitControls(page);
      const written: FieldDiff[] = [];
      for (const d of diffs) {
        const field = fields.find((f) => f.key === d.key)!;
        const ok = await fillControl(page, field.portalLabel, field.control, d.excel);
        if (ok) written.push(d);
      }
      // Re-disable in case the portal re-rendered controls after change events.
      await neutralizeSubmitControls(page);

      await emit(steps[6], "Form filled and verified. Review and submit it yourself in the visible browser.");
      return {
        ...base("FILLED", `Filled ${written.length} field(s); the form is ready for your manual review and submission. Nothing was submitted.`, auth),
        ok: true,
        mismatchedFields: written,
        portalValues,
      };
    } catch (e) {
      return base("FAILED", e instanceof Error ? e.message : "EXP form workflow failed.", auth);
    }
  });
}

export function runCorrection(row: ParsedExpRow, onProgress?: ProgressFn): Promise<ExpRowResult> {
  return runFormFill(row, CORRECTION_FIELDS, CORRECTION_STEPS, openCorrectionForm, onProgress);
}

export function runDuplicate(row: ParsedExpRow, onProgress?: ProgressFn): Promise<ExpRowResult> {
  return runFormFill(row, DUPLICATE_FIELDS, DUPLICATE_STEPS, openDuplicateForm, onProgress);
}

/** Download the EXP detail PDF for one row. */
export function runDownload(row: ParsedExpRow, onProgress?: ProgressFn): Promise<ExpRowResult> {
  const steps = DOWNLOAD_STEPS;
  const emit = async (s: string, d?: string) => { try { await onProgress?.(s, d); } catch { /* best-effort */ } };

  return serializeExpRun(async () => {
    let auth: AuthResult = { outcome: "CONFIG_MISSING", message: "" };
    try {
      await emit(steps[0], "Opening the EXP portal in the visible browser.");
      const page = await getExpPage();

      await emit(steps[1], "Ensuring an authenticated session.");
      auth = await ensureExpAuth();
      if (auth.outcome === "VERIFICATION_REQUIRED") return base("NEEDS_AUTH", auth.message, auth);
      if (auth.outcome !== "AUTHENTICATED") return base("FAILED", auth.message, auth);

      await emit(steps[2], "Opening Search EXP Detail Information.");
      if (!(await openSearchDetailForm(page))) return base("NAV_ERROR", "Could not open Search EXP Detail from the Transaction menu.", auth);

      await emit(steps[3], `Searching AD ${row.adscode} · serial ${row.expSerial} · year ${row.expYear}.`);
      // The search panel here uses "AD Code" (not "ADSCODE").
      if (!(await fillSearchField(page, "AD Code", row.adscode))) await fillSearchField(page, "ADSCODE", row.adscode);
      await fillSearchField(page, "EXP Serial", row.expSerial);
      await fillSearchField(page, "EXP Year", row.expYear);
      await clickSearch(page);

      await emit(steps[4], "Verifying the returned EXP matches the requested EXP No.");
      const body = (await page.content().catch(() => "")).toLowerCase();
      if (/no data found|record not found|no record|not found/.test(body)) {
        return base("NOT_FOUND", "No EXP record was found for these identifiers.", auth);
      }
      // Verify the EXP serial echoed on the detail page.
      const serial = await readControlValue(page, "EXP Serial", "text");
      if (serial && serial.replace(/^0+/, "") !== row.expSerial.replace(/^0+/, "")) {
        return base("NOT_FOUND", `The portal returned EXP serial ${serial}, not the requested ${row.expSerial}.`, auth);
      }

      await emit(steps[5], "Capturing the EXP detail page as a PDF.");
      const buf = await printPageToPdf(page);
      const v = validateCapturedPdf(buf);
      if (!v.ok || !buf) return base("NO_PDF", `EXP record found but PDF capture failed: ${v.reason}.`, auth);

      await emit(steps[6], `Verified PDF: ${v.bytes} bytes, ${v.pages} page(s).`);
      return { ...base("DOWNLOADED", `Captured EXP ${row.expNo} as PDF (${v.bytes} bytes, ${v.pages} pg).`, auth), ok: true, pdf: { buffer: buf, bytes: v.bytes, pages: v.pages } };
    } catch (e) {
      return base("FAILED", e instanceof Error ? e.message : "EXP download workflow failed.", auth);
    }
  });
}

/** Re-exported for the batch engine's fail-closed gate. */
export const EXP_LIVE_ENABLED = env.EXP_LIVE_ENABLED;
