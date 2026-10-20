import { ensureAuthenticated } from "@/server/integrations/damco-auth";
import { getDamcoPage, detachDamcoBrowser } from "@/server/integrations/damco-browser";

// READ-ONLY: authenticate, select shipper, run ONE real PO search, dump the
// results-table structure + any row action links. No booking is modified.
const PO = process.argv[2] || "698757";
const SHIPPER = "ANANTA GARMENTS LIMITED";

async function main() {
  const auth = await ensureAuthenticated();
  console.log(`AUTH: ${auth.outcome} — ${auth.message}`);
  if (auth.outcome !== "AUTHENTICATED") return;

  const page = await getDamcoPage();
  await page.goto("https://booking.damco.com/ShipperPortalWeb/SearchAction.action", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1000);

  await page.selectOption("#finalShipperList", { label: new RegExp(SHIPPER, "i") as unknown as string }).catch(async () => {
    await page.selectOption("#finalShipperList", { label: `${SHIPPER} [BDANANTAGAVDR]` }).catch(() => undefined);
  });
  await page.fill("#searchPO_PO_No", `${PO}*`);
  await page.waitForTimeout(300);
  await page.click("#searchPObtn");
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await page.waitForTimeout(2500);

  const dump = await page.evaluate(() => {
    const vis = (el: Element) => {
      const r = (el as HTMLElement).getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const tables = [...document.querySelectorAll("table")].filter(vis).map((t) => ({
      id: t.id,
      cls: String(t.className).slice(0, 50),
      headers: [...t.querySelectorAll("th")].map((th) => th.textContent!.replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 30),
      firstRows: [...t.querySelectorAll("tbody tr")].slice(0, 4).map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent!.replace(/\s+/g, " ").trim()).slice(0, 14)),
      rowCount: t.querySelectorAll("tbody tr").length,
    }));
    const links = [...document.querySelectorAll("a,button,input[type=button],input[type=image]")]
      .filter(vis)
      .map((e) => ({ tag: e.tagName.toLowerCase(), id: e.id, text: ((e as HTMLElement).innerText || (e as HTMLInputElement).value || e.getAttribute("title") || e.getAttribute("alt") || "").replace(/\s+/g, " ").trim().slice(0, 40), href: (e.getAttribute("href") || "").split("?")[0].slice(0, 60), onclick: (e.getAttribute("onclick") || "").slice(0, 80) }))
      .filter((a) => /pdf|download|generate|view|open|booking|confirm|detail|print/i.test(a.text + a.href + a.onclick))
      .slice(0, 40);
    const bodyText = (document.body.innerText || "").replace(/\s+/g, " ");
    const noResults = /no (records|results|data|purchase order)/i.test(bodyText);
    return { tables, links, noResults, sample: bodyText.slice(0, 400) };
  });

  console.log(`\nURL: ${page.url().split("?")[0]}`);
  console.log(`noResults=${dump.noResults}`);
  for (const t of dump.tables.filter((t) => t.headers.length || t.rowCount)) {
    console.log(`\nTABLE id=${t.id || "-"} cls=${t.cls} rows=${t.rowCount}`);
    console.log(`  headers: [${t.headers.join(" | ")}]`);
    for (const r of t.firstRows) console.log(`  row: [${r.join(" | ")}]`);
  }
  console.log(`\nACTION LINKS:`);
  for (const l of dump.links) console.log(`  ${l.tag} id=${l.id || "-"} "${l.text}"${l.href ? ` href=${l.href}` : ""}${l.onclick ? ` onclick=${l.onclick}` : ""}`);
  console.log(`\nsample: ${dump.sample}`);
  await detachDamcoBrowser();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
