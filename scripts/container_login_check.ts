import { ensureContainerAuth } from "@/server/container/auth";
import { getContainerPage, detachContainerBrowser } from "@/server/container/browser";

async function main() {
  const res = await ensureContainerAuth();
  let url = "", title = "";
  try {
    const page = await getContainerPage();
    url = page.url().replace(/[?#].*$/, "");
    title = (await page.title().catch(() => "")) || "";
  } catch { /* ignore */ }
  console.log(`OUTCOME: ${res.outcome}`);
  console.log(`MESSAGE: ${res.message}`);
  console.log(`URL: ${url}`);
  console.log(`TITLE: ${title}`);
  await detachContainerBrowser().catch(() => undefined);
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
