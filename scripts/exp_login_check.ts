import { ensureExpAuth } from "@/server/exp-automation/auth";
import { getExpPage, detachExpBrowser } from "@/server/exp-automation/browser";

async function main() {
  const res = await ensureExpAuth();
  let url = "", title = "";
  try {
    const page = await getExpPage();
    url = page.url().replace(/[?#].*$/, "");
    title = (await page.title().catch(() => "")) || "";
  } catch { /* page may not be reachable on failure */ }
  console.log(`OUTCOME: ${res.outcome}`);
  console.log(`MESSAGE: ${res.message}`);
  console.log(`URL: ${url}`);
  console.log(`TITLE: ${title}`);
  await detachExpBrowser().catch(() => undefined);
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
