import { describe, it, expect } from "vitest";
import { writeFileSync } from "fs";
import { validateCapturedPdf } from "@/server/container/live-run";
import { CONTAINER_STEPS, stepIndex } from "@/server/container/progress";
import { buildContainerHtml, CONTAINER_PDF_FIELDS } from "@/server/container/render-pdf";
import type { ContainerResult } from "@/server/container/parse";

const SAMPLE: ContainerResult = {
  found: true,
  heading: "Container Infromation",
  containerNo: "TLLU4872965",
  positionLocation: "Slot : T-OC89, Block : , Yard :",
  slot: "T-OC89", block: "", yard: "",
  category: "IMPRT", type: "MTY", destination: "2599",
  mlo: "MSL, MAERSK A/S", shippingAgent: "MBL, MAERSK BANGLADESH LTD",
  isoCode: "45G1", assignment: "", assignmentDateTime: "",
  containerSize: "40", containerHeight: "9.6", fields: {},
};

/** A minimal but structurally valid single-page PDF, padded over the size floor. */
function makeValidPdf(): Buffer {
  const body =
    "%PDF-1.4\n" +
    "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
    "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\n" +
    `% padding ${"x".repeat(700)}\n` +
    "trailer<</Root 1 0 R>>\n" +
    "%%EOF";
  return Buffer.from(body, "latin1");
}

describe("container PDF validation", () => {
  it("accepts a real, non-trivial PDF with a page object", () => {
    const v = validateCapturedPdf(makeValidPdf());
    expect(v.ok).toBe(true);
    expect(v.pages).toBeGreaterThanOrEqual(1);
    expect(v.bytes).toBeGreaterThan(600);
  });

  it("rejects empty / garbage buffers", () => {
    expect(validateCapturedPdf(Buffer.alloc(0)).ok).toBe(false);
    expect(validateCapturedPdf(Buffer.from("not a pdf at all, just text")).ok).toBe(false);
  });

  it("rejects a PDF missing its %%EOF trailer (partial download)", () => {
    const partial = Buffer.from("%PDF-1.4\n3 0 obj<</Type/Page>>endobj\n" + "y".repeat(700), "latin1");
    const v = validateCapturedPdf(partial);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/%%EOF/i);
  });

  it("rejects a header-less buffer even when large", () => {
    const v = validateCapturedPdf(Buffer.from("z".repeat(2000), "latin1"));
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/%PDF-/);
  });
});

describe("container PDF replica HTML (reference layout)", () => {
  const html = buildContainerHtml(SAMPLE);

  it("has the 12 fields in the exact screenshot order with real values", () => {
    const labels = CONTAINER_PDF_FIELDS.map((f) => f.label);
    expect(labels).toEqual([
      "Container NO", "Position / Location", "Category", "Type", "Destination", "MLO",
      "Shipping Agent", "ISO Code", "Assignment", "Assignment Date & Time", "Container Size", "Container Height",
    ]);
    // Labels appear in document order.
    let last = -1;
    for (const l of labels) { const i = html.indexOf(`>${l.replace(/&/g, "&amp;")}<`); expect(i).toBeGreaterThan(last); last = i; }
    expect(html).toContain("TLLU4872965");
    expect(html).toContain("Slot : T-OC89");
    expect(html).toContain("MBL, MAERSK BANGLADESH LTD");
  });

  it("renders the CPA logo, centred heading, white background and no borders/extra content", () => {
    expect(html).toContain("data:image/gif;base64,");
    expect(html).toContain("Container Infromation");
    expect(html).toMatch(/background:\s*#ffffff/i);
    expect(html).not.toMatch(/border\s*[:=]/i); // no borders
    expect(html).not.toMatch(/<td[^>]*border/i);
  });

  it("leaves unavailable fields blank (never invents data)", () => {
    // Assignment + Assignment Date & Time are blank in the sample.
    expect(html).toMatch(/Assignment<\/td><td class="col">:<\/td><td class="val"><\/td>/);
  });

  it("writes a sample HTML for visual comparison", () => {
    const out = "C:/Users/zobayer/AppData/Local/Temp/container-replica.html";
    writeFileSync(out, html);
    expect(html.length).toBeGreaterThan(500);
  });
});

describe("container progress steps (spec contract)", () => {
  it("has exactly the seven spec statuses in order", () => {
    expect([...CONTAINER_STEPS]).toEqual([
      "Opening CTG Port",
      "Opening Port Community System",
      "Entering Container Details",
      "Searching",
      "Verifying Result",
      "Downloading PDF",
      "Download Verified",
    ]);
  });

  it("resolves step indices and returns -1 for unknown", () => {
    expect(stepIndex("Searching")).toBe(3);
    expect(stepIndex("nope")).toBe(-1);
  });
});
