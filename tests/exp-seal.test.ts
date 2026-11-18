import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { sealExpPdf, findSealAnchor, extractPageText, SEAL_MARKER } from "@/server/exp-automation/seal";

const SEAL_IMG = join(process.cwd(), "tests", "fixtures", "seal-test.png"); // 24x12, aspect 2:1

/**
 * Build a synthetic EXP-like PDF whose text layer carries the Bangladesh Bank
 * EXP FORM anchors at chosen baselines (page 612 x 1008, matching the reference).
 */
async function makeExpPdf(opts: {
  declarationY?: number;
  authSigY?: number;
  dealer?: boolean;
  width?: number;
  height?: number;
}): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const width = opts.width ?? 612;
  const height = opts.height ?? 1008;
  const page = doc.addPage([width, height]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const put = (text: string, x: number, y: number, size = 10) => page.drawText(text, { x, y, size, font });

  put("EXP FORM", 250, 960, 16);
  put("Detail of Export", 240, 900, 11);
  if (opts.declarationY !== undefined) put("Declaration of undertaking by Exporter", 197, opts.declarationY, 11);
  if (opts.authSigY !== undefined) {
    put("Mohammad Abu Taher Khan", 361, opts.authSigY + 12, 10);
    put("Authorized Signature & Stamp", 358, opts.authSigY, 10);
    put("Date:", 38, opts.authSigY - 1, 11);
  }
  if (opts.dealer) {
    put("Certificate of Authorized Dealer", 230, 230, 11);
    put("Stamp and Signature of", 450, 113, 10);
    put("Authorized Dealer", 460, 100, 10);
  }
  return Buffer.from(await doc.save());
}

describe("EXP seal placement", () => {
  it("places the seal at the reference position, anchored to the exporter signature line", async () => {
    const pdf = await makeExpPdf({ declarationY: 413, authSigY: 323, dealer: true });
    const res = await sealExpPdf(pdf, { sealImagePath: SEAL_IMG });

    expect(res.sealed).toBe(true);
    expect(res.alreadySealed).toBe(false);
    expect(res.page).toBe(1);
    expect(res.anchor).toBe("authorized-signature");
    // Reference geometry on a 612pt page: x≈225.75, w≈117, h≈58.5, y≈300.
    expect(res.rect!.w).toBeCloseTo(117, 0);
    expect(res.rect!.h).toBeCloseTo(58.5, 0);
    expect(res.rect!.x).toBeCloseTo(225.75, 0);
    expect(res.rect!.y).toBeGreaterThan(293);
    expect(res.rect!.y).toBeLessThan(308);
    // Output is a valid, larger PDF that still loads.
    const out = await PDFDocument.load(res.buffer);
    expect(out.getPageCount()).toBe(1);
  });

  it("never double-stamps: a re-download of an already-sealed PDF is deduped", async () => {
    const pdf = await makeExpPdf({ declarationY: 413, authSigY: 323 });
    const first = await sealExpPdf(pdf, { sealImagePath: SEAL_IMG });
    expect(first.sealed).toBe(true);

    const second = await sealExpPdf(first.buffer, { sealImagePath: SEAL_IMG });
    expect(second.sealed).toBe(false);
    expect(second.alreadySealed).toBe(true);
    // The deduped output is returned unchanged (same bytes as the already-sealed input).
    expect(second.buffer.equals(first.buffer)).toBe(true);
  });

  it("writes the dedupe marker into the sealed PDF keywords", async () => {
    const pdf = await makeExpPdf({ declarationY: 413, authSigY: 323 });
    const res = await sealExpPdf(pdf, { sealImagePath: SEAL_IMG });
    const out = await PDFDocument.load(res.buffer);
    expect(out.getKeywords()).toContain(SEAL_MARKER);
  });

  it("falls back to the declaration heading when the signature line is absent", async () => {
    const pdf = await makeExpPdf({ declarationY: 413 });
    const res = await sealExpPdf(pdf, { sealImagePath: SEAL_IMG });
    expect(res.sealed).toBe(true);
    expect(res.anchor).toBe("declaration");
    expect(res.rect!.x).toBeCloseTo(225.75, 0);
  });

  it("does not mistake the Authorized Dealer block for the exporter signature", async () => {
    // Declaration present but only the DEALER signature block below it.
    const pdf = await makeExpPdf({ declarationY: 413, dealer: true });
    const res = await sealExpPdf(pdf, { sealImagePath: SEAL_IMG });
    expect(res.sealed).toBe(true);
    expect(res.anchor).toBe("declaration"); // not "authorized-signature"
  });

  it("skips sealing (serves original) when no anchor is found", async () => {
    const pdf = await makeExpPdf({}); // no declaration, no signature
    const res = await sealExpPdf(pdf, { sealImagePath: SEAL_IMG });
    expect(res.sealed).toBe(false);
    expect(res.reason).toMatch(/anchor not found/i);
    expect(res.buffer.equals(pdf)).toBe(true);
  });

  it("never blocks the download when the seal image is missing", async () => {
    const pdf = await makeExpPdf({ declarationY: 413, authSigY: 323 });
    const res = await sealExpPdf(pdf, { sealImagePath: join(process.cwd(), "tests", "fixtures", "does-not-exist.png") });
    expect(res.sealed).toBe(false);
    expect(res.reason).toMatch(/seal image not available/i);
    expect(res.buffer.equals(pdf)).toBe(true);
  });

  it("scales placement to other page widths", async () => {
    const pdf = await makeExpPdf({ declarationY: 413, authSigY: 323, width: 595, height: 842 });
    const res = await sealExpPdf(pdf, { sealImagePath: SEAL_IMG });
    expect(res.sealed).toBe(true);
    // x and width scale with page width (595/612 of the reference fractions).
    expect(res.rect!.x).toBeCloseTo((225.75 / 612) * 595, 0);
    expect(res.rect!.w).toBeCloseTo((117 / 612) * 595, 0);
  });

  it("findSealAnchor / extractPageText locate the exporter block", async () => {
    const pdf = await makeExpPdf({ declarationY: 413, authSigY: 323, dealer: true });
    const pages = await extractPageText(pdf);
    const anchor = findSealAnchor(pages);
    expect(anchor).not.toBeNull();
    expect(anchor!.pageNo).toBe(1);
    expect(anchor!.authSigY).toBeGreaterThan(300);
    expect(anchor!.authSigY).toBeLessThan(340);
  });
});
