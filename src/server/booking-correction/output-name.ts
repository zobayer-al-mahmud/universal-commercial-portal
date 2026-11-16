/**
 * Booking Correction PDF output naming — the single source of truth for what a
 * downloaded booking PDF is called, shared by the batch ZIP and the per-document
 * download routes so a file has the SAME name everywhere.
 *
 * Rule (spec): name by the booking record's own fields —
 *   `PO_Country_FR.pdf`  e.g. `748183_US_USW304.pdf`
 * (PO number, H&M country/market code, and the FR booking reference / frCode).
 *
 * Fallbacks keep a file from ever being nameless: drop any blank part, then fall
 * back to the booking reference, then the serial. Names are sanitised to a safe,
 * flat basename (no path separators, no directory prefix, no double ".pdf"); this
 * never creates ".pdf/" folders or nesting. Pure — no I/O — so it is unit-testable
 * and shared freely.
 */

export interface BookingNameFields {
  serial?: number;
  poNumber?: string | null;
  countryCode?: string | null;
  frCode?: string | null;
  bookingRef?: string | null;
}

/** Collapse a value to a safe, flat filename token (never a path, never ".pdf"). */
function sanitizeToken(v: string | null | undefined): string {
  return (v ?? "")
    .trim()
    .replace(/\.pdf$/i, "")
    .replace(/[\\/]+/g, "_") // never allow path separators
    .replace(/[^\w.-]+/g, "_") // keep word chars, dot, dash
    .replace(/_{2,}/g, "_")
    .replace(/^[_.]+|[_.]+$/g, "")
    .slice(0, 120);
}

/** The basename (no extension) for a document's PDF: PO_Country_FR, blanks dropped. */
export function bookingPdfBase(doc: BookingNameFields): string {
  const parts = [doc.poNumber, doc.countryCode, doc.frCode]
    .map(sanitizeToken)
    .filter(Boolean);
  if (parts.length) return parts.join("_");

  const ref = sanitizeToken(doc.bookingRef);
  if (ref) return ref;
  return doc.serial != null ? `doc-${doc.serial}` : "booking";
}

/** The full `<base>.pdf` filename for a single document. */
export function bookingPdfFilename(doc: BookingNameFields): string {
  return `${bookingPdfBase(doc)}.pdf`;
}

/**
 * De-duplicating namer for a batch: returns a unique `<base>.pdf`, suffixing
 * `-2`, `-3`, … when the base is already taken (case-insensitively), and records
 * the chosen name in `used`. An optional `suffix` distinguishes variants of the
 * same document (e.g. "original", "damco", "edited") so they never collide.
 */
export function uniqueBookingPdfName(doc: BookingNameFields, used: Set<string>, suffix?: string): string {
  const base = suffix ? `${bookingPdfBase(doc)}_${sanitizeToken(suffix)}` : bookingPdfBase(doc);
  let name = `${base}.pdf`;
  let n = 2;
  while (used.has(name.toLowerCase())) name = `${base}-${n++}.pdf`;
  used.add(name.toLowerCase());
  return name;
}
