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
const SCAN = join(BASE, "WEEK- 41 SHIPPING BILL SCAN COPY", "61753.pdf");
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

// Scanned 3-page copy — only runs when OCR is actually enabled + available.
// The invoice box `61753 KS 10.08.2026` sits on the dense Bill-of-Export page
// (OCR page mean ~64%) while its own tokens read clearly; the H&M order number
// 734041/8305 must NOT be selected. This is the spec's mandatory regression.
describe.skipIf(!existsSync(SCAN) || !env.OCR_ENABLED)("Bill of Export 61753.pdf (scanned, OCR)", () => {
  it("extracts 61753 via OCR, not the H&M order number", async () => {
    const r = await analyzePdf(readFileSync(SCAN), OPTS);
    expect(r.usedOcr).toBe(true);
    expect(r.validation.decision).toBe("RENAME");
    expect(r.validation.invoiceNumber).toBe("61753");
    expect(r.validation.numericKey).toBe("61753");
    // The H&M order number (734041/8305) and the date must never be selected.
    expect(r.validation.invoiceNumber).not.toContain("734041");
    expect(r.validation.candidates.length).toBeGreaterThan(0);
  }, 60000);
});
