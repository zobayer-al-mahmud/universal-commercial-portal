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
  const link = page.locator(`a:has-text('${safe}')`).first();
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
    await page.locator("a[href*=\"'T_TRANSACTION'\"]").first().click({ timeout: 6000 }).catch(() => undefined);
    await page.waitForLoadState("domcontentloaded").catch(() => undefined);
    await page.waitForTimeout(600);
  }
  // The Transaction landing lists the four EXP transaction links.
  const ok = await clickLinkByText(page, itemLinkText);
  if (ok) return true;
  // Fallback: match by a looser regex over visible links.
  const links = page.locator("a");
  const n = await links.count().catch(() => 0);
  for (let i = 0; i < Math.min(n, 60); i++) {
    const t = (await links.nth(i).innerText().catch(() => "")).trim();
    if (itemText.test(t)) {
      await Promise.all([page.waitForLoadState("domcontentloaded").catch(() => undefined), links.nth(i).click({ timeout: 8000 }).catch(() => undefined)]);
      await page.waitForTimeout(600);
      return true;
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
