import { PDFDocument, PDFName, PDFArray, PDFRawStream, decodePDFRawStream } from "pdf-lib";

/**
 * In-place PDF text editor for the captured Damco/Maersk booking PDF.
 *
 * Replaces the title "Booking Requested" → "Booking Confirmation" and the
 * Status field "REQUESTED" → "CONFIRMED" by editing the existing page content
 * streams — NOT by adding a page, rebuilding a template, or flattening to an
 * image. Every original page, dimension, table, border, logo, font and all
 * unrelated text is preserved; only the targeted characters inside PDF text
 * strings change. Replacement text is drawn by the document's own fonts at the
 * original positions, so it stays inside the existing areas.
 *
 * Fidelity note: this works when the target words are stored as literal text
 * strings `( … )` in the content stream (the usual case for report-generated
 * PDFs like Damco's). If a PDF encodes the title/status with a subset font that
 * hides the characters, no replacement is made and the caller is told (count
 * 0) so it can fail closed rather than emit a half-edited document.
 */

export interface InPlaceReplacement {
  from: string;
  to: string;
  /** A friendly name for the report. */
  label: string;
}

/** The exact edits the reference requires. Order matters (phrase before word). */
export const CONFIRM_REPLACEMENTS: InPlaceReplacement[] = [
  { label: "title", from: "Booking Requested", to: "Booking Confirmation" },
  { label: "status", from: "REQUESTED", to: "CONFIRMED" },
];

export interface InPlaceEditResult {
  buffer: Buffer;
  pages: number;
  /** Per-rule replacement counts across all pages. */
  counts: { label: string; from: string; to: string; count: number }[];
  totalReplacements: number;
}

/**
 * Replace `from`→`to` inside PDF text strings only — both literal `( … )` and
 * hexadecimal `< … >` forms (generators differ: Damco/Jasper usually emit
 * literals; pdf-lib emits hex). Operators, names and dictionaries are left
 * alone. Returns the edited content and the number of replacements.
 */
function applyReplacement(content: string, from: string, to: string): { text: string; n: number } {
  let n = 0;

  // Literal strings: ( ... ) with PDF escapes.
  let text = content.replace(/\((?:[^()\\]|\\.)*\)/g, (lit) => {
    const inner = lit.slice(1, -1);
    if (!inner.includes(from)) return lit;
    n += inner.split(from).length - 1;
    return "(" + inner.split(from).join(to) + ")";
  });

  // Hex strings: < hexdigits > (not the << >> dictionary delimiters).
  text = text.replace(/(?<!<)<([0-9A-Fa-f][0-9A-Fa-f\s]*)>(?!>)/g, (m, hex: string) => {
    const clean = hex.replace(/\s+/g, "");
    const padded = clean.length % 2 ? clean + "0" : clean;
    let str: string;
    try { str = Buffer.from(padded, "hex").toString("latin1"); } catch { return m; }
    if (!str.includes(from)) return m;
    n += str.split(from).length - 1;
    const replaced = str.split(from).join(to);
    return "<" + Buffer.from(replaced, "latin1").toString("hex").toUpperCase() + ">";
  });

  return { text, n };
}

function decodeStream(s: PDFRawStream): string {
  try {
    return Buffer.from(decodePDFRawStream(s).decode()).toString("latin1");
  } catch {
    // Unsupported filter or already-plain contents — use the raw bytes.
    return Buffer.from(s.contents).toString("latin1");
  }
}

/**
 * Apply the given text replacements in place. Never changes the page count.
 * Returns the edited bytes plus per-rule counts for auditing.
 */
export async function editPdfTextInPlace(
  basePdf: Buffer,
  replacements: InPlaceReplacement[] = CONFIRM_REPLACEMENTS,
): Promise<InPlaceEditResult> {
  const doc = await PDFDocument.load(basePdf, { ignoreEncryption: true });
  const counts = replacements.map((r) => ({ label: r.label, from: r.from, to: r.to, count: 0 }));
  const pages = doc.getPages();

  for (const page of pages) {
    const contentsRef = page.node.get(PDFName.of("Contents"));
    if (!contentsRef) continue;
    const obj = doc.context.lookup(contentsRef);

    const parts: string[] = [];
    if (obj instanceof PDFArray) {
      for (const el of obj.asArray()) {
        const s = doc.context.lookup(el);
        if (s instanceof PDFRawStream) parts.push(decodeStream(s));
      }
    } else if (obj instanceof PDFRawStream) {
      parts.push(decodeStream(obj));
    } else {
      continue;
    }

    let edited = parts.join("\n");
    let pageChanged = 0;
    for (const c of counts) {
      const { text, n } = applyReplacement(edited, c.from, c.to);
      edited = text;
      c.count += n;
      pageChanged += n;
    }

    if (pageChanged > 0) {
      const bytes = Uint8Array.from(Buffer.from(edited, "latin1"));
      const newStream = doc.context.flateStream(bytes);
      const newRef = doc.context.register(newStream);
      page.node.set(PDFName.of("Contents"), newRef);
    }
  }

  const out = await doc.save({ useObjectStreams: false });
  return {
    buffer: Buffer.from(out),
    pages: pages.length,
    counts,
    totalReplacements: counts.reduce((a, c) => a + c.count, 0),
  };
}
