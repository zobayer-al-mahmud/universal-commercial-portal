import type { Page } from "playwright";

/** Minimum believable size for a printed EXP detail page. */
const MIN_PDF_BYTES = 800;

/** Structural PDF check — %PDF header, %%EOF trailer, ≥1 page object. */
export function validateCapturedPdf(buf: Buffer | null | undefined): { ok: boolean; reason: string; bytes: number; pages: number } {
  if (!buf || buf.length === 0) return { ok: false, reason: "no bytes captured", bytes: 0, pages: 0 };
  const bytes = buf.length;
  if (bytes < MIN_PDF_BYTES) return { ok: false, reason: `too small (${bytes} < ${MIN_PDF_BYTES} bytes)`, bytes, pages: 0 };
  if (buf.subarray(0, 5).toString("latin1") !== "%PDF-") return { ok: false, reason: "missing %PDF- header", bytes, pages: 0 };
  const latin = buf.toString("latin1");
  if (!latin.includes("%%EOF")) return { ok: false, reason: "missing %%EOF trailer (partial?)", bytes, pages: 0 };
  const pages = (latin.match(/\/Type\s*\/Page\b/g) ?? []).length;
  if (pages < 1) return { ok: false, reason: "no /Type /Page objects", bytes, pages };
  return { ok: true, reason: "", bytes, pages };
}

/**
 * Print the current page to a PDF via CDP (headful Chrome supports Page.printToPDF).
 * This captures the portal's OWN EXP detail page the operator sees — nothing is
 * fabricated. If the portal exposes a native "download EXP" control the caller
 * should prefer that; this is the faithful fallback.
 */
export async function printPageToPdf(page: Page): Promise<Buffer | null> {
  try {
    const client = await page.context().newCDPSession(page);
    const { data } = (await client.send("Page.printToPDF", {
      printBackground: true,
      preferCSSPageSize: true,
      marginTop: 0.4,
      marginBottom: 0.4,
      marginLeft: 0.4,
      marginRight: 0.4,
    })) as { data: string };
    await client.detach().catch(() => undefined);
    return Buffer.from(data, "base64");
  } catch {
    return null;
  }
}
