import type { Download, Page, Response as PwResponse } from "playwright";
import { env } from "@/lib/env";
import { getDamcoPage } from "./damco-browser";
import { ensureAuthenticated, type AuthResult } from "./damco-auth";
import { assembleBookingDetails, type RawBookingDetails, type BookingDetailValues } from "@/server/booking-correction/booking-details";

export type { BookingDetailValues } from "@/server/booking-correction/booking-details";

/**
 * Damco Shipper Portal — LIVE booking workflow driver (visible browser).
 *
 * Selectors re-verified against the production portal (2026-11-02). The driver
 * is READ-oriented: it searches bookings and reads them back. It never confirms,
 * submits, or mutates a booking. The one state-changing thing the portal offers
 * — Generate PDF — only produces a document; it does not change booking status.
 * REQUESTED bookings are never presented as confirmed.
 *
 * Search flow (SearchAction.action is a tabbed page; PURCHASE ORDER is the
 * active tab on load, BOOKING is the one we need):
 *   1. Activate the BOOKING tab (#tab_treetab2 → panel #treetab2) FIRST, before
 *      touching anything else. Its fields (#searchSO_PO_NO, #searchSO_SKU) are
 *      in the DOM but display:none until the tab is active.
 *   2. Fill the search keys and submit (#searchSObtn → searchSO()):
 *        - PO number → #searchSO_PO_NO   (value + '*')
 *        - Country   → #searchSO_SKU     (the SKU/Item field; value + '*')
 *   3. Read the result grid and scope to the right trading entity in CODE
 *      (grid rows carry shipper + consignee text).
 *
 * We deliberately DO NOT pre-select the shipper/consignee dropdowns: on the
 * current portal `finalShipperList.onchange = getConsigneeList()` reloads the
 * page, which raced the subsequent Booking-tab click and left #searchSO_PO_NO
 * hidden ("Booking tab did not activate"). Scoping by shipper is now done by
 * filtering the result grid, which is reload-free and more reliable.
 */

const SEARCH_URL = "https://booking.damco.com/ShipperPortalWeb/SearchAction.action";
const VIEW_SO_URL = "https://booking.damco.com/ShipperPortalWeb/ViewSOAction.action";

export interface LiveBooking {
  bookingNumber: string;
  bookingStatus: string; // CONFIRMED | REQUESTED | DELIVERED | ...
  confirmationNumber: string;
  submissionDate: string;
  deliveryDate: string;
  bookingReference: string;
  /** Result-grid shipper/consignee text (e.g. "ANANTA GARMENTS LIMITED
   *  [BDANANTAGAVDR]" / "H&M HENNES & MAURITZ GBC AB [SEHENNESMAHQ]").
   *  Captured from the grid row so the search can be scoped to the right
   *  trading entity in CODE, instead of pre-selecting the shipper dropdown
   *  (whose onchange reloads the page and raced the Booking-tab activation). */
  shipper: string;
  consignee: string;
}

export interface LiveSearchResult {
  ok: boolean;
  authRequired: boolean;
  noResults: boolean;
  message: string;
  bookings: LiveBooking[];
  resultCount: number;
  /** The shipper id the result-grid links carry (searchByShipper_id); used to
   *  open each candidate's detail by direct URL instead of a results-page click. */
  shipperId: string;
}

export interface LiveSearchInput {
  poNumber: string;
  countryCode: string;
  companyMatch?: RegExp; // shipper option text
  buyerMatch?: RegExp; // consignee option text
}

/** Read the current activation state of the search tabs — used both to decide
 *  whether the Booking tab is live and to build an informative error. */
async function readTabState(page: Page): Promise<{ bookingFieldVisible: boolean; activeTab: string; bookingTabExists: boolean; panelDisplay: string }> {
  return page.evaluate(() => {
    const vis = (el: Element | null): boolean => {
      if (!el) return false;
      const r = (el as HTMLElement).getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
    };
    const active = [...document.querySelectorAll("td.activetab")].map((e) => e.id).join(",") || "(none)";
    const panel = document.getElementById("treetab2");
    return {
      bookingFieldVisible: vis(document.getElementById("searchSO_PO_NO")),
      activeTab: active,
      bookingTabExists: !!document.getElementById("tab_treetab2"),
      panelDisplay: panel ? getComputedStyle(panel).display : "(no #treetab2)",
    };
  });
}

/**
 * Activate the BOOKING tab and wait until its PO search field is really usable.
 *
 * The tab is a <td id=tab_treetab2 tab="#treetab2"> with NO inline onclick — tab
 * switching is a delegated jQuery handler (`gui_tabclick`, reachable via the
 * global `selectTab(index)`), so success is confirmed by STATE, not by the click
 * returning: #searchSO_PO_NO must become visible AND the panel #treetab2 must be
 * shown. We try a real click first, then fall back to calling the portal's own
 * `selectTab(1)` (0-based: PO=0, BOOKING=1), re-settling the page between tries
 * so a late reload/AJAX can't leave us on a stale PO tab. Never just a timeout
 * bump: each attempt re-drives the activation and re-checks real DOM state.
 */
async function openBookingTab(page: Page): Promise<void> {
  // The tab bar must exist before we can switch tabs. If the page is still
  // settling (or mid-reload), give it a moment and let the load state finish.
  await page.waitForSelector("#tab_treetab2", { state: "attached", timeout: env.DAMCO_NAV_TIMEOUT_MS }).catch(() => undefined);

  const bookingReady = async (): Promise<boolean> => {
    try {
      await page.waitForSelector("#searchSO_PO_NO", { state: "visible", timeout: 3500 });
      return true;
    } catch {
      return false;
    }
  };

  if (await bookingReady()) return;

  for (let attempt = 0; attempt < 5; attempt++) {
    // In case a shipper/consignee reload or slow first paint is in flight.
    await page.waitForLoadState("domcontentloaded").catch(() => undefined);

    if (attempt % 2 === 0) {
      // Real user-style click on the tab cell (fires the delegated handler).
      await page.click("#tab_treetab2", { timeout: 4000 }).catch(() => undefined);
    } else {
      // Fallback: drive the portal's own tab switch directly. Works even if the
      // <td> is briefly covered or the click was swallowed mid-reflow.
      await page
        .evaluate(() => {
          const w = window as unknown as { selectTab?: (i: number, a?: string) => void };
          if (typeof w.selectTab === "function") {
            w.selectTab(1); // BOOKING (0-based tab index)
          } else {
            (document.getElementById("tab_treetab2") as HTMLElement | null)?.click();
          }
        })
        .catch(() => undefined);
    }

    if (await bookingReady()) return;
    await page.waitForTimeout(600 + attempt * 400);
  }

  const st = await readTabState(page).catch(() => null);
  throw new Error(
    `Booking tab did not activate (searchSO_PO_NO not visible). ` +
      (st
        ? `Observed: bookingTabExists=${st.bookingTabExists}, activeTab=${st.activeTab}, panel #treetab2 display=${st.panelDisplay}, url=${page.url().split("?")[0]}.`
        : `Could not read the tab state; url=${page.url().split("?")[0]}.`),
  );
}

function readGrid(page: Page): Promise<{ count: number; bookings: LiveBooking[]; noResults: boolean; shipperId: string }> {
  return page.evaluate(() => {
    const body = (document.body.innerText || "").replace(/\s+/g, " ");
    const noResults = /No Booking found matching the search criteria/i.test(body);
    const m = body.match(/Result\s+[\d-]+\s+out of\s+(\d+)/i);
    const count = m ? Number(m[1]) : 0;
    // The result-grid booking links all carry searchByShipper_id=<id>; capture it
    // so each candidate's detail can be opened by direct URL (every candidate, not
    // just the first — a results-page click only works while the grid is showing).
    const shipperId = (document.documentElement.outerHTML.match(/searchByShipper_id=(\d+)/) || [])[1] || "";
    const bookings: LiveBooking[] = [];
    for (const tr of [...document.querySelectorAll("tr")]) {
      const link = [...tr.querySelectorAll("a")].find((a) => /^\d{6,}$/.test((a.textContent || "").trim()));
      if (!link) continue;
      const cells = [...tr.querySelectorAll("td")].map((td) => td.textContent!.replace(/\s+/g, " ").trim());
      const num = (link.textContent || "").trim();
      const status = cells.find((c) => /^(CONFIRMED|REQUESTED|DELIVERED|CANCELLED|AMENDED|REJECTED)$/i.test(c)) || "";
      const conf = cells.find((c) => /^[A-Z]{2,4}\d{5,}$/.test(c)) || "";
      const dates = cells.filter((c) => /^\d{4}-\d{2}-\d{2}$/.test(c));
      // Trading parties: the grid shows the shipper with a vendor code
      // ([...VDR]) and the consignee with an HQ code ([...HQ]). These let the
      // caller scope results to the right entity without selecting dropdowns.
      const shipper = cells.find((c) => /\[[A-Z0-9]*VDR\]/.test(c)) || "";
      const consignee = cells.find((c) => /\[[A-Z0-9]*HQ\]/.test(c)) || "";
      bookings.push({
        bookingNumber: num,
        bookingStatus: status.toUpperCase(),
        confirmationNumber: conf,
        submissionDate: dates[0] || "",
        deliveryDate: dates[1] || "",
        bookingReference: "",
        shipper,
        consignee,
      });
    }
    return { count, bookings, noResults, shipperId };
  });
}

/**
 * Set a Booking-search text field reliably, including under HEADLESS Chromium.
 *
 * `page.fill` requires the element to be visible AND actionable; in a small
 * headless viewport a field lower in the Booking panel (e.g. #searchSO_SKU) is
 * resolved but never becomes "actionable", so fill() times out at 45s even
 * though the field is perfectly usable. We first scroll it into view and try a
 * short fill(); on any failure we set `.value` directly and dispatch
 * input/change (what the portal's `searchSO()` reads), then confirm the value
 * actually landed. Returns true when the field holds the intended value.
 */
async function setSearchField(page: Page, selector: string, value: string): Promise<boolean> {
  try {
    const loc = page.locator(selector);
    await loc.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => undefined);
    await loc.fill(value, { timeout: 5000 });
    return true;
  } catch {
    // Fallback: set the value via the DOM and fire the events the portal listens
    // for. Avoids the visibility/actionability gate entirely.
    const ok = await page
      .evaluate(
        ({ sel, val }) => {
          const el = document.querySelector(sel) as HTMLInputElement | null;
          if (!el) return false;
          el.value = val;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return el.value === val;
        },
        { sel: selector, val: value },
      )
      .catch(() => false);
    return ok;
  }
}

/**
 * Run one Booking-tab search (PO + optional SKU/country) and return the grid.
 * Assumes the browser is authenticated and on SearchAction; activates the
 * Booking tab defensively, fills the keys, submits, and waits for the result
 * counter or the explicit "no booking found" message.
 */
async function submitBookingSearch(page: Page): Promise<void> {
  // Submit. In headless the button may resolve but not be actionable, so fall
  // back to invoking the portal's own search handler (the button's onclick).
  try {
    await page.click("#searchSObtn", { timeout: 5000 });
  } catch {
    await page
      .evaluate(() => {
        const btn = document.getElementById("searchSObtn") as HTMLElement | null;
        if (btn) { btn.click(); return; }
        const w = window as unknown as { searchSO?: () => void };
        if (typeof w.searchSO === "function") w.searchSO();
      })
      .catch(() => undefined);
  }
  await page
    .waitForFunction(
      () =>
        /Result\s+[\d-]+\s+out of\s+\d+/i.test(document.body.innerText) ||
        /No Booking found matching the search criteria/i.test(document.body.innerText),
      { timeout: env.DAMCO_NAV_TIMEOUT_MS },
    )
    .catch(() => undefined);
  // Let the result rows render before the grid is read. Resolve as soon as a
  // booking-number link appears (or the explicit no-results text), capped at the
  // old flat delay — a populated grid is now read without always waiting 1s.
  await page
    .waitForFunction(
      () =>
        [...document.querySelectorAll("tr a")].some((a) => /^\d{6,}$/.test((a.textContent || "").trim())) ||
        /No Booking found matching the search criteria/i.test(document.body.innerText),
      { timeout: 1000 },
    )
    .catch(() => undefined);
}

async function runBookingSearch(page: Page, poNumber: string, countryCode: string): Promise<Awaited<ReturnType<typeof readGrid>>> {
  await openBookingTab(page);
  // Wait until the portal's search handler is actually bound before submitting —
  // on the FIRST search of a fresh (e.g. headless) session the page can still be
  // initialising, and a too-early submit reads the empty-grid placeholder ("No
  // Booking found") as a false negative.
  await page.waitForFunction(() => typeof (window as unknown as { searchSO?: unknown }).searchSO === "function", { timeout: 10_000 }).catch(() => undefined);
  await setSearchField(page, "#searchSO_PO_NO", `${poNumber}*`);
  await setSearchField(page, "#searchSO_SKU", countryCode ? `${countryCode}*` : "");
  await submitBookingSearch(page);
  let grid = await readGrid(page);
  // Cold-start guard: a first-search race can surface the empty-grid placeholder
  // (incl. its "No Booking found" text) before the AJAX result lands, so an empty
  // read on the first interaction is not yet trustworthy. Re-set the keys and
  // re-submit ONCE, then re-read. A genuinely empty result just costs one extra
  // submit; a raced one now returns its real rows.
  if (grid.bookings.length === 0) {
    await setSearchField(page, "#searchSO_PO_NO", `${poNumber}*`);
    await setSearchField(page, "#searchSO_SKU", countryCode ? `${countryCode}*` : "");
    await submitBookingSearch(page);
    grid = await readGrid(page);
  }
  return grid;
}

/** Authenticate (visible browser) and search live bookings by PO + country. */
export async function liveSearchBookings(input: LiveSearchInput): Promise<LiveSearchResult> {
  const auth: AuthResult = await ensureAuthenticated();
  if (auth.outcome !== "AUTHENTICATED") {
    return { ok: false, authRequired: true, noResults: false, message: auth.message, bookings: [], resultCount: 0, shipperId: "" };
  }
  const page = await getDamcoPage();
  await page.goto(SEARCH_URL, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("domcontentloaded").catch(() => undefined);
  // Wait for the search tab bar to attach instead of a flat delay — this resolves
  // as soon as the page is interactive (openBookingTab then confirms the Booking
  // field is really usable), so a fast load no longer always costs ~1.2s.
  await page.waitForSelector("#tab_treetab2", { state: "attached", timeout: env.DAMCO_NAV_TIMEOUT_MS }).catch(() => undefined);
  await page.evaluate("globalThis.__name = globalThis.__name || ((f) => f)");

  // Booking tab FIRST, then PO + SKU search. (No shipper/consignee dropdown
  // selection — that onchange reloads the page and was the root cause of the
  // "Booking tab did not activate" failure.)
  let grid = await runBookingSearch(page, input.poNumber, input.countryCode);

  // Recovery: if the PO+country search returned nothing but the PO alone would,
  // re-run with only the PO. The country goes into the SKU/Item field, which can
  // legitimately over-filter (a booking line's SKU need not start with the
  // country code). The correct record is still verified downstream by PO/SKU/FR
  // + totals, so this only widens the candidate set, never forces a wrong pick.
  let recoveredPoOnly = false;
  if ((grid.noResults || grid.bookings.length === 0) && input.countryCode) {
    const poOnly = await runBookingSearch(page, input.poNumber, "");
    if (poOnly.bookings.length > 0) {
      grid = poOnly;
      recoveredPoOnly = true;
    }
  }

  // Scope to the requested trading entity (shipper) / buyer (consignee) in code,
  // using the per-row grid text. Fail-open: if the filter would remove every row
  // we keep them all (and say so) rather than report a false "no booking".
  const all = grid.bookings;
  let scoped = all;
  let scopeNote = "";
  if (input.companyMatch || input.buyerMatch) {
    const byCompany = input.companyMatch ? all.filter((b) => input.companyMatch!.test(b.shipper)) : all;
    const byBoth = input.buyerMatch ? byCompany.filter((b) => input.buyerMatch!.test(b.consignee)) : byCompany;
    if (byBoth.length > 0) {
      scoped = byBoth;
      if (byBoth.length < all.length) scopeNote = ` (scoped ${all.length}→${byBoth.length} by trading entity)`;
    } else if (all.length > 0) {
      scopeNote = ` (entity filter matched none of ${all.length}; kept all for downstream verification)`;
    }
  }

  const noResults = scoped.length === 0;
  const recoveryNote = recoveredPoOnly ? ` (country filter dropped; matched on PO only)` : "";
  return {
    ok: !noResults,
    authRequired: false,
    noResults,
    message: noResults
      ? "No Booking found matching the search criteria."
      : `${scoped.length} booking(s) found${scopeNote}${recoveryNote}.`,
    bookings: scoped,
    resultCount: grid.count,
    shipperId: grid.shipperId,
  };
}

/**
 * Open one booking's detail page (ViewSOAction).
 *
 * Preferred path: navigate STRAIGHT to the detail URL. The inspection loop opens
 * several candidates in turn; after the first, the page is on a detail view — not
 * the results grid — so the old "click the result link" approach could only ever
 * open candidate[0]. Every later candidate came back blank ("FR ?"), and a row
 * whose correct booking was NOT first was wrongly sent to review. A direct URL
 * opens any candidate regardless of the current page.
 *
 * The result grid's OWN booking links are `ViewSOAction.action?so_number=<n>&
 * searchByShipper_id=<id>` where `<id>` is EMPTY unless a shipper was picked in
 * the dropdown (we no longer pick one — it reloaded the page). The portal resolves
 * the booking from `so_number` alone, so we always build the direct URL (empty
 * shipper id included, exactly as the portal's links do) and only fall back to a
 * results-grid click if the direct nav fails to land on ViewSOAction.
 */
export async function openBookingDetail(bookingNumber: string, shipperId?: string): Promise<boolean> {
  const page = await getDamcoPage();
  {
    const url = `${VIEW_SO_URL}?so_number=${encodeURIComponent(bookingNumber)}&searchByShipper_id=${encodeURIComponent(shipperId ?? "")}`;
    await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => undefined);
    if (/ViewSOAction/i.test(page.url())) {
      // Landed on the detail page — wait for a detail marker (Generate-PDF control
      // or the Details tab) to attach rather than a flat 1.5s. The caller
      // (readBookingDetails / generateBookingPdf) then drives a page that is ready.
      await page.waitForSelector("#PDFGenHrefId, #tab_treetab3", { state: "attached", timeout: 4000 }).catch(() => undefined);
      return true;
    }
    // Direct nav did not land (session/URL quirk) — fall through to the click path.
  }
  let clicked: boolean;
  try {
    clicked = await page.evaluate((bk) => {
      const a = [...document.querySelectorAll("a")].find((x) => (x.textContent || "").trim() === bk) as HTMLElement | null;
      if (!a) return false;
      a.click();
      return true;
    }, bookingNumber);
  } catch (e) {
    // Clicking the result link navigates SYNCHRONOUSLY, which can tear down the
    // evaluate's execution context before it returns ("Execution context was
    // destroyed, most likely because of a navigation"). That throw means the
    // click DID fire and the page is navigating — not a failure. Treat it as
    // clicked and let the URL check below confirm we landed on ViewSOAction;
    // any other error is still real and re-thrown. (Without this, an otherwise
    // valid booking intermittently fails the whole row on a live batch.)
    if (/execution context was destroyed|context was destroyed|frame (?:was )?detached|navigating and changing/i.test(String((e as Error)?.message ?? e))) {
      clicked = true;
    } else {
      throw e;
    }
  }
  if (!clicked) return false;
  await page.waitForLoadState("domcontentloaded").catch(() => undefined);
  // Wait for the detail URL to settle (bounded) instead of a flat 2s, then for a
  // detail marker to attach so the caller drives a ready page.
  await page.waitForFunction(() => /ViewSOAction/i.test(location.href), { timeout: 4000 }).catch(() => undefined);
  if (!/ViewSOAction/i.test(page.url())) return false;
  await page.waitForSelector("#PDFGenHrefId, #tab_treetab3", { state: "attached", timeout: 4000 }).catch(() => undefined);
  return true;
}

/**
 * Read Quantity / Packages / Gross weight + the identity fields directly from
 * the Details tab DOM. The portal exposes the totals as form inputs in a
 * "SUMMARY" section plus one row per booking line; the SUMMARY total is
 * authoritative, falling back to the sum of booking-line rows when empty.
 *
 * The identity reads (PO number / SKU / FR dynamic field / Manufacturer) are
 * harvested RAW here (incl. every label→control-value pair for FR), then
 * interpreted by the pure `assembleBookingDetails` — so a dynamic field is
 * never read back as its own label ("FR") or a dropdown placeholder
 * ("Select..."). Returns normalized string values (never invented — missing
 * stays ""). This is the correctness-critical comparison source, not the PDF.
 */
export async function readBookingDetails(): Promise<BookingDetailValues> {
  const page = await getDamcoPage();
  const empty: RawBookingDetails = {
    grossWeight: "", cartons: "", quantity: "", status: "", confirmationNumber: "",
    poNumber: "", sku: "", manufacturer: "", dynamicFields: [],
  };
  if (!/ViewSOAction/i.test(page.url())) {
    return assembleBookingDetails(empty);
  }

  // Define the esbuild/tsx `__name` shim in the PAGE realm. openBookingDetail
  // navigated to a fresh document, so any shim set on the search page is gone;
  // without it, the named helpers inside the read `page.evaluate` below throw a
  // "__name is not defined" ReferenceError (and the read comes back empty).
  await page.evaluate("globalThis.__name = globalThis.__name || ((f) => f)").catch(() => undefined);

  // Activate the DETAILS sub-tab so the SUMMARY + BOOKING LINES sections render.
  // On the booking-detail page the tabs are the same <td>-with-delegated-handler
  // widget as the search page: Header is `#tab_treetab1` (active on load) and
  // Details is `#tab_treetab3`. Click the tab cell directly (most reliable), with
  // a text-matched fallback; the SUMMARY/Booking-lines inputs are display:none
  // until Details is the active tab, which is why a too-early read came back
  // empty before.
  const clickDetails = () =>
    page.evaluate(() => {
      const el =
        (document.getElementById("tab_treetab3") as HTMLElement | null) ||
        ([...document.querySelectorAll("td[tab], a, li, button, span")].find((e) => /^\s*details\s*$/i.test(e.textContent || "")) as HTMLElement | null);
      if (el) el.click();
    }).catch(() => undefined);

  // True once the Details tab is the active one (its panel is then rendered).
  const detailsActive = () =>
    page
      .waitForFunction(() => {
        const t = document.getElementById("tab_treetab3");
        if (t && /\bactivetab\b/.test(t.className)) return true;
        // Fallback for layouts without the activetab class: the SUMMARY total
        // field is visible only on the Details tab.
        const q = [...document.querySelectorAll("label, td, th, b, strong, span, div")].find((n) => /^Quantity\s*summary$/i.test((n.textContent || "").trim()));
        return !!q && (q as HTMLElement).offsetParent !== null;
      }, { timeout: 4000 })
      .then(() => true)
      .catch(() => false);

  const readRaw = (): Promise<RawBookingDetails> => page.evaluate((): RawBookingDetails => {
    /** Read the *value* of a control: input/textarea value, or a select's chosen
     *  option text — but never a placeholder option (value "", "Select...", …). */
    const readControlValue = (el: Element | null | undefined): string => {
      if (!el) return "";
      if (el.tagName === "SELECT") {
        const sel = el as HTMLSelectElement;
        const opt = sel.options[sel.selectedIndex];
        if (!opt) return "";
        const val = (opt.value || "").trim();
        const txt = (opt.textContent || "").trim();
        if (val === "" || val === "0" || val === "-1") return "";
        if (/^(select|please\s*select|choose|--+|\.{2,}|…)/i.test(txt)) return "";
        return txt;
      }
      return (((el as HTMLInputElement).value ?? "") + "").trim();
    };

    const getInputValueByLabel = (labelPattern: RegExp): string => {
      const nodes = [...document.querySelectorAll("label, td, th, div, span, b, strong")];
      for (const node of nodes) {
        const text = (node.textContent || "").trim();
        if (!labelPattern.test(text)) continue;
        const findInput = (root: Element | null | undefined): string => {
          if (!root) return "";
          const el = root.querySelector("input, select, textarea");
          return el ? readControlValue(el) : "";
        };
        const row = node.closest("tr");
        const v = findInput(node.nextElementSibling) || findInput(node.parentElement) || findInput(row);
        if (v) return v;
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

    // --- Identity fields (verify the right booking) ------------------------
    // PO number / SKU are booking-line label→value pairs; FR is a dynamic-field
    // *input*; Manufacturer is the HTS row's select. We read the paired CONTROL
    // VALUE (never the label), and separately harvest every dynamic label→value
    // pair so the pure layer can pick FR robustly.
    const valueForLabel = (labelPattern: RegExp): string => {
      const nodes = [...document.querySelectorAll("label, td, th, div, span, b, strong")];
      for (const node of nodes) {
        const text = (node.textContent || "").trim();
        if (!labelPattern.test(text)) continue;
        const findInput = (root: Element | null | undefined): string => {
          const el = root?.querySelector("input, select, textarea");
          return el ? readControlValue(el) : "";
        };
        const fromInput = findInput(node.nextElementSibling) || findInput(node.parentElement);
        if (fromInput) return fromInput;
        const sib = node.nextElementSibling;
        if (sib && !sib.querySelector("input, select, textarea")) {
          const t = (sib.textContent || "").trim();
          if (t && t !== text) return t;
        }
      }
      return "";
    };

    // Harvest label→control-value pairs. A "label" is a short cell/element that
    // itself holds no control; its value is the control in the next cell/sibling
    // (table layout) or inside/after it (flex/div layout).
    const dynamicFields: { label: string; value: string }[] = [];
    const pushPair = (label: string, value: string) => {
      const l = (label || "").replace(/\s+/g, " ").trim();
      if (!l || l.length > 40) return;
      dynamicFields.push({ label: l, value: (value || "").replace(/\s+/g, " ").trim() });
    };
    // Strategy A: table rows — a text cell followed by a cell carrying a control.
    for (const tr of document.querySelectorAll("tr")) {
      const cells = [...tr.children].filter((c) => /^(td|th)$/i.test(c.tagName));
      for (let i = 0; i < cells.length - 1; i++) {
        const lc = cells[i];
        if (lc.querySelector("input, select, textarea")) continue;
        const label = (lc.textContent || "").trim();
        if (!label) continue;
        for (let j = i + 1; j < cells.length; j++) {
          const ctrl = cells[j].querySelector("input, select, textarea");
          if (ctrl) { pushPair(label, readControlValue(ctrl)); break; }
        }
      }
    }
    // Strategy B: a label element immediately followed by, or wrapping, a control.
    for (const node of document.querySelectorAll("label, span, div, td, th, b, strong")) {
      if (node.querySelector("input, select, textarea")) continue;
      const label = (node.textContent || "").trim();
      if (!label) continue;
      const sib = node.nextElementSibling;
      const ctrl = sib
        ? (sib.matches && sib.matches("input, select, textarea") ? sib : sib.querySelector("input, select, textarea"))
        : null;
      if (ctrl) pushPair(label, readControlValue(ctrl));
    }

    const poNumber = valueForLabel(/^PO\s*number$/i) || valueForLabel(/^PO\s*number\b/i);
    const sku = valueForLabel(/^SKU\s*\/?\s*Item$/i) || valueForLabel(/^SKU\b/i);
    let manufacturer = valueForLabel(/Manufacturer/i);
    if (!manufacturer) {
      const el = [...document.querySelectorAll<HTMLInputElement>("input, select")]
        .map((e) => readControlValue(e))
        .find((v) => /FASHION|GARMENTS|JEANS|SPORTSWEAR|TEXTILE|APPAREL/i.test(v));
      manufacturer = el || "";
    }

    // Status + confirmation number appear in the HEADER section's read-only fields.
    const bodyText = (document.body.innerText || "").replace(/\s+/g, " ");
    const statusMatch = bodyText.match(/\bStatus\b[^A-Za-z0-9]{0,8}(CONFIRMED|REQUESTED|DELIVERED|CANCELLED|AMENDED|REJECTED)\b/i);
    const status = statusMatch ? statusMatch[1].toUpperCase() : "";
    const confMatch = bodyText.match(/Booking\s*Confirmation\s*Reference[^A-Za-z0-9]{0,8}([A-Z]{2,5}\d{5,})/i) || bodyText.match(/\b([A-Z]{2,5}\d{5,})\b/);
    const confirmationNumber = confMatch ? confMatch[1] : "";

    const normalize = (v: string) => {
      if (!v) return "";
      const n = Number(String(v).replace(/[^\d.-]/g, ""));
      return Number.isFinite(n) && n > 0 ? String(n) : "";
    };
    return {
      grossWeight: normalize(grossWeight),
      cartons: normalize(cartons),
      quantity: normalize(quantity),
      status,
      confirmationNumber,
      poNumber: poNumber.trim(),
      sku: sku.trim(),
      manufacturer: manufacturer.trim(),
      dynamicFields,
    };
  });

  // The Details tab must be the ACTIVE tab for its SUMMARY + booking-line inputs
  // to exist in layout (they are display:none otherwise). We therefore activate
  // it and confirm it is active BEFORE reading — a too-early read on the Header
  // tab returns everything empty and wrongly sends the row to review. It also
  // renders its dynamic fields asynchronously, so after activation we retry while
  // nothing substantive has been read yet (no FR AND no totals). This never
  // invents a value: a genuinely FR-less booking still returns "" after retries,
  // but we no longer mistake "tab not open yet" for "no data".
  let raw = empty;
  for (let attempt = 0; attempt < 4; attempt++) {
    await clickDetails();
    await detailsActive();
    // Short settle for the Details tab's async dynamic fields; escalates only on
    // retries (when the first read came back without FR or any total).
    await page.waitForTimeout(400 + attempt * 600);
    raw = await readRaw();
    const got = assembleBookingDetails(raw);
    if (got.frCode || got.quantity || got.grossWeight || got.cartons) break;
  }

  return assembleBookingDetails(raw);
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
