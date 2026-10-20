/**
 * Minimal, dependency-free PDF writer — enough to render a single-page,
 * text-only booking document whose text is extractable again by pdf-parse
 * (so the generated PDF can be re-validated, per §10). Not a general PDF
 * library: it emits one page of Helvetica lines.
 */

function escapePdfText(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)").replace(/[\r\n]+/g, " ");
}

export interface BookingPdfInput {
  title: string; // document heading, e.g. "BOOKING CONFIRMED"
  lines: string[]; // body lines (already formatted "Label: value")
  footer?: string;
}

/** Build a valid single-page PDF from heading + body lines. Returns a Buffer. */
export function buildBookingPdf(input: BookingPdfInput): Buffer {
  const contentLines: string[] = [];
  const left = 60;
  let y = 770;

  const push = (text: string, size: number, dy: number) => {
    contentLines.push(`BT /F1 ${size} Tf ${left} ${y} Td (${escapePdfText(text)}) Tj ET`);
    y -= dy;
  };

  push(input.title, 18, 30);
  push("DAMCO Shipper Portal — Booking Document", 9, 24);
  for (const line of input.lines) {
    if (y < 70) break; // single page only
    push(line, 11, 16);
  }
  if (input.footer) {
    y = 60;
    push(input.footer, 8, 0);
  }

  const content = contentLines.join("\n");
  const contentBytes = Buffer.from(content, "latin1");

  const objects: string[] = [];
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push("<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  objects.push("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>");
  objects.push(`<< /Length ${contentBytes.length} >>\nstream\n${content}\nendstream`);
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefOffset = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;

  return Buffer.from(pdf, "latin1");
}
