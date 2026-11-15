import type { Page } from "playwright";
import { env } from "@/lib/env";

/**
 * Navigation inside the authenticated EXP portal. We always reach a form by
 * driving the visible Transaction menu (never by a deep f?p link, whose session
 * id is dynamic). Each opener clicks "Transaction" then the named sub-link, the
 * same path the operator uses.
 */

// One EXP run at a time per process — the visible window is a single surface.
let runChain: Promise<unknown> = Promise.resolve();
export function serializeExpRun<T>(fn: () => Promise<T>): Promise<T> {
  const next = runChain.then(fn, fn);
  runChain = next.then(() => undefined, () => undefined);
  return next;
}

async function clickLinkByText(page: Page, text: string): Promise<boolean> {
  const safe = text.replace(/'/g, "\\'");
  // APEX renders the full navigation menu tree in the DOM but keeps most of it
  // hidden until expanded, so `a:has-text(...)` frequently matches a hidden menu
  // copy first. Scope to `:visible` so `.first()` is the first ACTUALLY clickable
  // link, and wait up to 4s for it to appear after a page load (same flaw the
  // Search button already guards against — see clickSearch in live-run.ts).
  const link = page.locator(`a:visible:has-text('${safe}')`).first();
  try {
    if (await link.isVisible({ timeout: 4000 })) {
      await Promise.all([
        page.waitForLoadState("domcontentloaded").catch(() => undefined),
        link.click({ timeout: 8000 }),
      ]);
      await page.waitForTimeout(600);
      return true;
    }
  } catch {
    /* fall through */
  }
  return false;
}

/** Open the top-level Transaction menu then the given sub-item. */
async function openTransactionItem(page: Page, itemText: RegExp, itemLinkText: string): Promise<boolean> {
  // Make sure we are on an authenticated shell page first.
  if (!/exp\.bb\.org\.bd/i.test(page.url())) {
    await page.goto(env.EXP_PORTAL_URL, { waitUntil: "domcontentloaded" }).catch(() => undefined);
  }
  // The "Transaction" tab lives on the Home (Welcome, page 1) shell — NOT on a
  // form/detail page (those show only Logout · Home · Reports). So always return
  // Home first; this also resets state cleanly between records in a batch.
  await clickLinkByText(page, "Home");
  if (!(await clickLinkByText(page, "Transaction"))) {
    // Theme fallback: the tab is an <a> calling apex.submit('T_TRANSACTION').
    await page.locator("a:visible[href*=\"'T_TRANSACTION'\"]").first().click({ timeout: 6000 }).catch(() => undefined);
    await page.waitForLoadState("domcontentloaded").catch(() => undefined);
    await page.waitForTimeout(600);
  }
  // The Transaction landing lists the four EXP transaction links.
  const ok = await clickLinkByText(page, itemLinkText);
  if (ok) return true;
  // Fallback: match by a looser regex over the VISIBLE links only. A hidden menu
  // copy must not count, and a click that fails must not be reported as success
  // (the old code swallowed click errors with .catch() and still returned true).
  const links = page.locator("a:visible");
  const n = await links.count().catch(() => 0);
  for (let i = 0; i < Math.min(n, 60); i++) {
    const one = links.nth(i);
    const t = (await one.innerText().catch(() => "")).trim();
    if (!itemText.test(t)) continue;
    try {
      await Promise.all([page.waitForLoadState("domcontentloaded").catch(() => undefined), one.click({ timeout: 8000 })]);
      await page.waitForTimeout(600);
      return true;
    } catch {
      /* try the next visible candidate */
    }
  }
  return false;
}

export function openCorrectionForm(page: Page): Promise<boolean> {
  return openTransactionItem(page, /issued\s+exp\s+correction/i, "Issued EXP Correction");
}

export function openDuplicateForm(page: Page): Promise<boolean> {
  return openTransactionItem(page, /export\s+acknowledgement|duplicate\s+exp\s+reporting/i, "Export Acknowledgement");
}

export function openSearchDetailForm(page: Page): Promise<boolean> {
  return openTransactionItem(page, /search\s+exp\s+detail/i, "Search EXP Detail Information");
}
