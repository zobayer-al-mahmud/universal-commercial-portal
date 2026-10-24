import { liveSearchBookings } from "@/server/integrations/damco-live";
import { detachDamcoBrowser } from "@/server/integrations/damco-browser";

// Read-only verification of the production driver's search path.
async function main() {
  const po = process.argv[2] || "613625";
  const country = process.argv[3] || "PE";
  const r = await liveSearchBookings({ poNumber: po, countryCode: country });
  console.log(`ok=${r.ok} authRequired=${r.authRequired} noResults=${r.noResults} count=${r.resultCount}`);
  console.log(`message: ${r.message}`);
  for (const b of r.bookings) {
    console.log(`  booking=${b.bookingNumber} status=${b.bookingStatus || "?"} conf=${b.confirmationNumber || "?"} submit=${b.submissionDate} delivery=${b.deliveryDate}`);
  }
  await detachDamcoBrowser();
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
