import type { Download, Page, Response as PwResponse } from "playwright";
import { env } from "@/lib/env";
import { getDamcoPage } from "./damco-browser";
import { ensureAuthenticated, type AuthResult } from "./damco-auth";

/**
 * Damco Shipper Portal — LIVE booking workflow driver (visible browser).
 *
 * All selectors below were verified against the production portal (2026-10-20).
 * The driver is READ-oriented: it searches bookings and reads them back. It
 * never confirms, submits, or mutates a booking. The one state-changing thing
 * the portal offers — Generate PDF — only produces a document; it does not
 * change booking status. REQUESTED bookings are never presented as confirmed.
 *
 * Search keys (per the portal's real fields):
 *   - PO number  → #searchSO_PO_NO   (value + '*')
 *   - Country    → #searchSO_SKU     (the SKU/Item field; value + '*')
 */

const SEARCH_URL = "https://booking.damco.com/ShipperPortalWeb/SearchAction.action";

export interface LiveBooking {
  bookingNumber: string;
  bookingStatus: string; // CONFIRMED | REQUESTED | DELIVERED | ...
  confirmationNumber: string;
  submissionDate: string;
  deliveryDate: string;
  bookingReference: string;
}

export interface LiveSearchResult {
  ok: boolean;
  authRequired: boolean;
  noResults: boolean;
  message: string;
  bookings: LiveBooking[];
  resultCount: number;
}

export interface LiveSearchInput {
  poNumber: string;
  countryCode: string;
  companyMatch?: RegExp; // shipper option text
  buyerMatch?: RegExp; // consignee option text
}

async function selectParties(page: Page, input: LiveSearchInput): Promise<void> {
  const company = input.companyMatch ?? /ANANTA GARMENTS LIMITED/i;
  const buyer = input.buyerMatch ?? /GBC AB|SEHENNESMAHQ/i;
  await page.evaluate(
    ({ companySrc, buyerSrc }) => {
      const pick = (id: string, re: RegExp) => {
        const s = document.getElementById(id) as HTMLSelectElement | null;
        const opt = s ? [...s.options].find((o) => re.test(o.text)) : null;
        if (s && opt) {
          s.value = opt.value;
          s.dispatchEvent(new Event("change", { bubbles: true }));
        }
      };
      pick("finalShipperList", new RegExp(companySrc, "i"));
    },
    { companySrc: company.source, buyerSrc: buyer.source },
  );
  await page.waitForTimeout(1200); // shipper change repopulates consignee
  await page.evaluate(
    ({ buyerSrc }) => {
      const s = document.getElementById("finalConsigneeList") as HTMLSelectElement | null;
      const opt = s ? [...s.options].find((o) => new RegExp(buyerSrc, "i").test(o.text)) : null;
      if (s && opt) {
        s.value = opt.value;
        s.dispatchEvent(new Event("change", { bubbles: true }));
      }
    },
    { buyerSrc: buyer.source },
  );
  await page.waitForTimeout(600);
}

async function openBookingTab(page: Page): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await page.click("#tab_treetab2").catch(() => undefined);
    try {
      await page.waitForSelector("#searchSO_PO_NO", { state: "visible", timeout: 4000 });
      return;
    } catch {
      await page.waitForTimeout(500);
    }
  }
  throw new Error("Booking tab did not activate (searchSO_PO_NO not visible).");
}

function readGrid(page: Page): Promise<{ count: number; bookings: LiveBooking[]; noResults: boolean }> {
  return page.evaluate(() => {
    const body = (document.body.innerText || "").replace(/\s+/g, " ");
    const noResults = /No Booking found matching the search criteria/i.test(body);
    const m = body.match(/Result\s+[\d-]+\s+out of\s+(\d+)/i);
    const count = m ? Number(m[1]) : 0;
    const bookings: LiveBooking[] = [];
    for (const tr of [...document.querySelectorAll("tr")]) {
      const link = [...tr.querySelectorAll("a")].find((a) => /^\d{6,}$/.test((a.textContent || "").trim()));
      if (!link) continue;
      const cells = [...tr.querySelectorAll("td")].map((td) => td.textContent!.replace(/\s+/g, " ").trim());
      const num = (link.textContent || "").trim();
      const status = cells.find((c) => /^(CONFIRMED|REQUESTED|DELIVERED|CANCELLED|AMENDED|REJECTED)$/i.test(c)) || "";
      const conf = cells.find((c) => /^[A-Z]{2,4}\d{5,}$/.test(c)) || "";
      const dates = cells.filter((c) => /^\d{4}-\d{2}-\d{2}$/.test(c));
      bookings.push({
        bookingNumber: num,
        bookingStatus: status.toUpperCase(),
        confirmationNumber: conf,
        submissionDate: dates[0] || "",
        deliveryDate: dates[1] || "",
        bookingReference: "",
      });
    }
    return { count, bookings, noResults };
  });
}

/** Authenticate (visible browser) and search live bookings by PO + country. */
export async function liveSearchBookings(input: LiveSearchInput): Promise<LiveSearchResult> {
  const auth: AuthResult = await ensureAuthenticated();
  if (auth.outcome !== "AUTHENTICATED") {
    return { ok: false, authRequired: true, noResults: false, message: auth.message, bookings: [], resultCount: 0 };
  }
  const page = await getDamcoPage();
  await page.goto(SEARCH_URL, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);
  await page.evaluate("globalThis.__name = globalThis.__name || ((f) => f)");

  await selectParties(page, input);
  await openBookingTab(page);
  await page.fill("#searchSO_PO_NO", `${input.poNumber}*`);
  await page.fill("#searchSO_SKU", input.countryCode ? `${input.countryCode}*` : "");
  await page.click("#searchSObtn").catch(() => undefined);
  await page
    .waitForFunction(() => /Result\s+[\d-]+\s+out of\s+\d+/i.test(document.body.innerText) || /No Booking found matching the search criteria/i.test(document.body.innerText), { timeout: env.DAMCO_NAV_TIMEOUT_MS })
    .catch(() => undefined);
  await page.waitForTimeout(1000);

  const grid = await readGrid(page);
  return {
    ok: !grid.noResults && grid.bookings.length > 0,
    authRequired: false,
    noResults: grid.noResults || grid.bookings.length === 0,
    message: grid.noResults ? "No Booking found matching the search criteria." : `${grid.bookings.length} booking(s) found.`,
    bookings: grid.bookings,
    resultCount: grid.count,
  };
}

/** Open one booking's detail page (ViewSOAction) by clicking its result link. */
export async function openBookingDetail(bookingNumber: string): Promise<boolean> {
  const page = await getDamcoPage();
  const clicked = await page.evaluate((bk) => {
    const a = [...document.querySelectorAll("a")].find((x) => (x.textContent || "").trim() === bk) as HTMLElement | null;
    if (!a) return false;
    a.click();
    return true;
  }, bookingNumber);
  if (!clicked) return false;
  await page.waitForLoadState("domcontentloaded").catch(() => undefined);
  await page.waitForTimeout(2000);
  return /ViewSOAction/i.test(page.url());
}

export interface BookingDetailValues {
  grossWeight: string;
  cartons: string;
  quantity: string;
  status: string;
  confirmationNumber: string;
}

/**
 * Read Quantity / Packages / Gross weight directly from the Details tab DOM.
 * The portal exposes these as form inputs in a "SUMMARY" section plus one row
 * per booking line in a table. The SUMMARY total is authoritative; falling
 * back to the sum of booking-line rows when SUMMARY is empty. Returns
 * normalized string values (never invented — missing stays "").
 *
 * This is the correctness-critical comparison source, not the PDF text.
 */
export async function readBookingDetails(): Promise<BookingDetailValues> {
  const page = await getDamcoPage();
  if (!/ViewSOAction/i.test(page.url())) {
    return { grossWeight: "", cartons: "", quantity: "", status: "", confirmationNumber: "" };
  }

  // Click the DETAILS sub-tab so the SUMMARY + BOOKING LINES sections render.
  await page.evaluate(() => {
    const tab = [...document.querySelectorAll("a, li, button, span")].find((e) => /^\s*details\s*$/i.test(e.textContent || ""));
    if (tab) (tab as HTMLElement).click();
  }).catch(() => undefined);
  await page.waitForTimeout(1200);

  return page.evaluate(() => {
    const getInputValueByLabel = (labelPattern: RegExp): string => {
      const nodes = [...document.querySelectorAll("label, td, th, div, span, b, strong")];
      for (const node of nodes) {
        const text = (node.textContent || "").trim();
        if (!labelPattern.test(text)) continue;
        // Look at the next sibling(s) or the parent row for an input.
        const findInput = (root: Element | null | undefined): string => {
          if (!root) return "";
          const el = root.querySelector("input, select, textarea") as HTMLInputElement | null;
          return el ? (el.value || "").trim() : "";
        };
        const row = node.closest("tr");
        const v = findInput(node.nextElementSibling) || findInput(node.parentElement) || findInput(row);
        if (v) return v;
        // Also try pulling plain text from the next sibling cell (non-input case).
        const sib = node.nextElementSibling;
        if (sib && !sib.querySelector("input")) {
          const t = (sib.textContent || "").trim();
          if (t && t !== text) return t;
        }
      }
      return "";
    };

    const sumInputsByName = (nameSubstr: string): string => {
      const all = [...document.querySelectorAll<HTMLInputElement>(`input[name*="${nameSubstr}" i]`)].filter((e) => (e.value || "").trim().match(/^[\d.,]+$/));
      if (all.length === 0) return "";
      const total = all.reduce((s, e) => s + Number((e.value || "0").replace(/,/g, "")), 0);
      return Number.isFinite(total) && total > 0 ? String(total) : "";
    };

    // Try explicit SUMMARY labels first (most reliable).
    let quantity = getInputValueByLabel(/^Quantity\s*summary$/i) || getInputValueByLabel(/^Quantity\b/i);
    let cartons = getInputValueByLabel(/^Packages\s*summary$/i) || getInputValueByLabel(/^Packages\b/i);
    let grossWeight = getInputValueByLabel(/^Gross\s*weight\s*summary$/i) || getInputValueByLabel(/^Gross\s*weight\b/i);

    // Fall back to summing per-line booking-line table inputs.
    if (!quantity) quantity = sumInputsByName("quantity");
    if (!cartons) cartons = sumInputsByName("package") || sumInputsByName("carton");
    if (!grossWeight) grossWeight = sumInputsByName("grossWeight") || sumInputsByName("weight");

    // Status + confirmation number appear in the HEADER section's read-only fields.
    const bodyText = (document.body.innerText || "").replace(/\s+/g, " ");
    const statusMatch = bodyText.match(/\bStatus\b[^A-Za-z0-9]{0,8}(CONFIRMED|REQUESTED|DELIVERED|CANCELLED|AMENDED|REJECTED)\b/i);
    const status = statusMatch ? statusMatch[1].toUpperCase() : "";
    const confMatch = bodyText.match(/Booking\s*Confirmation\s*Reference[^A-Za-z0-9]{0,8}([A-Z]{2,5}\d{5,})/i) || bodyText.match(/\b([A-Z]{2,5}\d{5,})\b/);
    const confirmationNumber = confMatch ? confMatch[1] : "";

    const normalize = (v: string) => {
      if (!v) return "";
      const n = Number(String(v).replace(/[^\d.-]/g, ""));
      return Number.isFinite(n) && n > 0 ? (Number.isInteger(n) ? String(n) : String(n)) : "";
    };
    return {
      grossWeight: normalize(grossWeight),
      cartons: normalize(cartons),
      quantity: normalize(quantity),
      status,
      confirmationNumber,
    };
  });
}

/**
 * Minimum size (bytes) for a believable portal booking PDF. The real Damco
 * "Booking Delivery Information" PDF is ~30–60 KB; anything much smaller is
 * almost certainly an error page misdelivered as application/pdf or a
 * truncated/partial download.
 */
const MIN_PORTAL_PDF_BYTES = 1024;

export interface PortalPdfCapture {
  buffer: Buffer;
  filename: string;
  sourceUrl: string;
  via: "response-body" | "response-refetch" | "download-event" | "popup-download" | "popup-fetch";
}

/**
 * Structural validation of a captured Damco PDF. A buffer passes only when it
 * is a real, non-trivial PDF: %PDF- header, %%EOF trailer, at least one
 * page object, and above the minimum-size floor. Returns a reason on failure
 * so the caller can log something useful.
 */
export function validatePortalPdf(buf: Buffer | null | undefined): { ok: boolean; reason: string; bytes: number; pages: number } {
  if (!buf || buf.length === 0) return { ok: false, reason: "no bytes captured", bytes: 0, pages: 0 };
  const bytes = buf.length;
  if (bytes < MIN_PORTAL_PDF_BYTES) return { ok: false, reason: `too small (${bytes} < ${MIN_PORTAL_PDF_BYTES} bytes)`, bytes, pages: 0 };
  const head = buf.subarray(0, 5).toString("latin1");
  if (head !== "%PDF-") return { ok: false, reason: `missing %PDF- header (starts with ${JSON.stringify(head)})`, bytes, pages: 0 };
  const latin = buf.toString("latin1");
  if (!latin.includes("%%EOF")) return { ok: false, reason: "missing %%EOF trailer (partial download?)", bytes, pages: 0 };
  const pages = (latin.match(/\/Type\s*\/Page\b/g) ?? []).length;
  if (pages < 1) return { ok: false, reason: "no /Type /Page objects found", bytes, pages };
  return { ok: true, reason: "", bytes, pages };
}

function filenameFromDisposition(cd: string, fallback: string): string {
  const m = cd.match(/filename\*?=(?:UTF-8''|")?([^";]+)/i);
  if (!m) return fallback;
  try { return decodeURIComponent(m[1]).replace(/[^\w.\- ]+/g, "_") || fallback; } catch { return fallback; }
}

/**
 * Trigger the portal's own "Generate PDF" on the open booking-detail page and
 * capture the genuine portal-generated document.
 *
 * Observed portal behaviour (2026-10-20 probe against booking 61954434):
 *   clicking `#PDFGenHrefId` → `generatePDFFromSOView(so)` opens a popup to
 *   `GenerateSoReport.action?soId=<so>` (observed variants: soId, sold,
 *   soid, so_id — the regex below is parameter-name-agnostic). The response
 *   is `application/pdf` and Chrome renders it inline, so a `download`
 *   event may not fire. We race FOUR capture paths — whichever produces a
 *   valid %PDF first wins — and never wait for the losers:
 *
 *   1. Context `response` event → `response.body()` (fastest, same bytes
 *      Chrome received). Many Damco responses are consumable this way.
 *   2. Context `response` event → `context.request.get(url)` fallback when
 *      body() errors (viewer-wrapped) or returns non-PDF bytes.
 *   3. Main-page `download` event (if the portal ever forces Content-
 *      Disposition: attachment).
 *   4. Popup `download` event; also, when the popup only *navigates* to the
 *      PDF URL, we re-fetch that URL via the context's APIRequestContext
 *      (which shares auth cookies with the visible session).
 *
 * The function never fetches a non-PDF URL and treats it as a PDF: every
 * capture path validates `%PDF-` + size before resolving.
 *
 * Retries once on failure (one more click cycle) because the first popup is
 * sometimes blocked by an interactive dialog that only accepts the second
 * attempt.
 */
export async function generateBookingPdf(bookingNumber: string): Promise<PortalPdfCapture | null> {
  // Try up to 2 times; between tries, close any lingering popup and re-click.
  for (let attempt = 1; attempt <= 2; attempt++) {
    const got = await generateBookingPdfOnce(bookingNumber);
    if (got) return got;
    await closeGenerateSoReportTabs().catch(() => undefined);
    // Brief pause before retrying so the portal's js has settled.
    await new Promise((r) => setTimeout(r, 1500));
  }
  return null;
}

async function closeGenerateSoReportTabs(): Promise<void> {
  const page = await getDamcoPage();
  const context = page.context();
  for (const p of context.pages()) {
    if (p === page) continue;
    if (/GenerateSoReport\.action|SoReport|SOPDF/i.test(p.url())) await p.close().catch(() => undefined);
  }
}

async function generateBookingPdfOnce(bookingNumber: string): Promise<PortalPdfCapture | null> {
  const page = await getDamcoPage();
  const context = page.context();
  const timeout = env.DAMCO_NAV_TIMEOUT_MS;

  // Any of the race's branches resolves the promise on first success. Timing
  // out resolves it to null; successive resolves are ignored.
  let resolved = false;
  let resolveWinner!: (v: PortalPdfCapture | null) => void;
  const winnerP = new Promise<PortalPdfCapture | null>((r) => { resolveWinner = r; });
  const win = (v: PortalPdfCapture | null) => { if (!resolved) { resolved = true; resolveWinner(v); } };
  const timer = setTimeout(() => win(null), timeout);

  const pdfFromDownload = async (dl: Download, via: "download-event" | "popup-download"): Promise<PortalPdfCapture | null> => {
    try {
      const s = await dl.createReadStream();
      if (!s) return null;
      const chunks: Buffer[] = [];
      for await (const c of s) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
      const buffer = Buffer.concat(chunks);
      const v = validatePortalPdf(buffer);
      if (!v.ok) return null;
      return { buffer, filename: dl.suggestedFilename() || `booking-${bookingNumber}.pdf`, sourceUrl: dl.url(), via };
    } catch { return null; }
  };

  // Fetch any URL via the browser's APIRequestContext (shares auth cookies).
  const fetchAsPdf = async (url: string, via: "response-refetch" | "popup-fetch"): Promise<PortalPdfCapture | null> => {
    try {
      const fetched = await context.request.get(url, { timeout: 30_000 });
      if (!fetched.ok()) return null;
      const headers = fetched.headers();
      const body = Buffer.from(await fetched.body());
      const v = validatePortalPdf(body);
      if (!v.ok) return null;
      const cd = headers["content-disposition"] || "";
      return { buffer: body, filename: filenameFromDisposition(cd, `booking-${bookingNumber}.pdf`), sourceUrl: url, via };
    } catch { return null; }
  };

  // (1/2) Context-level response listener — catches both the main page's
  // navigations and anything a popup requests. Fires on the FIRST plausible
  // PDF response from booking.damco.com. The filter is parameter-name-
  // agnostic: it matches `GenerateSoReport.action?*=<bookingNumber>*` for
  // any param name (soId, sold, soid, so_id, ...), plus any response from
  // booking.damco.com whose content-type is application/pdf.
  const bookingUrlRe = new RegExp(`booking\\.damco\\.com/.*(?:GenerateSoReport|SoReport|SOPDF|generatePDF|generatePdf|downloadPdf|PdfExport)[^?]*\\?[^#]*(?:=|%3D)${bookingNumber}(?:\\b|&|$|%26)`, "i");
  const genericPdfRe = /booking\.damco\.com\/.*(?:GenerateSoReport|SoReport|SOPDF|generatePDF|generatePdf|downloadPdf|PdfExport)/i;
  const onResp = async (resp: PwResponse) => {
    if (resolved) return;
    const url = resp.url();
    const ct = (resp.headers()["content-type"] || "").toLowerCase();
    const looksLikePdf = ct.includes("pdf") || /\.pdf(\?|$)/i.test(url);
    const isCandidate = bookingUrlRe.test(url) || (looksLikePdf && genericPdfRe.test(url));
    if (!isCandidate) return;
    // Try response.body() first — those are the exact bytes Chrome got.
    try {
      const body = Buffer.from(await resp.body());
      const v = validatePortalPdf(body);
      if (v.ok) {
        const cd = resp.headers()["content-disposition"] || "";
        return win({ buffer: body, filename: filenameFromDisposition(cd, `booking-${bookingNumber}.pdf`), sourceUrl: url, via: "response-body" });
      }
    } catch { /* fallthrough to re-fetch */ }
    // response.body() failed or returned non-PDF (PDF viewer wrapper) → re-fetch via the context's request API (same cookies).
    const refetched = await fetchAsPdf(url, "response-refetch");
    if (refetched) win(refetched);
  };
  context.on("response", onResp);

  // (3) Main-page download event.
  page.waitForEvent("download", { timeout }).then((dl) => pdfFromDownload(dl, "download-event").then((r) => r && win(r))).catch(() => undefined);

  // (4) Popup opens → either a download fires on it (classic attachment), OR
  // it navigates to the PDF URL (inline viewer). Handle both: wait for its
  // download event concurrently, and when its URL settles on a plausible
  // PDF endpoint, re-fetch it via the context.
  page.waitForEvent("popup", { timeout }).then(async (pop) => {
    pop.waitForEvent("download", { timeout: 20_000 }).then((dl) => pdfFromDownload(dl, "popup-download").then((r) => r && win(r))).catch(() => undefined);
    // Wait for the popup to settle on a URL (short grace: the viewer loads fast).
    for (let i = 0; i < 20 && !resolved; i++) {
      const u = pop.url();
      if (u && u !== "about:blank" && (bookingUrlRe.test(u) || genericPdfRe.test(u))) {
        const got = await fetchAsPdf(u, "popup-fetch");
        if (got) { win(got); break; }
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }).catch(() => undefined);

  // Fire the Generate PDF control. Prefer the real anchor id; fall back to any
  // control whose onclick triggers generatePDFFromSOView; last resort — call
  // the global function directly.
  await page.evaluate((bk) => {
    const el =
      (document.getElementById("PDFGenHrefId") as HTMLElement | null) ||
      ([...document.querySelectorAll("a,button,input")].find((e) => /generatePDFFromSOView/i.test(e.getAttribute("onclick") || "")) as HTMLElement | null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (el) el.click();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    else if (typeof (window as any).generatePDFFromSOView === "function") (window as any).generatePDFFromSOView(bk);
  }, bookingNumber).catch(() => undefined);

  try {
    const result = await winnerP;
    clearTimeout(timer);
    context.off("response", onResp);
    return result;
  } finally {
    // Clean up any lingering PDF-viewer popup so the next doc starts fresh.
    try {
      for (const p of context.pages()) {
        if (p === page) continue;
        if (/GenerateSoReport\.action|SoReport|SOPDF/i.test(p.url())) await p.close().catch(() => undefined);
      }
    } catch { /* ignore */ }
  }
}
