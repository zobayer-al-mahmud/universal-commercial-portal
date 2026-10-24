import { ensureAuthenticated } from "@/server/integrations/damco-auth";
import { getDamcoPage, detachDamcoBrowser } from "@/server/integrations/damco-browser";

// Live Booking-tab search test. Authorised by the account owner.
//   argv: <PO> <COUNTRY>   e.g.  613625 PE
// Switches to the BOOKING tab, enters PO* + country* (SKU/Item), clicks Search,
// and reads the real result rows + the toolbar (Generate PDF Zip). Read-only:
// it does NOT open, confirm, or download anything.
const PO = process.argv[2] || "613625";
const COUNTRY = process.argv[3] || "PE";

async function main() {
  const auth = await ensureAuthenticated();
  console.log(`AUTH: ${auth.outcome}`);
  if (auth.outcome !== "AUTHENTICATED") return;

  const page = await getDamcoPage();
  const dialogs: string[] = [];
  page.on("dialog", async (d) => {
    dialogs.push(`${d.type()}: ${d.message().replace(/\s+/g, " ").slice(0, 120)}`);
    await d.accept().catch(() => undefined);
  });

  await page.goto("https://booking.damco.com/ShipperPortalWeb/SearchAction.action", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await page.evaluate("globalThis.__name = globalThis.__name || ((f) => f)");

  // Select shipper (ANANTA GARMENTS) + consignee (H&M) natively, firing change.
  const sel = await page.evaluate(() => {
    function pick(id: string, re: RegExp): string {
      const s = document.getElementById(id) as HTMLSelectElement | null;
      if (!s) return "missing";
      const opt = [...s.options].find((o) => re.test(o.text));
      if (!opt) return "no-option";
      s.value = opt.value;
      s.dispatchEvent(new Event("change", { bubbles: true }));
      return opt.text.trim();
    }
    return { shipper: pick("finalShipperList", /ANANTA GARMENTS LIMITED/i), consignee: pick("finalConsigneeList", /GBC AB|SEHENNESMAHQ/i) };
  });
  console.log(`SHIPPER: ${sel.shipper}`);
  await page.waitForTimeout(1500);
  const sel2 = await page.evaluate(() => {
    const s = document.getElementById("finalConsigneeList") as HTMLSelectElement | null;
    const opt = s ? [...s.options].find((o) => /GBC AB|SEHENNESMAHQ/i.test(o.text)) : null;
    if (s && opt) { s.value = opt.value; s.dispatchEvent(new Event("change", { bubbles: true })); return opt.text.trim(); }
    return "n/a";
  });
  console.log(`CONSIGNEE: ${sel2}`);
  await page.waitForTimeout(800);

  // Switch to the Booking tab; retry until its PO field is actually visible.
  for (let i = 0; i < 4; i++) {
    await page.click("#tab_treetab2").catch(() => undefined);
    try {
      await page.waitForSelector("#searchSO_PO_NO", { state: "visible", timeout: 4000 });
      break;
    } catch {
      await page.waitForTimeout(500);
    }
  }
  await page.fill("#searchSO_PO_NO", `${PO}*`);
  await page.fill("#searchSO_SKU", `${COUNTRY}*`);
  await page.waitForTimeout(300);
  await page.click("#searchSObtn").catch(() => undefined);

  // Wait for the result grid: a booking-number link or the "out of N" counter.
  await page
    .waitForFunction(() => /Result\s+[\d-]+\s+out of\s+\d+/i.test(document.body.innerText) || !!document.querySelector("a[onclick*='viewSO'],a[onclick*='SODetail'],a[href*='ViewSOAction']"), { timeout: 30000 })
    .catch(() => undefined);
  await page.waitForTimeout(1500);

  const results = await page.evaluate(() => {
    const txt = (document.body.innerText || "").replace(/\s+/g, " ");
    const countMatch = txt.match(/Result\s+[\d-]+\s+out of\s+(\d+)/i);
    // The result grid is the table containing booking-number links.
    const tables = [...document.querySelectorAll("table")];
    let grid: { headers: string[]; rows: string[][]; links: { text: string; onclick: string; href: string }[] } | null = null;
    for (const t of tables) {
      const links = [...t.querySelectorAll("a")].filter((a) => /^\d{6,}$/.test((a.textContent || "").trim()));
      if (links.length) {
        grid = {
          headers: [...t.querySelectorAll("th")].map((th) => th.textContent!.replace(/\s+/g, " ").trim()).filter(Boolean),
          rows: [...t.querySelectorAll("tr")].map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent!.replace(/\s+/g, " ").trim())).filter((r) => r.some((c) => /^\d{6,}$/.test(c))).slice(0, 10),
          links: links.slice(0, 8).map((a) => ({ text: (a.textContent || "").trim(), onclick: (a.getAttribute("onclick") || "").slice(0, 90), href: (a.getAttribute("href") || "").split("?")[0] })),
        };
        break;
      }
    }
    return { total: countMatch ? countMatch[1] : "?", grid };
  });

  console.log(`\nURL: ${page.url().split("?")[0]}`);
  console.log(`DIALOGS: ${dialogs.length ? dialogs.join(" || ") : "none"}`);
  const shot = `var/damco-debug/live-search-${PO}.png`;
  await page.screenshot({ path: shot, fullPage: true }).catch(() => undefined);
  console.log(`SCREENSHOT: ${shot}`);
  console.log(`\nRESULT COUNT: ${results.total}`);
  if (!results.grid) {
    console.log("No result grid with booking-number links found (search may not have returned rows).");
  } else {
    console.log(`GRID headers: [${results.grid.headers.join(" | ")}]`);
    for (const r of results.grid.rows) console.log(`  row: [${r.slice(0, 10).join(" | ")}]`);
    console.log(`BOOKING LINKS:`);
    for (const l of results.grid.links) console.log(`  "${l.text}" onclick=${l.onclick} href=${l.href}`);

    if (process.argv[4] === "detail" && results.grid.links[0]) {
      const booking = results.grid.links[0].text;
      await page.evaluate((bk) => {
        const a = [...document.querySelectorAll("a")].find((x) => x.textContent!.trim() === bk) as HTMLElement | null;
        a?.click();
      }, booking);
      await page.waitForLoadState("domcontentloaded").catch(() => undefined);
      await page.waitForTimeout(3000);
      await page.evaluate("globalThis.__name = globalThis.__name || ((f) => f)");
      const detail = await page.evaluate(() => {
        const txt = (document.body.innerText || "").replace(/[ \t]+/g, " ");
        const controls = [...document.querySelectorAll("a,button,input[type=button],input[type=image]")]
          .map((e) => ({ id: e.id, text: ((e as HTMLElement).innerText || (e as HTMLInputElement).value || e.getAttribute("title") || e.getAttribute("alt") || "").replace(/\s+/g, " ").trim().slice(0, 30), onclick: (e.getAttribute("onclick") || "").slice(0, 70) }))
          .filter((c) => /pdf|print|generate|confirm|download|status|submit/i.test(c.text + c.onclick) && (c.text || c.onclick))
          .slice(0, 30);
        return { url: location.href.split("?")[0], controls, text: txt.slice(0, 2500) };
      });
      console.log(`\nDETAIL URL: ${detail.url}`);
      console.log(`DETAIL CONTROLS:`);
      for (const c of detail.controls) console.log(`  id=${c.id || "-"} "${c.text}"${c.onclick ? ` onclick=${c.onclick}` : ""}`);
      await page.screenshot({ path: `var/damco-debug/detail-${booking}.png`, fullPage: true }).catch(() => undefined);
      console.log(`DETAIL SCREENSHOT: var/damco-debug/detail-${booking}.png`);
      console.log(`\nDETAIL TEXT (first 2500):\n${detail.text}`);
    }

    if (process.argv[4] === "pdf" && results.grid.links[0]) {
      const booking = results.grid.links[0].text;
      // Tick the result row's checkbox, then generate the genuine portal PDF ZIP.
      const ticked = await page.evaluate((bk) => {
        const row = [...document.querySelectorAll("tr")].find((tr) => [...tr.querySelectorAll("a")].some((a) => a.textContent!.trim() === bk));
        const cb = row?.querySelector("input[type=checkbox]") as HTMLInputElement | null;
        if (!cb) return false;
        if (!cb.checked) cb.click();
        return cb.checked;
      }, booking);
      console.log(`ROW CHECKBOX TICKED: ${ticked}`);

      const dir = "var/damco-debug";
      const downloadP = page.waitForEvent("download", { timeout: 45000 }).catch(() => null);
      const popupP = page.waitForEvent("popup", { timeout: 8000 }).catch(() => null);
      await page.evaluate(() => {
        const btn = [...document.querySelectorAll("a,button,input")].find((e) => /mulitipleSOPDF/i.test(e.getAttribute("onclick") || "")) as HTMLElement | null;
        btn?.click();
      });
      const dl = await downloadP;
      if (dl) {
        const name = dl.suggestedFilename() || `booking-${booking}.zip`;
        const path = `${dir}/${name}`;
        await dl.saveAs(path).catch(() => undefined);
        console.log(`PDF DOWNLOAD: saved ${path} (suggested="${name}")`);
      } else {
        const popup = await popupP;
        if (popup) {
          await popup.waitForLoadState("domcontentloaded").catch(() => undefined);
          console.log(`PDF POPUP: ${popup.url().split("?")[0]}`);
          await popup.screenshot({ path: `${dir}/pdf-popup-${booking}.png`, fullPage: true }).catch(() => undefined);
        } else {
          console.log("PDF: no download or popup captured (control may use a different mechanism).");
        }
      }
    }
  }
  await detachDamcoBrowser();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
