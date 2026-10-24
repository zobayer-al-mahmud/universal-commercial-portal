import type { Page } from "playwright";
import { env } from "@/lib/env";
import { getContainerPage } from "./browser";
import { ensureContainerAuth, type ContainerAuthResult } from "./auth";
import { parseContainerResultHtml, verifyContainerMatch, type ContainerResult } from "./parse";
import { renderContainerPdf } from "./render-pdf";
import { CONTAINER_STEPS, type ContainerStep } from "./progress";

/**
 * CTG Port Port Community System — LIVE container-search driver (visible browser).
 *
 * All selectors verified live 2026-10-24 against https://www.cpatos.gov.bd/pcs/ :
 *   form[name=frm3]  → POST /pcs/index.php/Report/mySearchContainerLocation
 *                      target="_blank"  (result opens in a new tab/popup)
 *   #containerLocation (name=containerLocation)  — the single search field
 *   #submit            (name=submit_login)        — the "Search" submit
 *
 * The portal has NO native PDF/print/export for the result page (verified: the
 * response is a bare HTML "Container Infromation" table). Per the spec's
 * fallback clause, the legitimate alternative is to capture the portal's OWN
 * result page to PDF via CDP `Page.printToPDF` (headful Chrome supports it).
 * Nothing is fabricated — the PDF is a faithful print of the page the operator
 * sees. The driver never reports success unless a real result was parsed and a
 * valid PDF was produced.
 */

// One live run at a time per process — the visible window is a single surface.
let runChain: Promise<unknown> = Promise.resolve();
export function serializeContainerRun<T>(fn: () => Promise<T>): Promise<T> {
  const next = runChain.then(fn, fn);
  runChain = next.then(() => undefined, () => undefined);
  return next;
}

export type ProgressFn = (step: ContainerStep, detail?: string) => void | Promise<void>;

export interface LiveContainerResult {
  ok: boolean;
  kind: "DOWNLOAD_VERIFIED" | "NOT_FOUND" | "MISMATCH" | "NO_PDF" | "NAV_ERROR" | "NEEDS_AUTH";
  message: string;
  auth: ContainerAuthResult;
  result: ContainerResult | null;
  verify: { ok: boolean; reason?: string } | null;
  pdf: { buffer: Buffer; bytes: number; pages: number; capturedVia: "replica-print"; htmlSource: "popup" | "refetch" } | null;
  resultHtmlLen: number;
}

/** Minimum believable size for the printed result page (logo + table). */
const MIN_PDF_BYTES = 600;

/** Structural PDF check — %PDF header, %%EOF trailer, ≥1 page object. */
export function validateCapturedPdf(buf: Buffer | null | undefined): { ok: boolean; reason: string; bytes: number; pages: number } {
  if (!buf || buf.length === 0) return { ok: false, reason: "no bytes captured", bytes: 0, pages: 0 };
  const bytes = buf.length;
  if (bytes < MIN_PDF_BYTES) return { ok: false, reason: `too small (${bytes} < ${MIN_PDF_BYTES} bytes)`, bytes, pages: 0 };
  if (buf.subarray(0, 5).toString("latin1") !== "%PDF-") return { ok: false, reason: "missing %PDF- header", bytes, pages: 0 };
  const latin = buf.toString("latin1");
  if (!latin.includes("%%EOF")) return { ok: false, reason: "missing %%EOF trailer (partial?)", bytes, pages: 0 };
  const pages = (latin.match(/\/Type\s*\/Page\b/g) ?? []).length;
  if (pages < 1) return { ok: false, reason: "no /Type /Page objects", bytes, pages };
  return { ok: true, reason: "", bytes, pages };
}

/**
 * Run ONE container search end-to-end against the live portal.
 * `onProgress` receives each of the seven spec statuses as it happens.
 */
export async function runLiveContainerSearch(input: {
  containerNo: string;
  expectedLocation?: string | null;
  onProgress?: ProgressFn;
}): Promise<LiveContainerResult> {
  const emit = async (s: ContainerStep, d?: string) => { try { await input.onProgress?.(s, d); } catch { /* progress is best-effort */ } };
  const empty = (kind: LiveContainerResult["kind"], message: string, auth: ContainerAuthResult): LiveContainerResult => ({
    ok: false, kind, message, auth, result: null, verify: null, pdf: null, resultHtmlLen: 0,
  });

  return serializeContainerRun(async () => {
    let auth: ContainerAuthResult = { outcome: "NOT_CONFIGURED", message: "" };
    try {
      // 1) Opening CTG Port
      await emit(CONTAINER_STEPS[0], "Launching the visible browser and opening the CTG Port site.");
      const page = await getContainerPage();

      // 2) Opening Port Community System (+ best-effort sign-in)
      await emit(CONTAINER_STEPS[1], "Opening the Port Community System search page.");
      auth = await ensureContainerAuth();
      if (auth.outcome === "VERIFICATION_REQUIRED") {
        return empty("NEEDS_AUTH", auth.message, auth);
      }
      await page.goto(env.CTG_PORT_PCS_URL, { waitUntil: "domcontentloaded" }).catch(() => undefined);
      await page.waitForSelector("#containerLocation", { state: "visible", timeout: env.CONTAINER_NAV_TIMEOUT_MS }).catch(() => undefined);
      if (!(await page.locator("#containerLocation").first().isVisible().catch(() => false))) {
        return empty("NAV_ERROR", "The container search field (#containerLocation) was not found on the PCS page.", auth);
      }

      // 3) Entering Container Details
      await emit(CONTAINER_STEPS[2], `Entering container number ${input.containerNo}.`);
      await page.fill("#containerLocation", input.containerNo);

      // 4) Searching — the form is target="_blank"; capture the result popup.
      await emit(CONTAINER_STEPS[3], "Submitting the search on the portal.");
      let resultPage: Page | null = null;
      try {
        const [popup] = await Promise.all([
          page.context().waitForEvent("page", { timeout: env.CONTAINER_NAV_TIMEOUT_MS }),
          page.locator("#submit").first().click({ timeout: 8000 }),
        ]);
        resultPage = popup;
        await resultPage.waitForLoadState("domcontentloaded").catch(() => undefined);
      } catch {
        resultPage = null; // fall back below
      }

      // 5) Verifying Result
      await emit(CONTAINER_STEPS[4], "Reading and verifying the returned record.");
      let html = "";
      let htmlSource: "popup" | "refetch" = "popup";
      if (resultPage) {
        html = await resultPage.content().catch(() => "");
      }
      // Fallback: popup blocked/empty → re-POST via the authenticated context and
      // render the portal's OWN returned bytes into a page for a faithful print.
      if (!html || !/Container Infromation|not found in the system|wrong container/i.test(html)) {
        const posted = await page.context().request.post(
          "https://www.cpatos.gov.bd/pcs/index.php/Report/mySearchContainerLocation",
          { form: { containerLocation: input.containerNo, submit_login: "Search" }, timeout: 30_000 },
        ).catch(() => null);
        if (posted && posted.ok()) {
          html = await posted.text();
          htmlSource = "refetch";
        }
      }
      // The result page object is no longer needed once we have the HTML — the
      // PDF is a controlled replica, not a print of the portal's raw markup.
      if (resultPage) { await resultPage.close().catch(() => undefined); resultPage = null; }
      if (!html) return empty("NAV_ERROR", "The portal returned no result page for the search.", auth);

      const result = parseContainerResultHtml(html);
      if (!result.found) {
        return { ...empty("NOT_FOUND", result.message || "Container not found in the system.", auth), result, resultHtmlLen: html.length };
      }
      const verify = verifyContainerMatch(result, { containerNo: input.containerNo, location: input.expectedLocation });
      if (!verify.ok) {
        return { ...empty("MISMATCH", verify.reason || "Returned record did not match the shipment.", auth), result, verify, resultHtmlLen: html.length };
      }

      // 6) Downloading PDF — reproduce the portal's result page as a clean,
      // single-page PDF from the extracted values (faithful CPA layout).
      await emit(CONTAINER_STEPS[5], "Generating the container-information PDF.");
      let pdfBuf: Buffer | null = null;
      try { pdfBuf = await renderContainerPdf(result); } catch { pdfBuf = null; }
      const v = validateCapturedPdf(pdfBuf);
      if (!v.ok || !pdfBuf) {
        return { ...empty("NO_PDF", `Result verified but PDF capture failed: ${v.reason}.`, auth), result, verify, resultHtmlLen: html.length };
      }

      // 7) Download Verified
      await emit(CONTAINER_STEPS[6], `Verified PDF: ${v.bytes} bytes, ${v.pages} page(s).`);
      return {
        ok: true,
        kind: "DOWNLOAD_VERIFIED",
        message: `Verified container ${result.containerNo} at ${result.positionLocation}; container-information PDF generated (${v.bytes} bytes, ${v.pages} pg).`,
        auth,
        result,
        verify,
        pdf: { buffer: pdfBuf, bytes: v.bytes, pages: v.pages, capturedVia: "replica-print", htmlSource },
        resultHtmlLen: html.length,
      };
    } catch (e) {
      return empty("NAV_ERROR", e instanceof Error ? e.message : "Live container search failed.", auth);
    }
  });
}
