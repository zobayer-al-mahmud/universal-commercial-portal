import { PDFDocument } from "pdf-lib";

/**
 * PDF Combiner — merge PDF buffers in order into one document (no I/O).
 * Throws with the offending input's label when a source cannot be read
 * (corrupt, encrypted, not a PDF) — the caller fails that row closed.
 */
export async function mergePdfs(inputs: { label: string; data: Uint8Array }[]): Promise<{ bytes: Uint8Array; pageCount: number }> {
  if (inputs.length === 0) throw new Error("Nothing to merge.");
  const out = await PDFDocument.create();
  for (const input of inputs) {
    let src: PDFDocument;
    try {
      src = await PDFDocument.load(input.data);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`${input.label}: cannot read PDF (${/encrypt/i.test(msg) ? "password-protected / encrypted" : msg})`);
    }
    const pages = await out.copyPages(src, src.getPageIndices());
    pages.forEach((p) => out.addPage(p));
  }
  return { bytes: await out.save(), pageCount: out.getPageCount() };
}
