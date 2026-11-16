import "server-only";
import type { Page } from "playwright";
import { env } from "@/lib/env";
import { getBgmeaPage } from "./browser";
import { assertSafeToClickUd } from "./guards";
import { ensureBgmeaAuth, portalOrigin, type AuthResult } from "./auth";
import type { PortalDropdown, PortalRow } from "./portal-map";

/**
 * Live BGMEA portal primitives shared by fetch (read) and write-back.
 *
 * - `withPortalSession` serialises ALL portal work in this process: there is one
 *   BGMEA browser profile, so two runs (or two factories) must never interleave.
 * - `selectUd` opens the factory's UD list, selects the UD, and VERIFIES both that
 *   the list row belongs to the factory (Membership ID) and that the portal's own
 *   session now reports that UD (nav-menu `udTrackingNo`).
 * - `readComponent` reads the page component's data (the full rows the page holds),
 *   plus the page's dropdowns (value code + label). Read-only DOM/JS reads.
 */

let chain: Promise<unknown> = Promise.resolve();

/** Run `fn` with exclusive use of the BGMEA browser (FIFO). */
export function withPortalSession<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
}

export async function signInFactory(factoryId: string): Promise<AuthResult> {
  return ensureBgmeaAuth(factoryId);
}

export function portalUrl(path: string): string {
  return new URL(path, portalOrigin()).toString();
}

/** The UD the portal session currently has selected (nav-menu component), or "". */
export async function selectedUdInPortal(page: Page): Promise<string> {
  return page
    .evaluate(() => {
      const nav = Array.from(document.querySelectorAll("*"))
        .map((e) => (e as unknown as { __vue__?: { $options: { name?: string }; $data: Record<string, unknown> } }).__vue__)
        .find((v) => v && v.$options.name === "nav-menu");
      const fromVue = nav ? String(nav.$data.udTrackingNo ?? "") : "";
      if (fromVue && fromVue !== "undefined" && fromVue !== "null") return fromVue;
      const m = (document.body?.innerText ?? "").match(/UD No:\s*(UD\d+)/);
      return m ? m[1] : "";
    })
    .catch(() => "");
}

export interface SelectUdResult {
  ok: boolean;
  message: string;
}

/** Select `udNumber` into the portal session from the factory's own UD list, and verify it. */
export async function selectUd(page: Page, factoryId: string, udNumber: string): Promise<SelectUdResult> {
  const ud = udNumber.trim().toUpperCase();
  await page.goto(portalUrl("/UD"), { waitUntil: "load" });
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => undefined);
  await page.waitForSelector("table tbody tr", { timeout: env.BGMEA_NAV_TIMEOUT_MS }).catch(() => undefined);
  // Wait until the UD list component has mounted and loaded (typing earlier is lost).
  for (let i = 0; i < 20; i++) {
    const ready = await page
      .evaluate(() => {
        const vm = Array.from(document.querySelectorAll("*"))
          .map((e) => (e as unknown as { __vue__?: { $options: { name?: string }; $data: Record<string, unknown> } }).__vue__)
          .find((v) => v && v.$options.name === "new-ud");
        return !!vm && Array.isArray(vm.$data.list) && (vm.$data.list as unknown[]).length > 0 && vm.$data.busy !== true;
      })
      .catch(() => false);
    if (ready) break;
    await page.waitForTimeout(500);
  }
  const filter = page.locator('input[placeholder*="Tracking" i]').first();
  const row = page.locator("table tbody tr", { hasText: ud }).first();
  let found = false;
  for (let attempt = 0; attempt < 3 && !found; attempt++) {
    if (await filter.count()) {
      await filter.fill("").catch(() => undefined);
      await filter.fill(ud).catch(() => undefined);
    }
    try {
      await row.waitFor({ state: "visible", timeout: 8000 });
      found = true;
    } catch {
      await page.waitForTimeout(1000);
    }
  }
  if (!found) {
    return { ok: false, message: `UD ${ud} is not in factory ${factoryId}'s BGMEA UD list. Nothing was read or written.` };
  }
  const rowText = ((await row.innerText().catch(() => "")) || "").replace(/\s+/g, " ");
  if (!new RegExp(`\\b${factoryId}\\b`).test(rowText.replace(ud, ""))) {
    return { ok: false, message: `UD ${ud}'s BGMEA row does not show membership ${factoryId}. Nothing was read or written.` };
  }
  await row.scrollIntoViewIfNeeded().catch(() => undefined);
  const cell = row.locator("td").first();
  await assertSafeToClickUd(cell, "select");
  await cell.click({ timeout: env.BGMEA_NAV_TIMEOUT_MS });
  await page.waitForTimeout(1200);
  const selected = (await selectedUdInPortal(page)).toUpperCase();
  if (selected !== ud) {
    return { ok: false, message: `BGMEA did not switch to UD ${ud} (session shows ${selected || "no UD"}). Nothing was read or written.` };
  }
  return { ok: true, message: `Selected UD ${ud} in BGMEA.` };
}

export interface ComponentRead {
  found: boolean;
  /** Rows (an object source is returned as a one-row array). */
  rows: PortalRow[];
  extra: Record<string, PortalRow[]>;
  dropdowns: PortalDropdown[];
  /** Paging state of the portal list (generic infinite-scroll filter). */
  paging: { pageIndex: number; totalPage: number } | null;
  /** The UD the session reports on this page. */
  sessionUd: string;
}

/**
 * Read a page component's data. Navigates to `path`, waits for the component, scrolls
 * its list to load any further pages, then returns plain JSON. Read-only.
 */
export async function readComponent(page: Page, path: string, component: string, prop: string, extraProps: string[] = [], opts: { single?: boolean } = {}): Promise<ComponentRead> {
  await page.goto(portalUrl(path), { waitUntil: "load" });

  const probe = async () =>
    page.evaluate(
      ({ component, prop }) => {
        type VM = { $options: { name?: string }; $data: Record<string, unknown>; $props?: Record<string, unknown> };
        const vm = Array.from(document.querySelectorAll("*"))
          .map((e) => (e as unknown as { __vue__?: VM }).__vue__)
          .find((v) => v && v.$options.name === component);
        if (!vm) return null;
        const d = vm.$data;
        const val = d[prop] !== undefined ? d[prop] : vm.$props ? vm.$props[prop] : undefined;
        const n = Array.isArray(val) ? val.length : val ? 1 : 0;
        const pi = typeof d.pageIndex === "number" ? d.pageIndex : null;
        const tp = typeof d.totalPage === "number" ? d.totalPage : null;
        return { n, pageIndex: pi, totalPage: tp, busy: d.busy === true };
      },
      { component, prop },
    )
    .catch(() => null);

  // Wait for the component to mount and its first load to finish. Several pages
  // (e.g. Notify Party, Port) fetch their rows asynchronously after mount and expose
  // no busy flag, so also wait for network idle and give an empty list a short grace
  // period before reporting the page as empty.
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => undefined);
  let state = await probe();
  for (let i = 0; i < 20 && (!state || state.busy); i++) {
    await page.waitForTimeout(500);
    state = await probe();
  }
  for (let i = 0; i < 8 && state && state.n === 0; i++) {
    await page.waitForTimeout(500);
    state = await probe();
  }
  if (!state) {
    return { found: false, rows: [], extra: {}, dropdowns: [], paging: null, sessionUd: await selectedUdInPortal(page) };
  }

  // Infinite-scroll lists: pageIndex is the NEXT page to load. Scroll the list's
  // scroll container until every page is loaded (bounded).
  for (let i = 0; i < 25 && state && state.pageIndex !== null && state.totalPage !== null && state.pageIndex <= state.totalPage; i++) {
    const before = state.n;
    await page
      .evaluate(() => {
        for (const t of Array.from(document.querySelectorAll("table"))) {
          let el: HTMLElement | null = t as HTMLElement;
          while (el && el !== document.body) {
            const cs = getComputedStyle(el);
            if (/(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight) {
              el.scrollTop = el.scrollHeight;
              el.dispatchEvent(new Event("scroll"));
              break;
            }
            el = el.parentElement;
          }
        }
        window.scrollTo(0, document.body.scrollHeight);
      })
      .catch(() => undefined);
    await page.waitForTimeout(1200);
    state = await probe();
    if (state && state.n === before && !state.busy) {
      await page.waitForTimeout(800);
      state = await probe();
      if (state && state.n === before) break;
    }
  }

  const data = await page.evaluate(
    ({ component, prop, extraProps, single }) => {
      type VM = { $options: { name?: string }; $data: Record<string, unknown>; $props?: Record<string, unknown> };
      const vm = Array.from(document.querySelectorAll("*"))
        .map((e) => (e as unknown as { __vue__?: VM }).__vue__)
        .find((v) => v && v.$options.name === component)!;
      const pick = (k: string) => (vm.$data[k] !== undefined ? vm.$data[k] : vm.$props ? vm.$props[k] : undefined);
      const clone = (x: unknown) => JSON.parse(JSON.stringify(x ?? null));
      const val = clone(pick(prop));
      const rows = single ? (val && typeof val === "object" ? [val] : []) : Array.isArray(val) ? val : [];
      const extra: Record<string, unknown[]> = {};
      for (const k of extraProps) {
        const x = clone(pick(k));
        extra[k] = Array.isArray(x) ? x : [];
      }
      const labelFor = (el: Element): string => {
        let n: Element | null = el;
        for (let i = 0; i < 4 && n; i++) {
          n = n.parentElement;
          if (!n) break;
          const c = n.cloneNode(true) as Element;
          c.querySelectorAll("input,select,textarea,button,option,table").forEach((x) => x.remove());
          const t = (c.textContent || "").replace(/\s+/g, " ").trim();
          if (t && t.length < 80) return t;
        }
        return "";
      };
      const dropdowns = Array.from(document.querySelectorAll("select"))
        .filter((s) => (s as HTMLElement).offsetParent !== null)
        .map((s) => ({
          label: labelFor(s).replace(/\*/g, "").trim() || "Options",
          options: Array.from((s as HTMLSelectElement).options)
            .map((o) => ({ value: o.value, label: (o.textContent || "").replace(/\s+/g, " ").trim() }))
            .filter((o) => o.label && !/^\[object/.test(o.value))
            .slice(0, 800),
        }))
        .filter((d) => d.options.length > 0);
      const d = vm.$data;
      const paging = typeof d.pageIndex === "number" && typeof d.totalPage === "number" ? { pageIndex: d.pageIndex as number, totalPage: d.totalPage as number } : null;
      return { rows, extra, dropdowns, paging };
    },
    { component, prop, extraProps, single: !!opts.single },
  );

  return { found: true, rows: data.rows as PortalRow[], extra: data.extra as Record<string, PortalRow[]>, dropdowns: data.dropdowns, paging: data.paging, sessionUd: await selectedUdInPortal(page) };
}

/** Is a portal list incompletely loaded (more pages than were read)? */
export function listIncomplete(paging: { pageIndex: number; totalPage: number } | null): boolean {
  return !!paging && paging.totalPage > 0 && paging.pageIndex <= paging.totalPage;
}

/** Read the selected UD's review status from the UD Information page component. */
export async function readUdStatus(page: Page): Promise<{ reviewStatusId: number | null; reviewStatusName: string; trackingNo: string }> {
  const r = await readComponent(page, "/UD", "new-ud", "model", [], { single: true });
  const m = r.rows[0] ?? {};
  const id = m.ReviewStatusId;
  return {
    reviewStatusId: typeof id === "number" ? id : id === null || id === undefined || id === "" ? null : Number(id),
    reviewStatusName: String(m.ReviewStatusName ?? "") || "NEW",
    trackingNo: String(m.UDTrackingNo ?? ""),
  };
}

export { getBgmeaPage };
