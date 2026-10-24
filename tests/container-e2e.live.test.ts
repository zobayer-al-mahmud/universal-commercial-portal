import { describe, it, expect } from "vitest";
import { writeFileSync } from "fs";
import { runLiveContainerSearch } from "@/server/container/live-run";
import { detachContainerBrowser } from "@/server/container/browser";

/**
 * REAL end-to-end test against the live CTG Port Port Community System.
 * Opt-in only (spawns a visible browser + hits the public internet):
 *   LIVE_CONTAINER_TEST=1 ... vitest run tests/container-e2e.live.test.ts
 * Uses TLLU4872965 — a real container present in the system on 2026-10-24.
 */
describe.skipIf(!process.env.LIVE_CONTAINER_TEST)("live CTG Port container search (opt-in)", () => {
  it("searches a real container, verifies the record, and captures a valid PDF", async () => {
    const steps: string[] = [];
    const r = await runLiveContainerSearch({
      containerNo: process.env.LIVE_CONTAINER_NO || "TLLU4872965",
      expectedLocation: process.env.LIVE_CONTAINER_LOC || null,
      onProgress: (s, d) => { steps.push(s); console.log(`  ▸ ${s}${d ? ` — ${d}` : ""}`); },
    });

    console.log("KIND :", r.kind);
    console.log("MSG  :", r.message);
    console.log("AUTH :", r.auth.outcome, "-", r.auth.message);
    console.log("RESULT:", JSON.stringify(r.result, null, 2));
    if (r.pdf) {
      const out = process.env.LIVE_CONTAINER_OUT || "C:/Users/zobayer/AppData/Local/Temp/container-live.pdf";
      writeFileSync(out, r.pdf.buffer);
      console.log(`PDF  : ${r.pdf.bytes} bytes, ${r.pdf.pages} page(s), via ${r.pdf.capturedVia} → ${out}`);
    }

    expect(steps).toContain("Download Verified");
    expect(r.ok).toBe(true);
    expect(r.result?.found).toBe(true);
    expect((r.result?.containerNo || "").toUpperCase()).toContain((process.env.LIVE_CONTAINER_NO || "TLLU4872965").toUpperCase());
    expect(r.pdf?.bytes).toBeGreaterThan(600);
    expect(r.pdf?.pages).toBeGreaterThanOrEqual(1);

    await detachContainerBrowser();
  }, 180_000);
});
