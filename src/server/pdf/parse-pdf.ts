/**
 * Shared PDF → text helper.
 *
 * pdf-parse embeds an old pdf.js that keeps module-level state; parsing several
 * documents at once in one process can corrupt it (intermittent "bad XRef
 * entry"). All parse calls are serialized through a single promise chain and
 * retried once on failure, so batch concurrency never trips the parser.
 *
 * Pure text extraction only — no business logic. Callers interpret the text.
 */

let pdfParseChain: Promise<unknown> = Promise.resolve();

export async function parsePdfText(buffer: Buffer): Promise<{ text: string; numpages: number }> {
  const run = async () => {
    // Import the library module directly (not the package root): pdf-parse's
    // index.js runs a file-reading debug branch when it thinks it is the main
    // module, which breaks under bundlers / test runners. The lib export is clean.
    const pdfParse = (await import("pdf-parse/lib/pdf-parse.js")).default;
    try {
      const d = await pdfParse(buffer);
      return { text: d.text ?? "", numpages: d.numpages ?? 1 };
    } catch {
      const d = await pdfParse(buffer);
      return { text: d.text ?? "", numpages: d.numpages ?? 1 };
    }
  };
  const result = pdfParseChain.then(run, run);
  pdfParseChain = result.then(() => undefined, () => undefined);
  return result;
}
