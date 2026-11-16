import { describe, it, expect } from "vitest";
import { bookingPdfBase, bookingPdfFilename, uniqueBookingPdfName, type BookingNameFields } from "@/server/booking-correction/output-name";

/**
 * Booking PDF naming: PO_Country_FR, blanks dropped, sanitised flat, de-duped —
 * never a path, never ".pdf/" nesting, never an overwrite.
 */
describe("bookingPdfBase", () => {
  it("names PO_Country_FR (spec example)", () => {
    const d: BookingNameFields = { poNumber: "748183", countryCode: "US", frCode: "USW304" };
    expect(bookingPdfBase(d)).toBe("748183_US_USW304");
    expect(bookingPdfFilename(d)).toBe("748183_US_USW304.pdf");
  });

  it("drops blank parts", () => {
    expect(bookingPdfFilename({ poNumber: "748183", countryCode: "US" })).toBe("748183_US.pdf");
    expect(bookingPdfFilename({ poNumber: "748183", frCode: "USW304" })).toBe("748183_USW304.pdf");
  });

  it("falls back to booking ref, then serial, then a constant", () => {
    expect(bookingPdfFilename({ bookingRef: "62329611" })).toBe("62329611.pdf");
    expect(bookingPdfFilename({ serial: 5 })).toBe("doc-5.pdf");
    expect(bookingPdfFilename({})).toBe("booking.pdf");
  });

  it("sanitises to a flat, safe basename (no paths, no double extension)", () => {
    expect(bookingPdfBase({ poNumber: "../etc", countryCode: "a/b", frCode: "x y.pdf" })).toBe("etc_a_b_x_y");
  });
});

describe("uniqueBookingPdfName", () => {
  it("suffixes -2, -3 so duplicates never overwrite", () => {
    const used = new Set<string>();
    const d = { poNumber: "748183", countryCode: "US", frCode: "USW304" };
    expect(uniqueBookingPdfName(d, used)).toBe("748183_US_USW304.pdf");
    expect(uniqueBookingPdfName(d, used)).toBe("748183_US_USW304-2.pdf");
    expect(uniqueBookingPdfName(d, used)).toBe("748183_US_USW304-3.pdf");
  });

  it("applies a variant suffix (original/damco/edited) to separate files of one doc", () => {
    const used = new Set<string>();
    const d = { poNumber: "748183", countryCode: "US", frCode: "USW304" };
    expect(uniqueBookingPdfName(d, used, "original")).toBe("748183_US_USW304_original.pdf");
    expect(uniqueBookingPdfName(d, used, "damco")).toBe("748183_US_USW304_damco.pdf");
    expect(uniqueBookingPdfName(d, used, "edited")).toBe("748183_US_USW304_edited.pdf");
  });
});
