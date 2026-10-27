/**
 * PDF File Rename — OCR support for scanned shipping-bill PDFs (module 4).
 *
 * The scanned copies in `WEEK- 41 SHIPPING BILL SCAN COPY/` carry no embedded
 * text — each page is a 1-bit CCITT Group-4 (fax) image. To read the invoice
 * number we:
 *   1. pull the CCITT-G4 image stream of each page out of the PDF with pdf-lib
 *      (no rasteriser / native dependency needed — the compressed fax data is
 *      already what a TIFF stores),
 *   2. wrap it in a minimal single-strip TIFF (Compression = Group 4), and
 *   3. run Tesseract (tesseract.js, WASM) over the TIFF.
 *
 * OCR is GATED behind `OCR_ENABLED`. When it is off (or the engine/traineddata
 * is unavailable, or a page is not plain G4), the caller receives empty text and
 * routes the file to manual review — it is never marked successfully renamed.
 */

import { env } from "@/lib/env";

/** Build a minimal single-strip CCITT Group-4 TIFF around raw G4 fax bytes. */
export function buildG4Tiff(raw: Buffer, width: number, height: number, photometric: 0 | 1 = 0): Buffer {
  const entries: Array<[number, number, number, number]> = [
    [256, 4, 1, width], //  ImageWidth (LONG)
    [257, 4, 1, height], // ImageLength (LONG)
    [258, 3, 1, 1], //      BitsPerSample (SHORT)
    [259, 3, 1, 4], //      Compression = 4 (CCITT Group 4)
    [262, 3, 1, photometric], // PhotometricInterpretation (0 = WhiteIsZero)
    [273, 4, 1, 0], //      StripOffsets (patched below)
    [277, 3, 1, 1], //      SamplesPerPixel
    [278, 4, 1, height], // RowsPerStrip (single strip)
    [279, 4, 1, raw.length], // StripByteCounts
    [282, 5, 1, 0], //      XResolution (RATIONAL, patched)
    [283, 5, 1, 0], //      YResolution (RATIONAL, patched)
    [296, 3, 1, 2], //      ResolutionUnit = inch
  ];
  const n = entries.length;
  const headerLen = 8;
  const ifdLen = 2 + n * 12 + 4;
  const ratLen = 16; // two RATIONALs stored after the IFD
  const dataOffset = headerLen + ifdLen + ratLen;
  const buf = Buffer.alloc(dataOffset + raw.length);

  buf.write("II", 0, "latin1");
  buf.writeUInt16LE(42, 2);
  buf.writeUInt32LE(8, 4); // first IFD at offset 8

  let o = 8;
  buf.writeUInt16LE(n, o);
  o += 2;
  const xResOff = headerLen + ifdLen;
  const yResOff = xResOff + 8;
  for (const [tag, type, count, value] of entries) {
    buf.writeUInt16LE(tag, o);
    buf.writeUInt16LE(type, o + 2);
    buf.writeUInt32LE(count, o + 4);
    let v = value;
    if (tag === 273) v = dataOffset;
    if (tag === 282) v = xResOff;
    if (tag === 283) v = yResOff;
    if (type === 3) {
      buf.writeUInt16LE(v & 0xffff, o + 8);
      buf.writeUInt16LE(0, o + 10);
    } else {
      buf.writeUInt32LE(v >>> 0, o + 8);
    }
    o += 12;
  }
  buf.writeUInt32LE(0, o); // next-IFD offset = 0
  buf.writeUInt32LE(200, xResOff);
  buf.writeUInt32LE(1, xResOff + 4);
  buf.writeUInt32LE(200, yResOff);
  buf.writeUInt32LE(1, yResOff + 4);
  raw.copy(buf, dataOffset);
  return buf;
}

export interface PageImage {
  tiff: Buffer;
  width: number;
  height: number;
  page: number;
}

/**
 * Extract the first G4 image of each of the first `maxPages` pages of a PDF as a
 * TIFF. Returns [] when the PDF has no CCITT-G4 images (e.g. it is a different
 * scan encoding we do not transcode here) so the caller can fall back to review.
 */
export async function extractG4Pages(pdf: Buffer, maxPages: number): Promise<PageImage[]> {
  const { PDFDocument, PDFName, PDFRawStream, PDFDict } = await import("pdf-lib");
  const doc = await PDFDocument.load(pdf, { ignoreEncryption: true });
  const pages = doc.getPages();
  const out: PageImage[] = [];
  for (let p = 0; p < Math.min(pages.length, maxPages); p++) {
    const res = pages[p].node.Resources();
    if (!res) continue;
    const xobjs = res.lookup(PDFName.of("XObject"), PDFDict);
    if (!xobjs) continue;
    for (const [, ref] of xobjs.entries()) {
      const stream = doc.context.lookup(ref);
      if (!(stream instanceof PDFRawStream)) continue;
      const d = stream.dict;
      const filter = d.lookup(PDFName.of("Filter"));
      if (!filter || !filter.toString().includes("CCITTFax")) continue;
      // DecodeParms: only pure Group-4 (K < 0) is transcoded losslessly to a
      // Compression=4 TIFF. BlackIs1 (default false) selects the photometry.
      const parms = d.lookup(PDFName.of("DecodeParms")) || d.lookup(PDFName.of("DP"));
      let k = -1;
      let blackIs1 = false;
      if (parms && parms instanceof PDFDict) {
        const kv = parms.lookup(PDFName.of("K"));
        if (kv) k = Number(kv.toString());
        const b = parms.lookup(PDFName.of("BlackIs1"));
        if (b) blackIs1 = b.toString() === "true";
      }
      if (k >= 0) continue; // not plain G4 — leave for review rather than guess
      const width = Number(d.lookup(PDFName.of("Width"))?.toString() ?? 0);
      const height = Number(d.lookup(PDFName.of("Height"))?.toString() ?? 0);
      if (!width || !height) continue;
      const raw = Buffer.from(stream.contents);
      out.push({ tiff: buildG4Tiff(raw, width, height, blackIs1 ? 1 : 0), width, height, page: p });
      break; // one image per page is the whole scan
    }
  }
  return out;
}

// --- Tesseract worker (lazy singleton, serialized) -------------------------
// The WASM worker is expensive to spin up, so one is reused for a whole batch.
// recognize() is not re-entrant on a single worker, so calls are serialized.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TessWorker = { recognize: (img: Buffer, opts?: unknown, output?: unknown) => Promise<{ data: { text: string; confidence?: number; blocks?: any[] } }>; terminate: () => Promise<unknown> };
let workerPromise: Promise<TessWorker> | null = null;
let ocrChain: Promise<unknown> = Promise.resolve();

async function getWorker(): Promise<TessWorker> {
  if (!workerPromise) {
    workerPromise = (async () => {
      const path = await import("path");
      const { createWorker } = await import("tesseract.js");
      const dir = path.resolve(env.OCR_TESSDATA_DIR);
      // gzip:false → read an uncompressed `<lang>.traineddata` from the dir.
      const worker = await createWorker(env.OCR_LANG, 1, {
        langPath: dir,
        cachePath: dir,
        gzip: false,
      });
      return worker as unknown as TessWorker;
    })().catch((e) => {
      workerPromise = null; // allow a retry on the next call
      throw e;
    });
  }
  return workerPromise;
}

/** One OCR'd word: its text and the engine's per-word confidence (0..100). */
export interface OcrWord {
  text: string;
  confidence: number;
}

/**
 * Run OCR over one TIFF page image (serialized). Returns the page text, the mean
 * page confidence (0..1) AND every word with its own confidence — the validator
 * scores the matched invoice token by its OWN words, not the (often low) page
 * mean, so a clearly-read number on a noisy customs page is not sent to review.
 */
async function recognize(tiff: Buffer): Promise<{ text: string; confidence: number; words: OcrWord[] }> {
  const run = async () => {
    const worker = await getWorker();
    // v5: pass an output spec to get structured blocks (→ per-word confidence).
    const { data } = await worker.recognize(tiff, {}, { blocks: true, text: true });
    const conf = typeof data.confidence === "number" ? Math.max(0, Math.min(1, data.confidence / 100)) : 0.85;
    const words: OcrWord[] = [];
    for (const b of data.blocks ?? [])
      for (const par of b?.paragraphs ?? [])
        for (const ln of par?.lines ?? [])
          for (const w of ln?.words ?? [])
            words.push({ text: typeof w?.text === "string" ? w.text : "", confidence: typeof w?.confidence === "number" ? w.confidence : 0 });
    return { text: (data.text ?? "").replace(/\r/g, ""), confidence: conf, words };
  };
  const result = ocrChain.then(run, run);
  ocrChain = result.then(() => undefined, () => undefined);
  return result;
}

export interface OcrPage {
  page: number; // 1-based
  text: string;
  confidence: number; // 0..1 mean OCR confidence
  words: OcrWord[]; // per-word confidence for token-level scoring
}

export interface OcrPagesResult {
  pages: OcrPage[];
  engineAvailable: boolean;
  error?: string;
}

export interface OcrResult {
  text: string;
  pagesOcred: number;
  engineAvailable: boolean;
  error?: string;
}

/**
 * OCR a scanned PDF and return its concatenated page text. Gated by OCR_ENABLED.
 * Honest failure: if the engine/traineddata is unavailable or the pages are not
 * plain G4, returns empty text with `engineAvailable=false`/an error — never a
 * fabricated result.
 */
export async function ocrPdfText(pdf: Buffer): Promise<OcrResult> {
  const r = await ocrPdfPages(pdf);
  return {
    text: r.pages.map((p) => p.text).join("\n"),
    pagesOcred: r.pages.length,
    engineAvailable: r.engineAvailable,
    error: r.error,
  };
}

/**
 * OCR a scanned PDF PER PAGE (so candidates keep page attribution + a per-page
 * confidence for the deep validator). Gated by OCR_ENABLED; honest failure on an
 * unavailable engine / non-G4 pages.
 */
export async function ocrPdfPages(pdf: Buffer): Promise<OcrPagesResult> {
  if (!env.OCR_ENABLED) return { pages: [], engineAvailable: false, error: "OCR disabled (OCR_ENABLED=false)" };
  let images: PageImage[];
  try {
    images = await extractG4Pages(pdf, env.OCR_MAX_PAGES);
  } catch (e) {
    return { pages: [], engineAvailable: true, error: `Image extraction failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (images.length === 0) return { pages: [], engineAvailable: true, error: "No CCITT Group-4 page image found to OCR" };

  const pages: OcrPage[] = [];
  try {
    for (const img of images) {
      const { text, confidence, words } = await recognize(img.tiff);
      pages.push({ page: img.page + 1, text, confidence, words });
    }
  } catch (e) {
    return { pages, engineAvailable: false, error: `OCR engine error: ${e instanceof Error ? e.message : String(e)}` };
  }
  return { pages, engineAvailable: true };
}

/** Release the OCR worker (used by scripts/tests; the web app keeps it warm). */
export async function shutdownOcr(): Promise<void> {
  if (workerPromise) {
    try {
      const w = await workerPromise;
      await w.terminate();
    } catch {
      /* ignore */
    }
    workerPromise = null;
  }
}
