import type { FilenameParts } from "./types";

/**
 * Parse a booking-confirmation PDF's filename.
 *
 * The sample set shows: "<6+ digit OrderNo> <market+sub>.pdf" — for example
 *   "569959 AUW118.pdf"     → orderNo 569959, market AU, sub AUW118
 *   "571381 CLW093.pdf"     → orderNo 571381, market CL, sub CLW093
 *   "569959 OW-NLW195.pdf"  → orderNo 569959, market OW, sub OW-NLW195
 *
 * Rules (never invent — if the pattern doesn't match, ok=false):
 *   - OrderNo prefix = the first contiguous run of digits.
 *   - The rest (after the space and before ".pdf") is the full marketSubCode.
 *   - marketCode = the first two uppercase letters of the sub-code
 *     (stopping before any dash/digit so "OW-NLW195" → "OW", "AUW118" → "AU").
 */
export function parseBookingFilename(filename: string): FilenameParts {
  const base = filename.replace(/\.pdf$/i, "").trim();
  if (!base) return { orderNoPrefix: "", marketCode: "", marketSubCode: "", ok: false, reason: "empty filename" };

  // Preferred shape: "<digits><sep><market+sub>" (e.g. "569959 AUW118").
  const full = base.match(/^(\d{4,})[\s_-]+(.+)$/);
  if (full) {
    const orderNoPrefix = full[1];
    const marketSubCode = full[2].trim();
    const mm = marketSubCode.match(/^([A-Z]{2})/);
    const marketCode = mm ? mm[1] : "";
    if (marketCode) return { orderNoPrefix, marketCode, marketSubCode, ok: true };
    // Fall through — we still have the order no, just no usable market in the
    // filename. The PDF text / Sales Contract will fill the market.
    return { orderNoPrefix, marketCode: "", marketSubCode, ok: true, reason: "market_from_pdf_or_contract" };
  }

  // Looser shape: digits only (e.g. "698518.pdf"). The order no is enough to
  // match a Sales Contract PO; market comes from the PDF text or hydration.
  const digitsOnly = base.match(/^(\d{4,})$/);
  if (digitsOnly) {
    return { orderNoPrefix: digitsOnly[1], marketCode: "", marketSubCode: "", ok: true, reason: "market_from_pdf_or_contract" };
  }

  // Last resort: pick the first contiguous digit run anywhere in the name.
  const anyDigits = base.match(/(\d{5,})/);
  if (anyDigits) {
    return { orderNoPrefix: anyDigits[1], marketCode: "", marketSubCode: "", ok: true, reason: "digits_only_in_name" };
  }

  return { orderNoPrefix: "", marketCode: "", marketSubCode: "", ok: false, reason: "no digits found in filename" };
}
