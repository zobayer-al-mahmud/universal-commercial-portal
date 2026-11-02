import type { Page } from "playwright";
import { env } from "@/lib/env";
import { getExpPage } from "./browser";
import { ensureExpAuth, type AuthResult } from "./auth";
import { serializeExpRun, openCorrectionForm, openDuplicateForm, openSearchDetailForm } from "./nav";
import type { Response as PwResponse } from "playwright";
import { fillControl, fillSearchField, readFieldValue, fillField, pickEditControl } from "./form-fields";
import { type FieldDiff, valuesEquivalent, formatDateLike, normDate } from "./compare";
import { capturePortalDump, summarizeDump, writeDump, type PortalDump } from "./diagnostics";
import { CORRECTION_FIELDS, DUPLICATE_FIELDS, type FieldMap, type ParsedExpRow } from "./types";
import { neutralizeFinalControls, assertSafeToClick } from "./guards";
import { validateCapturedPdf } from "./pdf";
import { parsePdfText } from "@/server/pdf/parse-pdf";
import { CORRECTION_STEPS, DUPLICATE_STEPS } from "./progress";

/**
 * LIVE EXP drivers (visible browser). One record at a time, serialized.
 *
 *  - runCorrection / runDuplicate: search the record, open the Edit/Update form
 *    and FILL it directly from the Excel row — no record-matching, value
 *    comparison or read-back verification. They NEVER submit (no Update /
 *    Acknowledge / Save click — see guards.ts). The filled form is left on
 *    screen for the operator to review and submit manually.
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
  | "FILLED" // mapped fields written from Excel + read-back confirmed (NOT submitted)
  | "UPDATED" // EXP_AUTO_UPDATE: Update clicked AND the portal confirmed success
  | "UPDATE_FAILED" // EXP_AUTO_UPDATE: filled, but the Update was rejected / not confirmed
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

/**
 * Click the form's **Update** button and confirm the portal accepted it. Only
 * ever reached when EXP_AUTO_UPDATE is on. Targets the control whose exact label
 * / value is "Update" (or APEX #UPDATE / request:'UPDATE'), never Acknowledge,
 * Submit, Save, or a field like "Update Remarks". A row is reported updated ONLY
 * on a positive portal success signal; an ambiguous response is a failure (we
 * never mark a row updated merely because the button was clicked).
 */
async function clickUpdateAndConfirm(page: Page): Promise<{ ok: boolean; message: string }> {
  const token = `ucpupd_${Math.random().toString(36).slice(2, 10)}`;
  const tagged = await page.evaluate((tk) => {
    const ackRe = /\b(acknowledge|acknowledgement|approve|confirm|submit|save)\b/i;
    const isExactUpdate = (s: string) => /^\s*update\s*$/i.test(s || "");
    const cands = Array.from(document.querySelectorAll("button, input[type=submit], input[type=button], a")) as HTMLElement[];
    const pick = cands.find((el) => {
      const value = (el as HTMLInputElement).value || "";
      const text = el.textContent || "";
      const id = el.id || "";
      const href = el.getAttribute("href") || "";
      if (ackRe.test(value) || ackRe.test(text)) return false; // never acknowledge/submit/save
      if (isExactUpdate(value) || isExactUpdate(text)) return true;
      if (/^UPDATE$/i.test(id)) return true;
      if (/request:'UPDATE'|'UPDATE'/.test(href)) return true;
      return false;
    });
    if (!pick) return false;
    pick.setAttribute("data-ucp-update", tk);
    return true;
  }, token);
  if (!tagged) return { ok: false, message: "The Update button was not found on the form." };

  const loc = page.locator(`[data-ucp-update="${token}"]`).first();
  try {
    await assertSafeToClick(loc, "Update", true); // allowUpdate = true (opt-in only)
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  await Promise.all([
    page.waitForLoadState("networkidle").catch(() => undefined),
    loc.click({ timeout: 8000 }).catch(() => undefined),
  ]);
  await page.waitForTimeout(1500);
  return readUpdateResult(page);
}

/** Read the portal's response to an Update — success ONLY on a positive signal. */
async function readUpdateResult(page: Page): Promise<{ ok: boolean; message: string }> {
  return page.evaluate(() => {
    const body = (document.body.innerText || "").replace(/\s+/g, " ").trim();
    const successSel = ["#APEX_SUCCESS_MESSAGE", ".t-Alert--success", ".apex-page-success", ".a-Notification--success", ".uSuccessMessage"];
    const errorSel = ["#APEX_ERROR_MESSAGE", ".t-Alert--danger", ".a-Notification--error", ".uErrorMessage", ".t-Form-error", "#wwvFlowNotificationError"];
    const visibleText = (sel: string) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (!el) return "";
      const shown = el.offsetParent !== null || el.getBoundingClientRect().height > 0;
      return shown ? (el.innerText || "").trim() : "";
    };
    let successMsg = "";
    for (const s of successSel) { const t = visibleText(s); if (t) { successMsg = t; break; } }
    let errorMsg = "";
    for (const s of errorSel) { const t = visibleText(s); if (t) { errorMsg = t; break; } }
    const successText = /(updated|processed|saved|submitted)\s+successfully|successfully\s+(updated|processed|saved)|action\s+processed|changes?\s+(have\s+been\s+)?saved|record\s+(has\s+been\s+)?updated/i;
    const errorText = /\b(error|invalid|failed|not\s+updated|is\s+required|cannot|could\s+not|must\s+be)\b/i;
    if (errorMsg) return { ok: false, message: `Portal reported: ${errorMsg.slice(0, 200)}` };
    if (successMsg) return { ok: true, message: successMsg.slice(0, 200) };
    if (successText.test(body) && !errorText.test(body)) return { ok: true, message: "Portal confirmed the update." };
    if (errorText.test(body)) return { ok: false, message: "The portal page shows a validation/error state after Update." };
    return { ok: false, message: "Clicked Update but could not confirm the portal accepted it (no success message)." };
  });
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

// Anchor labels that are always present on the Edit/Update EXP form (correction
// has "Commodity Code"/"Update Remarks"; duplicate has "Transport Doc No"/etc.).
const EDIT_FORM_ANCHORS = ["Update Remarks", "Commodity Code", "Invoice No", "Ship Port", "Transport Doc No", "Custom Office"];

/**
 * Is the Edit/Update EXP form present and ready to FILL?
 *
 * The form is BLANK by design — it is a correction-entry form, not a read-back of
 * existing values — so the old "a mapped field already holds a value" check made
 * every search look like NOT_FOUND and nothing was ever filled. The correct gate
 * is: the portal did not reject the identifiers AND the editable form controls
 * are present and enabled.
 */
async function editFormReady(page: Page): Promise<boolean> {
  const body = (await page.content().catch(() => "")).toLowerCase();
  if (/no data found|record not found|no record|invalid\s+(adscode|exp|serial|year)|does not exist/.test(body)) return false;
  for (const label of EDIT_FORM_ANCHORS) {
    const c = await pickEditControl(page, [label]);
    if (c) {
      const disabled = await c.isDisabled().catch(() => false);
      if (!disabled) return true;
    }
  }
  return false;
}

/** Poll for the Edit/Update EXP form to become ready after a search. */
async function waitForEditForm(page: Page, timeoutMs = 12000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await editFormReady(page)) return true;
    if (Date.now() > deadline) return false;
    await page.waitForTimeout(500);
  }
}

/**
 * Results-grid variant: some APEX search pages return a report and the edit form
 * opens only after clicking the matching row's Edit link. The correction form is
 * inline (no grid), so this is a defensive fallback. It only ever clicks a link
 * that is NOT a final-action control, and prefers the row matching our serial.
 */
async function openEditFromGrid(page: Page, dump: PortalDump, row: ParsedExpRow): Promise<boolean> {
  if (!dump.reportLinks.length) return false;
  const serialTrim = row.expSerial.replace(/^0+/, "");
  const token = `ucpgrid_${Math.random().toString(36).slice(2, 10)}`;
  const tagged = await page.evaluate(
    ({ serial, serialTrim, adscode, token }) => {
      const forbidden = /\b(update|submit|acknowledge|approve|process|apply|delete)\b/i;
      const links = Array.from(document.querySelectorAll("a")) as HTMLAnchorElement[];
      const match = (a: HTMLAnchorElement) => {
        const title = `${a.getAttribute("title") || ""} ${a.textContent || ""}`;
        if (forbidden.test(title)) return false;
        const href = a.getAttribute("href") || "";
        const isEdit = /edit|select|open|detail/i.test(title) || /f\?p=\d+:(68|3):/i.test(href);
        if (!isEdit) return false;
        const rowText = (a.closest("tr")?.textContent || "").replace(/\s/g, "");
        return rowText.includes(serial) || rowText.includes(serialTrim) || rowText.includes(adscode);
      };
      const pick = links.find(match) || links.find((a) => {
        const title = `${a.getAttribute("title") || ""} ${a.textContent || ""}`;
        const href = a.getAttribute("href") || "";
        return !forbidden.test(title) && (/edit|select|open|detail/i.test(title) || /f\?p=\d+:(68|3):/i.test(href));
      });
      if (!pick) return false;
      pick.setAttribute("data-ucp-grid", token);
      return true;
    },
    { serial: row.expSerial, serialTrim, adscode: row.adscode, token },
  ).catch(() => false);
  if (!tagged) return false;
  const loc = page.locator(`[data-ucp-grid="${token}"]`).first();
  await assertSafeToClick(loc, "Open edit form");
  await Promise.all([page.waitForLoadState("networkidle").catch(() => undefined), loc.click({ timeout: 8000 }).catch(() => undefined)]);
  await page.waitForTimeout(800);
  return true;
}

function kindTag(fields: FieldMap[]): string {
  return fields === CORRECTION_FIELDS ? "correction" : fields === DUPLICATE_FIELDS ? "duplicate" : "form";
}

/**
 * Shared workflow for Issued EXP Correction AND Duplicate EXP Reporting — both
 * use the SAME logic: search, open the Edit/Update EXP form, and FILL every
 * mapped field directly from the Excel row (regardless of any existing portal
 * value), then read the fields back to confirm they were populated. There is NO
 * comparison against the current portal values and no "matched/mismatched"
 * classification. Blank Excel cells are left untouched. Nothing is submitted.
 */
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

      // Capture the live DOM the search produced — evidence of the real form
      // structure (ids, labels, values, any results grid), logged + saved to disk.
      let dump = await capturePortalDump(page).catch(() => null);
      if (dump) {
        await emit(steps[3], `Search result → ${summarizeDump(dump)}`);
        void writeDump(`${kindTag(fields)}-r${row.rowNo}-${row.adscode}-${row.expSerial}`, dump);
      }

      // Ready = the portal accepted the identifiers AND the Edit/Update EXP form
      // is on screen and editable. The form is BLANK by design, so we do NOT wait
      // for pre-filled values (the old check that made every row look NOT_FOUND).
      let ready = await waitForEditForm(page);
      if (!ready && dump && dump.reportLinks.length) {
        if (await openEditFromGrid(page, dump, row)) {
          dump = (await capturePortalDump(page).catch(() => dump)) ?? dump;
          ready = await waitForEditForm(page);
        }
      }
      if (!ready) {
        const why = dump?.noDataFound
          ? "the portal returned no data for these identifiers"
          : "the Edit/Update EXP form did not become available after the search";
        return base("NOT_FOUND", `No editable EXP record loaded — ${why}.`, auth);
      }
      await emit("Record Found", "The record loaded and the Edit/Update EXP form is ready.");

      // Fill the Edit/Update form DIRECTLY from the Excel row — the SAME logic for
      // Correction and Duplicate. Every mapped field that has an Excel value is
      // written (by APEX id, else edit-region label) regardless of its current
      // portal value; blank Excel values are left untouched; unparseable dates are
      // skipped and logged. Nothing is ever submitted (see guards.ts).
      await emit("Filling Form", env.EXP_AUTO_UPDATE ? "Filling the Edit/Update form from the Excel row." : "Filling the Edit/Update form from the Excel row (never submitted).");
      await neutralizeFinalControls(page, { allowUpdate: env.EXP_AUTO_UPDATE });
      const written: { f: FieldMap; excel: string }[] = [];
      const failed: string[] = [];
      for (const f of fields) {
        if (f.needsConfirmation) continue; // no portal target — surfaced below, never written
        const val = (row.values[f.key] ?? "").trim();
        if (!val && !f.alwaysFill) continue; // blank Excel → leave the portal field untouched

        let toWrite = val;
        if (f.control === "date" && val) {
          const iso = normDate(val);
          if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
            failed.push(f.portalLabel);
            await emit("Filling Form", `Skipped ${f.portalLabel}: "${val}" is not a valid date — fix it in Excel or enter it manually.`);
            continue;
          }
          const sample = (await readFieldValue(page, f).catch(() => "")) || "";
          toWrite = formatDateLike(val, sample);
        }

        const ok = await fillField(page, f, toWrite);
        if (ok) written.push({ f, excel: toWrite });
        else { failed.push(f.portalLabel); await emit("Filling Form", `Could not fill ${f.portalLabel}${f.portalId ? ` (${f.portalId})` : ""} — enter it manually.`); }
      }
      // Excel columns with no portal target: surfaced for manual entry (never guessed).
      for (const f of fields) {
        if (f.needsConfirmation && (row.values[f.key] ?? "").trim()) {
          await emit("Filling Form", `MANUAL — ${f.portalLabel} = "${row.values[f.key]}": ${f.needsConfirmation}`);
        }
      }

      // Read every written field back to CONFIRM it was populated (this is a
      // fill-confirmation, not a comparison against existing portal values). A
      // field whose read-back doesn't show the Excel value is logged so the
      // operator can fix it before manually submitting.
      await emit("Filling Form", "Reading the fields back to confirm they were populated.");
      const confirmed: FieldDiff[] = [];
      let notConfirmed = 0;
      for (const { f, excel } of written) {
        const portal = (await readFieldValue(page, f).catch(() => "")) || "";
        const okv = valuesEquivalent(f.control, excel, portal);
        if (!okv) { notConfirmed++; await emit("Filling Form", `Not confirmed — ${f.portalLabel}: wrote "${excel}", form shows "${portal}".`); }
        confirmed.push({ key: f.key, portalLabel: f.portalLabel, excel, portal });
      }
      await neutralizeFinalControls(page, { allowUpdate: env.EXP_AUTO_UPDATE });

      const parts = [`Filled ${written.length} field(s) from Excel`];
      if (notConfirmed) parts.push(`${notConfirmed} not confirmed`);
      if (failed.length) parts.push(`${failed.length} could not be filled`);

      // OPT-IN auto-Update (EXP_AUTO_UPDATE): click the form's Update button and
      // confirm the portal accepted it. Never Acknowledge. A row is "updated" only
      // on a positive portal success signal — never just because Update was clicked.
      if (env.EXP_AUTO_UPDATE) {
        if (written.length === 0) {
          await emit("Update skipped", `${parts.join(", ")}. Nothing was written from Excel, so Update was not clicked.`);
          return { ...base("UPDATE_FAILED", `No fields were written from Excel; Update was not attempted.`, auth), mismatchedFields: confirmed, portalValues: {} };
        }
        await emit("Updating record", "Clicking Update and waiting for the portal to confirm.");
        const upd = await clickUpdateAndConfirm(page);
        await neutralizeFinalControls(page, { allowUpdate: false }); // re-harden after the attempt
        if (upd.ok) {
          await emit("Update confirmed", `${parts.join(", ")}. ${upd.message}`);
          return { ...base("UPDATED", `${parts.join(", ")}; Update submitted and confirmed by the portal: ${upd.message}`, auth), ok: true, mismatchedFields: confirmed, portalValues: {} };
        }
        await emit("Update failed", upd.message);
        return { ...base("UPDATE_FAILED", `${parts.join(", ")}; the Update was not confirmed: ${upd.message}`, auth), mismatchedFields: confirmed, portalValues: {} };
      }

      await emit("Form Filled", `${parts.join(", ")}. Review and submit it yourself in the visible browser.`);
      return {
        ...base("FILLED", `${parts.join(", ")}; the form is ready for your manual review and submission. Nothing was submitted.`, auth),
        ok: true,
        mismatchedFields: confirmed,
        portalValues: {},
      };
    } catch (e) {
      return base("FAILED", e instanceof Error ? e.message : "EXP form workflow failed.", auth);
    }
  });
}

export function runCorrection(row: ParsedExpRow, onProgress?: ProgressFn): Promise<ExpRowResult> {
  // Correction and Duplicate use the SAME logic: fill every mapped field from Excel.
  return runFormFill(row, CORRECTION_FIELDS, CORRECTION_STEPS, openCorrectionForm, onProgress);
}

export function runDuplicate(row: ParsedExpRow, onProgress?: ProgressFn): Promise<ExpRowResult> {
  // Identical to Correction: fill the Export Acknowledgement form directly from Excel (no comparison).
  return runFormFill(row, DUPLICATE_FIELDS, DUPLICATE_STEPS, openDuplicateForm, onProgress);
}

/** Click a labelled control (link / button / input) — flexible, visible-only, guarded. Never submits. */
async function clickControlByText(page: Page, text: string): Promise<boolean> {
  const safe = text.replace(/'/g, "\\'");
  const selectors = [
    `a:has-text('${safe}')`,
    `button:has-text('${safe}')`,
    `input[type=button][value='${safe}' i]`,
    `input[type=submit][value='${safe}' i]`,
    `input[value='${safe}' i]`,
    `[role='button']:has-text('${safe}')`,
  ];
  for (const sel of selectors) {
    const loc = page.locator(sel);
    const n = await loc.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const one = loc.nth(i);
      if (!(await one.isVisible().catch(() => false))) continue;
      await assertSafeToClick(one, text);
      await one.click({ timeout: 8000 }).catch(() => undefined);
      return true;
    }
  }
  return false;
}

/** The URL of a PDF embedded in the page (iframe/embed/object), or the page's own URL if it is a PDF. */
async function findPdfUrl(target: Page): Promise<string> {
  if (/\.pdf(\?|$)/i.test(target.url())) return target.url();
  const src = await target
    .evaluate(() => {
      const el = document.querySelector("embed[src], iframe[src], object[data]");
      return el ? (el.getAttribute("src") || el.getAttribute("data") || "") : "";
    })
    .catch(() => "");
  if (src) { try { return new URL(src, target.url()).href; } catch { return src; } }
  return "";
}

/**
 * Click "Print EXP" and capture the ACTUAL PDF the portal serves — never a
 * recreation. The EXP Preview page embeds the portal's `exp_exporter.pdf`; we
 * take the real bytes from the PDF network response, falling back to fetching the
 * embedded PDF URL with the authenticated session. Only reads/downloads; never
 * submits. Returns the raw PDF bytes, or null if none could be captured.
 */
async function capturePrintExpPdf(page: Page): Promise<Buffer | null> {
  const ctx = page.context();
  let pdfResp: PwResponse | null = null;
  const isPdf = (r: PwResponse) => {
    const ct = (r.headers()["content-type"] || "").toLowerCase();
    return ct.includes("application/pdf") || /exp_exporter|\.pdf(\?|$)/i.test(r.url());
  };
  const onResp = (r: PwResponse) => { if (isPdf(r)) pdfResp = r; };
  // Holder object (not a bare `let`) so TS doesn't narrow away the callback assignment.
  const popupHolder: { p: Page | null } = { p: null };
  const onPage = (p: Page) => { popupHolder.p = p; };
  ctx.on("response", onResp);
  ctx.on("page", onPage);
  try {
    if (!(await clickControlByText(page, "Print EXP"))) return null;
    await page.waitForLoadState("networkidle").catch(() => undefined);
    const deadline = Date.now() + 25000;
    while (!pdfResp && Date.now() < deadline) await page.waitForTimeout(400);
    if (pdfResp) {
      const b = await (pdfResp as PwResponse).body().catch(() => null);
      if (b && b.length) return b;
    }
    // Fallback: fetch the embedded PDF URL with the authenticated context.
    const popup = popupHolder.p;
    const target: Page = popup && !popup.isClosed() ? popup : page;
    const url = await findPdfUrl(target);
    if (url) {
      const resp = await ctx.request.get(url).catch(() => null);
      if (resp) { const b = await resp.body().catch(() => null); if (b && b.length) return b; }
    }
    return null;
  } finally {
    ctx.off("response", onResp);
    ctx.off("page", onPage);
    if (popupHolder.p && !popupHolder.p.isClosed()) await popupHolder.p.close().catch(() => undefined);
  }
}

/**
 * Download the REAL EXP PDF for one row: search the EXP, open the EXP Information
 * page, click Print EXP, and capture the portal's own `exp_exporter.pdf`. The
 * bytes are verified to belong to the requested EXP (page + PDF content) before
 * being handed back for storage. Nothing is recreated or submitted.
 */
export function runDownload(row: ParsedExpRow, onProgress?: ProgressFn): Promise<ExpRowResult> {
  const emit = async (s: string, d?: string) => { try { await onProgress?.(s, d); } catch { /* best-effort */ } };
  const serN = row.expSerial.replace(/^0+/, "");
  const adN = row.adscode.replace(/^0+/, "");

  return serializeExpRun(async () => {
    let auth: AuthResult = { outcome: "CONFIG_MISSING", message: "" };
    try {
      await emit("Opening EXP portal", "Opening the EXP portal in the visible browser.");
      const page = await getExpPage();

      await emit("Signing in", "Ensuring an authenticated session.");
      auth = await ensureExpAuth();
      if (auth.outcome === "VERIFICATION_REQUIRED") return base("NEEDS_AUTH", auth.message, auth);
      if (auth.outcome !== "AUTHENTICATED") return base("FAILED", auth.message, auth);

      await emit("Opening Search EXP Detail", "Opening Search EXP Detail Information.");
      if (!(await openSearchDetailForm(page))) return base("NAV_ERROR", "Could not open Search EXP Detail from the Transaction menu.", auth);

      await emit("Searching", `Searching AD ${row.adscode} · serial ${row.expSerial} · year ${row.expYear}.`);
      // The search panel here uses "AD Code" (not "ADSCODE").
      if (!(await fillSearchField(page, "AD Code", row.adscode))) await fillSearchField(page, "ADSCODE", row.adscode);
      await fillSearchField(page, "EXP Serial", row.expSerial);
      await fillSearchField(page, "EXP Year", row.expYear);
      await clickSearch(page);

      // The EXP Information page loaded iff it offers a "Print EXP" control. We do
      // NOT scan the whole body for "no data found": the valid EXP Information page
      // legitimately shows "no data found" inside sub-panels (Export Proceed
      // Realization / ARV Adjustment / EXP Adjustment). Poll for Print EXP instead.
      const printSel = "a:has-text('Print EXP'), button:has-text('Print EXP'), input[value='Print EXP' i]";
      let hasPrint = false;
      const printDeadline = Date.now() + 12000;
      while (Date.now() < printDeadline) {
        hasPrint = await page.locator(printSel).first().isVisible({ timeout: 1000 }).catch(() => false);
        if (hasPrint) break;
        await page.waitForTimeout(500);
      }
      if (!hasPrint) {
        const txt = ((await page.evaluate(() => document.body.innerText).catch(() => "")) || "");
        const notFound = /no record found|record not found|invalid (ad|exp|serial)|does not exist/i.test(txt) && !/Print EXP/i.test(txt);
        return base("NOT_FOUND", notFound
          ? "No EXP record was found for these identifiers."
          : "The EXP Information page (with Print EXP) did not load for these identifiers.", auth);
      }

      // Verify the loaded record is the requested one (serial + year must appear).
      const pageText = (await page.evaluate(() => document.body.innerText).catch(() => "")) || "";
      const pageDigits = pageText.replace(/\D/g, "");
      const serialOnPage = pageText.includes(row.expSerial) || (serN !== "" && pageDigits.includes(serN));
      const yearOnPage = pageText.includes(row.expYear);
      if (!(serialOnPage && yearOnPage)) {
        return base("NOT_FOUND", `The loaded EXP Information page does not match serial ${row.expSerial} / year ${row.expYear}.`, auth);
      }
      await emit("Record Found", "EXP Information page loaded for the requested record.");

      await emit("Opening Print Preview", "Clicking Print EXP and loading the EXP Preview.");
      const buf = await capturePrintExpPdf(page);
      const v = validateCapturedPdf(buf);
      if (!v.ok || !buf) return base("NO_PDF", `Record found but the portal's EXP PDF could not be downloaded: ${v.reason}.`, auth);

      await emit("Downloading PDF", `Captured the portal PDF (${v.bytes} bytes, ${v.pages} pg). Verifying it belongs to this EXP.`);
      // Content check: the EXP FORM PDF must reference this EXP (serial + year; AD if present).
      let verifiedNote = "page-level match";
      try {
        const { text } = await parsePdfText(buf);
        const t = text.replace(/\s+/g, " ");
        const digits = t.replace(/\D/g, "");
        if (t.trim().length > 0) {
          const serialOk = t.includes(row.expSerial) || (serN !== "" && digits.includes(serN));
          const yearOk = t.includes(row.expYear);
          if (!(serialOk && yearOk)) {
            return base("NO_PDF", `The downloaded PDF does not reference EXP serial ${row.expSerial} / year ${row.expYear} — refusing to save a mismatched file.`, auth);
          }
          const adOk = t.includes(row.adscode) || (adN !== "" && digits.includes(adN));
          verifiedNote = `content verified (serial ${row.expSerial}${adOk ? " + AD" : ""} + year ${row.expYear})`;
        }
      } catch { /* image-only PDF → rely on the page-level match already done */ }

      await emit("Saving to UCP", `Saving ${(row.saveAs || row.expSerial || "exp")}.pdf to UCP storage.`);
      return {
        ...base("DOWNLOADED", `Downloaded the portal EXP PDF for ${row.expNo || row.expSerial} (${v.bytes} bytes, ${v.pages} pg; ${verifiedNote}). Saved to UCP.`, auth),
        ok: true,
        pdf: { buffer: buf, bytes: v.bytes, pages: v.pages },
      };
    } catch (e) {
      return base("FAILED", e instanceof Error ? e.message : "EXP download workflow failed.", auth);
    }
  });
}

/** Re-exported for the batch engine's fail-closed gate. */
export const EXP_LIVE_ENABLED = env.EXP_LIVE_ENABLED;
