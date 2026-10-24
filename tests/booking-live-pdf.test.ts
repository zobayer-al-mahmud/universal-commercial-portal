import { describe, it, expect } from "vitest";
import { parsePortalPdfText } from "@/server/booking-correction/live-run";
import { validatePortalPdf } from "@/server/integrations/damco-live";
import { renderCorrectedPdfAsync, renderCorrectedPdfFallback, type CorrectedPdfValues } from "@/server/booking-correction/corrected-pdf";
import { displayProgress } from "@/server/booking-correction/progress";
import { buildBookingPdf } from "@/server/booking-correction/pdf-writer";
import { PDFDocument, StandardFonts } from "pdf-lib";

/** A 2-page base that mimics a captured portal PDF (title + status text). */
async function makeRequestedBasePdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  for (let i = 0; i < 2; i++) {
    const p = doc.addPage([612, 792]);
    p.drawText("Booking Requested", { x: 230, y: 740, size: 18, font: bold });
    p.drawText("Shipper ANANTA GARMENTS LIMITED", { x: 40, y: 690, size: 9, font });
    if (i === 0) p.drawText("REQUESTED", { x: 360, y: 700, size: 9, font });
  }
  return Buffer.from(await doc.save());
}

describe("parsePortalPdfText — Damco booking PDF text", () => {
  it("reads Gross Weight, Cartons, Quantity, and a CONFIRMED heading", () => {
    const text = `BOOKING CONFIRMED
      SO Number: 61954434
      Gross Weight: 219.500 kg
      Total Cartons: 15
      Total Quantity: 263
      Status: CONFIRMED`;
    const r = parsePortalPdfText(text);
    expect(r.grossWeight).toBe("219.5");
    expect(r.cartons).toBe("15");
    expect(r.quantity).toBe("263");
    expect(r.headingStatus).toBe("CONFIRMED");
    expect(r.fieldStatus).toBe("CONFIRMED");
  });

  it("flags REQUESTED without claiming CONFIRMED", () => {
    const text = `BOOKING REQUESTED
      Status: REQUESTED
      Gross Weight: 500 kg
      Number of Cartons: 20
      Pieces: 400`;
    const r = parsePortalPdfText(text);
    expect(r.headingStatus).toBe("REQUESTED");
    expect(r.fieldStatus).toBe("REQUESTED");
    expect(r.grossWeight).toBe("500");
  });

  it("returns blanks (never invents) when nothing is extractable", () => {
    const r = parsePortalPdfText("nothing to see here");
    expect(r.grossWeight).toBe("");
    expect(r.headingStatus).toBe("");
    expect(r.fieldStatus).toBe("");
  });
});

const sampleValues: CorrectedPdfValues = {
  title: "BOOKING CONFIRMED",
  soNumber: "61954434",
  company: "ANANTA GARMENTS LIMITED",
  buyer: "H&M HENNES & MAURITZ GBC AB",
  poNumber: "613625",
  countryCode: "PE",
  grossWeight: "219.5",
  cartons: "15",
  quantity: "263",
  bookingStatus: "CONFIRMED",
  extraLines: "",
  editor: "admin@ananta.com.bd",
};

describe("renderCorrectedPdfAsync — in-place confirmation edit", () => {
  it("edits the base portal PDF in place WITHOUT adding a page", async () => {
    const original = await makeRequestedBasePdf();
    const originalPages = (await PDFDocument.load(original)).getPageCount();
    const res = await renderCorrectedPdfAsync(sampleValues, original);
    expect(res.mode).toBe("in-place");
    expect(res.buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    const out = await PDFDocument.load(res.buffer);
    expect(out.getPageCount()).toBe(originalPages); // exactly 2 — no page added/removed
    expect(res.pages).toBe(2);
    expect(res.replacements).toBeGreaterThan(0);
    const title = res.counts.find((c) => c.label === "title")!;
    const status = res.counts.find((c) => c.label === "status")!;
    expect(title.count).toBe(2); // both pages
    expect(status.count).toBe(1); // page 1 only
  });

  it("falls back to the generic writer when no base PDF is supplied", async () => {
    const res = await renderCorrectedPdfAsync(sampleValues, null);
    expect(res.mode).toBe("fallback-template");
    expect(res.buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("falls back when the base PDF is corrupt (never emits a half-edited file)", async () => {
    const res = await renderCorrectedPdfAsync(sampleValues, Buffer.from("not a pdf"));
    expect(res.mode).toBe("fallback-template");
    expect(res.buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });
});

describe("renderCorrectedPdfFallback", () => {
  it("skips blank fields but still renders the title", () => {
    const buf = renderCorrectedPdfFallback({
      title: "BOOKING",
      soNumber: "", company: "", buyer: "",
      poNumber: "", countryCode: "",
      grossWeight: "", cartons: "", quantity: "",
      bookingStatus: "",
      extraLines: "Line A\nLine B",
    });
    const body = buf.toString("latin1");
    expect(body).toContain("BOOKING");
    expect(body).toContain("Line A");
    expect(body).not.toContain("SO Number:");
  });
});

describe("validatePortalPdf — structural PDF check for Damco downloads", () => {
  it("accepts a real-looking PDF (header + EOF + /Type /Page + >= 1 KB)", () => {
    // buildBookingPdf produces a genuine (small) PDF structure.
    const buf = buildBookingPdf({ title: "DAMCO", lines: ["x".repeat(2000)] });
    const v = validatePortalPdf(buf);
    expect(v.ok).toBe(true);
    expect(v.bytes).toBe(buf.length);
    expect(v.pages).toBeGreaterThanOrEqual(1);
  });

  it("rejects an empty / null buffer", () => {
    expect(validatePortalPdf(null).ok).toBe(false);
    expect(validatePortalPdf(Buffer.alloc(0)).ok).toBe(false);
    expect(validatePortalPdf(Buffer.alloc(0)).reason).toMatch(/no bytes/);
  });

  it("rejects a buffer that is too small (likely an error page masquerading as PDF)", () => {
    const buf = Buffer.from("%PDF-1.4 ... %%EOF");
    const v = validatePortalPdf(buf);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/too small/);
  });

  it("rejects HTML returned with content-type application/pdf (Chrome viewer wrapper)", () => {
    // 2 KB of HTML — defeats the size floor but still not a real PDF.
    const html = Buffer.concat([Buffer.from("<!DOCTYPE html><html>"), Buffer.alloc(2048, 0x20), Buffer.from("</html>")]);
    const v = validatePortalPdf(html);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/missing %PDF- header/);
  });

  it("rejects a truncated PDF (header + pages but no %%EOF trailer)", () => {
    const header = "%PDF-1.4\n";
    const page = "1 0 obj\n<< /Type /Page >>\nendobj\n";
    const buf = Buffer.concat([Buffer.from(header), Buffer.from(page.repeat(60))]);
    const v = validatePortalPdf(buf);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/missing %%EOF/);
  });

  it("rejects a PDF with no /Type /Page objects (not a real document)", () => {
    const buf = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(2048, 0x20), Buffer.from("\n%%EOF\n")]);
    const v = validatePortalPdf(buf);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/no \/Type \/Page/);
  });
});

describe("displayProgress — spec-aligned labels", () => {
  it("UPLOADED → EXTRACTED → SEARCHING → BOOKING_MATCHED → PDF_DOWNLOADED → PDF_UPLOADED → VERIFIED", () => {
    expect(displayProgress({ state: "UPLOADED" }).label).toBe("UPLOADED");
    expect(displayProgress({ state: "EXTRACTING" }).label).toBe("EXTRACTED");
    expect(displayProgress({ state: "PORTAL_SEARCH" }).label).toBe("SEARCHING");
    expect(displayProgress({ state: "BOOKING_MATCHING" }).label).toBe("BOOKING_MATCHED");
    expect(displayProgress({ state: "PDF_GENERATING" }).label).toBe("PDF_DOWNLOADED");
    expect(displayProgress({ state: "STATUS_VALIDATION" }).label).toBe("PDF_UPLOADED");
    expect(displayProgress({ state: "COMPLETED" }).label).toBe("VERIFIED");
  });
  it("maps actionable failure states to their own labels", () => {
    expect(displayProgress({ state: "PORTAL_AUTH_REQUIRED" }).label).toBe("PORTAL_AUTH_REQUIRED");
    expect(displayProgress({ state: "MISMATCH" }).label).toBe("MISMATCH");
    expect(displayProgress({ state: "SEARCH_FAILED" }).label).toBe("SEARCH_FAILED");
  });
});
