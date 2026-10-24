import { ensureAuthenticated } from "@/server/integrations/damco-auth";
import { getDamcoPage, detachDamcoBrowser } from "@/server/integrations/damco-browser";

// READ-ONLY: navigate to the Booking search page, switch to the BOOKING tab
// (a UI tab change, not a search submit), and dump EVERY field id/name + the
// tab links + toolbar controls. No PO is entered and Search is never clicked.
async function main() {
  const auth = await ensureAuthenticated();
  console.log(`AUTH: ${auth.outcome}`);
  if (auth.outcome !== "AUTHENTICATED") return;

  const page = await getDamcoPage();
  await page.goto("https://booking.damco.com/ShipperPortalWeb/SearchAction.action", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);

  // Switch to the BOOKING document tab (UI navigation, not a search submit) so
  // its filter fields load, then expand More filters. Search is never clicked.
  const tab = page.locator("a,li,span,td,div").filter({ hasText: /^\s*booking(\s*\(all\))?\s*$/i }).first();
  if (await tab.count()) { await tab.click().catch(() => undefined); await page.waitForTimeout(2000); }
  const more = page.locator("a:has-text('More filters'), a:has-text('More Filters'), #moreBtn").first();
  if (await more.count()) { await more.click().catch(() => undefined); await page.waitForTimeout(800); }

  await page.evaluate("globalThis.__name = globalThis.__name || ((f) => f)");
  const dump = await page.evaluate(() => {
    const near = (el: Element) => {
      const id = el.id;
      const l = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
      const cell = el.closest("td")?.previousElementSibling?.textContent;
      const prev = el.previousElementSibling?.textContent;
      return (l?.textContent || cell || prev || el.getAttribute("placeholder") || el.getAttribute("title") || "").replace(/\s+/g, " ").trim().slice(0, 40);
    };
    const fields = [...document.querySelectorAll("input,select,textarea")].map((e) => ({
      tag: e.tagName.toLowerCase(),
      type: (e as HTMLInputElement).type || "",
      id: e.id || "",
      name: e.getAttribute("name") || "",
      label: near(e),
    })).filter((f) => f.id || f.name);
    const tabs = [...document.querySelectorAll("a,li,span")]
      .map((e) => ({ id: e.id, text: (e.textContent || "").replace(/\s+/g, " ").trim().slice(0, 30), onclick: (e.getAttribute("onclick") || "").slice(0, 70) }))
      .filter((t) => /purchase order|booking|packing list|commercial invoice|cargo receipt|bill of lading/i.test(t.text) && t.text.length < 30);
    const toolbar = [...document.querySelectorAll("a,button,input[type=button]")]
      .map((e) => ({ id: e.id, text: ((e as HTMLElement).innerText || (e as HTMLInputElement).value || "").replace(/\s+/g, " ").trim().slice(0, 30), onclick: (e.getAttribute("onclick") || "").slice(0, 70) }))
      .filter((t) => /generate|export|create|template|search|pdf/i.test(t.text + t.onclick) && t.text.length < 30);
    return { fields, tabs, toolbar };
  });

  console.log(`URL: ${page.url().split("?")[0]}`);
  console.log(`\nTABS:`);
  for (const t of dump.tabs) console.log(`  id=${t.id || "-"} "${t.text}"${t.onclick ? ` onclick=${t.onclick}` : ""}`);
  console.log(`\nFIELDS (PO/SKU/status of interest):`);
  for (const f of dump.fields) {
    if (/po|sku|item|status|booking|deliver|fob|consignee|shipper|record/i.test(f.id + f.name + f.label))
      console.log(`  ${f.tag}/${f.type} id=${f.id || "-"} name=${f.name || "-"} label="${f.label}"`);
  }
  console.log(`\nTOOLBAR:`);
  for (const t of dump.toolbar) console.log(`  id=${t.id || "-"} "${t.text}"${t.onclick ? ` onclick=${t.onclick}` : ""}`);
  await detachDamcoBrowser();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
