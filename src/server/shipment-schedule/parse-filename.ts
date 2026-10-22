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

  // Match: leading digits, then whitespace or separator, then the rest.
  const m = base.match(/^(\d{4,})[\s_-]+(.+)$/);
  if (!m) return { orderNoPrefix: "", marketCode: "", marketSubCode: "", ok: false, reason: "no <digits> <code> pattern" };

  const orderNoPrefix = m[1];
  const marketSubCode = m[2].trim();
  if (!marketSubCode) return { orderNoPrefix, marketCode: "", marketSubCode: "", ok: false, reason: "missing market sub-code" };

  // Leading two uppercase ASCII letters = market code.
  const mm = marketSubCode.match(/^([A-Z]{2})/);
  const marketCode = mm ? mm[1] : "";
  if (!marketCode) return { orderNoPrefix, marketCode: "", marketSubCode, ok: false, reason: "sub-code does not start with 2 letters" };

  return { orderNoPrefix, marketCode, marketSubCode, ok: true };
}
