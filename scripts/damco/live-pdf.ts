import { createHash } from "crypto";
import { mkdirSync, writeFileSync, statSync } from "fs";
import { join } from "path";
import { liveSearchBookings, openBookingDetail, generateBookingPdf, validatePortalPdf } from "@/server/integrations/damco-live";
import { detachDamcoBrowser } from "@/server/integrations/damco-browser";

/**
 * End-to-end PDF-capture verification against the REAL Damco portal.
 *
 *   npx tsx scripts/damco/live-pdf.ts <PO> <COUNTRY>
 *   e.g.  npx tsx scripts/damco/live-pdf.ts 613625 PE
 *
 * This script runs with INTEGRATION_MODE=live and must have DAMCO_USERNAME /
 * DAMCO_PASSWORD / DAMCO_LIVE_ENABLED=true in the environment. It:
 *   1. opens the visible browser,
 *   2. authenticates (reuses existing session when the profile has one),
 *   3. searches by PO* / SKU*,
 *   4. opens the first booking's detail page,
 *   5. triggers the portal's Generate PDF control,
 *   6. captures the real PDF via one of the four live paths,
 *   7. validates structural integrity (%PDF-, %%EOF, pages, size),
 *   8. writes it to var/damco-debug/live-pdf-<booking>.pdf,
 *   9. prints size + sha256 + capture path for traceability.
 *
 * NO MOCKS. If the portal does not deliver a PDF, the script exits non-zero
 * so CI / smoke-test wrappers see the failure.
 */
async function main() {
  const PO = process.argv[2] || "613625";
  const COUNTRY = process.argv[3] || "PE";

  console.log(`[live-pdf] search PO=${PO} SKU=${COUNTRY}`);
  const search = await liveSearchBookings({ poNumber: PO, countryCode: COUNTRY });
  console.log(`[live-pdf] search ok=${search.ok} authRequired=${search.authRequired} count=${search.bookings.length} msg=${search.message}`);
  if (!search.ok || search.bookings.length === 0) {
    console.error("[live-pdf] no bookings — abort");
    process.exit(1);
  }
  const booking = search.bookings[0].bookingNumber;
  console.log(`[live-pdf] picked booking=${booking} status=${search.bookings[0].bookingStatus}`);

  const opened = await openBookingDetail(booking);
  console.log(`[live-pdf] openBookingDetail → ${opened}`);
  if (!opened) {
    console.error("[live-pdf] could not open booking detail — abort");
    process.exit(1);
  }

  console.log(`[live-pdf] generateBookingPdf(${booking}) …`);
  const t0 = Date.now();
  const pdf = await generateBookingPdf(booking);
  const dt = Date.now() - t0;
  if (!pdf) {
    console.error(`[live-pdf] no PDF captured after ${dt} ms — abort`);
    process.exit(1);
  }

  const v = validatePortalPdf(pdf.buffer);
  if (!v.ok) {
    console.error(`[live-pdf] captured buffer is not a valid PDF: ${v.reason}`);
    process.exit(1);
  }
  const sha256 = createHash("sha256").update(pdf.buffer).digest("hex");
  const outDir = "var/damco-debug";
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `live-pdf-${booking}.pdf`);
  writeFileSync(outPath, pdf.buffer);
  const onDisk = statSync(outPath);

  console.log(`[live-pdf] ✓ captured in ${dt} ms via ${pdf.via}`);
  console.log(`[live-pdf]   source : ${pdf.sourceUrl}`);
  console.log(`[live-pdf]   buffer : ${v.bytes} bytes, ${v.pages} pages`);
  console.log(`[live-pdf]   on disk: ${outPath} (${onDisk.size} bytes)`);
  console.log(`[live-pdf]   sha256 : ${sha256}`);
  if (onDisk.size !== v.bytes) {
    console.error(`[live-pdf] ✗ on-disk size ${onDisk.size} ≠ buffer ${v.bytes} — partial write!`);
    process.exit(1);
  }
  console.log(`[live-pdf] ✓ open ${outPath} to visually verify the portal PDF.`);
  await detachDamcoBrowser();
}

main().catch((e) => {
  console.error("[live-pdf] error:", e instanceof Error ? e.message : e);
  process.exit(1);
});
