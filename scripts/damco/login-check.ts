import { ensureAuthenticated } from "@/server/integrations/damco-auth";
import { getDamcoPage, detachDamcoBrowser } from "@/server/integrations/damco-browser";

// Live authentication check against the real portal. Prints only non-secret
// status. Leaves the visible browser open for inspection.
async function main() {
  const res = await ensureAuthenticated();
  const page = await getDamcoPage();
  const url = page.url().replace(/;jsessionid=[^?#/]*/gi, "").split("?")[0];
  console.log(`OUTCOME: ${res.outcome}`);
  console.log(`MESSAGE: ${res.message}`);
  console.log(`URL: ${url}`);
  console.log(`TITLE: ${await page.title().catch(() => "")}`);
  await detachDamcoBrowser();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
