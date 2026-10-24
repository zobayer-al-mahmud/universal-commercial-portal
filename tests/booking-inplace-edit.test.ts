import { describe, it, expect } from "vitest";
import { PDFDocument, StandardFonts, PDFName, PDFRawStream, PDFArray, decodePDFRawStream } from "pdf-lib";
import { editPdfTextInPlace, CONFIRM_REPLACEMENTS } from "@/server/booking-correction/in-place-edit";

/** Extract visible text per page by decoding the content streams (robust; the
 *  bundled pdf-parse mis-reads pdf-lib re-saved PDFs with a spurious XRef error). */
async function pageTexts(buf: Buffer): Promise<string[]> {
  const doc = await PDFDocument.load(buf);
  const out: string[] = [];
  for (const page of doc.getPages()) {
    const obj = doc.context.lookup(page.node.get(PDFName.of("Contents")));
    const parts: string[] = [];
    const push = (s: unknown) => { if (s instanceof PDFRawStream) parts.push(Buffer.from(decodePDFRawStream(s).decode()).toString("latin1")); };
    if (obj instanceof PDFArray) obj.asArray().forEach((el) => push(doc.context.lookup(el)));
    else push(obj);
    const content = parts.join("\n");
    let text = "";
    content.replace(/\((?:[^()\\]|\\.)*\)/g, (lit) => { text += lit.slice(1, -1) + " "; return lit; });
    content.replace(/(?<!<)<([0-9A-Fa-f][0-9A-Fa-f\s]*)>(?!>)/g, (m, hex: string) => { try { text += Buffer.from(hex.replace(/\s+/g, ""), "hex").toString("latin1") + " "; } catch { /* skip */ } return m; });
    out.push(text);
  }
  return out;
}

async function makeBookingPdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  for (let i = 0; i < 2; i++) {
    const p = doc.addPage([612, 792]);
    p.drawText("Booking Requested", { x: 230, y: 740, size: 18, font: bold });
    p.drawText("Shipper ANANTA GARMENTS LIMITED", { x: 40, y: 690, size: 9, font });
    p.drawText("Expected Delivery 2026-10-26", { x: 350, y: 690, size: 9, font });
    if (i === 0) {
      p.drawText("Status", { x: 350, y: 710, size: 9, font });
      p.drawText("REQUESTED", { x: 350, y: 700, size: 9, font });
    }
  }
  return Buffer.from(await doc.save());
}

describe("booking PDF in-place editor", () => {
  it("replaces title on both pages and status on page 1, preserving 2 pages", async () => {
    const base = await makeBookingPdf();
    const res = await editPdfTextInPlace(base);

    expect(res.pages).toBe(2);
    const title = res.counts.find((c) => c.label === "title")!;
    const status = res.counts.find((c) => c.label === "status")!;
    expect(title.count).toBe(2); // both pages
    expect(status.count).toBe(1); // page 1 only

    const loaded = await PDFDocument.load(res.buffer);
    expect(loaded.getPageCount()).toBe(2); // no page added/removed

    const [p1, p2] = await pageTexts(res.buffer);
    const all = p1 + " " + p2;
    expect(p1).toMatch(/Booking Confirmation/);
    expect(p2).toMatch(/Booking Confirmation/);
    expect(p1).toMatch(/CONFIRMED/);
    expect(all).not.toMatch(/Booking Requested/);
    expect(all).not.toMatch(/\bREQUESTED\b/);
    // Unrelated text preserved.
    expect(all).toMatch(/ANANTA GARMENTS LIMITED/);
    expect(all).toMatch(/Expected Delivery 2026-10-26/);
  }, 60000);

  it("reports zero replacements (fail-closed signal) when the target text is absent", async () => {
    const doc = await PDFDocument.create();
    const p = doc.addPage([300, 300]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    p.drawText("Nothing to change here", { x: 20, y: 150, size: 12, font });
    const base = Buffer.from(await doc.save());
    const res = await editPdfTextInPlace(base);
    expect(res.totalReplacements).toBe(0);
    expect(res.pages).toBe(1);
  }, 60000);

  it("does not touch the word 'Requested' inside unrelated lower-case text", async () => {
    const doc = await PDFDocument.create();
    const p = doc.addPage([400, 200]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    p.drawText("Documents requested by broker", { x: 20, y: 100, size: 10, font });
    const base = Buffer.from(await doc.save());
    const res = await editPdfTextInPlace(base, CONFIRM_REPLACEMENTS);
    // "requested" (lower-case) is neither "Booking Requested" nor "REQUESTED".
    expect(res.totalReplacements).toBe(0);
  }, 60000);
});
