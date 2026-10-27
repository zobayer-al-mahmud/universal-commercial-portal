import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { analyzePdf } from "@/server/pdf-rename/folder-rename";
import { env } from "@/lib/env";

// Real supplied fixtures live in the read-only source-evidence tree one level
// above the repo. Guard each so a checkout without them still runs green.
const BASE = join(__dirname, "..", "..", "4. PDF File Rename");
const FCR = join(BASE, "FCR EXTRACT & RENAME", "64408.pdf");
const SOFT = join(BASE, "SHIPPING BILL SOFT COPY", "65341.pdf");
const OPTS = { minConfidence: env.PDF_RENAME_MIN_CONFIDENCE };

describe.skipIf(!existsSync(FCR))("FCR 64408.pdf", () => {
  it("extracts 64408TW (preserves the TW suffix) from the INV NO field", async () => {
    const r = await analyzePdf(readFileSync(FCR), OPTS);
    expect(r.validation.decision).toBe("RENAME");
    expect(r.validation.invoiceNumber).toBe("64408TW");
    expect(r.validation.docType).toBe("fcr");
  });
});

describe.skipIf(!existsSync(SOFT))("Bill of Export 65341.pdf (digital)", () => {
  it("extracts 65341 only (drops BR and the date)", async () => {
    const r = await analyzePdf(readFileSync(SOFT), OPTS);
    expect(r.validation.decision).toBe("RENAME");
    expect(r.validation.invoiceNumber).toBe("65341");
    expect(r.validation.docType).toBe("bill-of-export");
  });
});

// Scanned 3-page copies — only run when OCR is actually enabled + available.
// Each has the invoice box `<num> <market> <dd.mm.yyyy>` on the dense
// Bill-of-Export page (low page-mean OCR) plus a `Number : <num>` header on the
// commercial-invoice page; the H&M order number must NEVER be selected. These are
// the spec's mandatory regressions (general extraction, no hardcoded values):
//  - 61753: market token "KS" (letters)
//  - 64995: digits read low on the full page — rescued by targeted re-OCR
//  - 65037: market token OCR-garbles to "00" — box-44 must still match
const SCANS: Array<[string, string]> = [
  ["61753", "734041"],
  ["64995", "707722"],
  ["65037", "648769"],
];
for (const [inv, hmOrder] of SCANS) {
  const file = join(BASE, "WEEK- 41 SHIPPING BILL SCAN COPY", `${inv}.pdf`);
  describe.skipIf(!existsSync(file) || !env.OCR_ENABLED)(`Bill of Export ${inv}.pdf (scanned, OCR)`, () => {
    it(`extracts ${inv} via OCR, not the H&M order number`, async () => {
      const r = await analyzePdf(readFileSync(file), OPTS);
      expect(r.usedOcr).toBe(true);
      expect(r.validation.decision).toBe("RENAME");
      expect(r.validation.invoiceNumber).toBe(inv);
      expect(r.validation.numericKey).toBe(inv);
      expect(r.validation.invoiceNumber).not.toContain(hmOrder); // H&M order never wins
      expect(r.validation.candidates.length).toBeGreaterThan(0);
    }, 90000);
  });
}
