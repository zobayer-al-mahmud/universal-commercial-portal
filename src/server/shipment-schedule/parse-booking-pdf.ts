import type { BookingPdfFields } from "./types";

/**
 * Pure parser for the booking-confirmation PDF's pdf-parse text.
 *
 * Reads every field we can; never invents. Any field we fail to locate is left
 * blank/null — the matcher upstream decides whether that blocks a row.
 *
 * Layout observations (from the real sample set):
 * - Line 6 (approx) = BCN / ID number (8 digits).
 * - Line 10 = Booking Confirmation Reference (BRef, e.g. "CTG4407121").
 * - "Status" label is followed on the next line by the status text.
 * - "Port of Loading", "Port of Discharge", "Place of Delivery" labels have the
 *   value on the line immediately after.
 * - "Service" is followed by the service code ("CFS/CY" for sea, "AIR").
 * - "PO:" marker is followed by the raw PO number (e.g. "569959/3-2026").
 * - "SKU / ITEM:" marker is followed by the SKU/ITEM (e.g. "AU/5686").
 * - "Categories" is followed by the market-sub code (e.g. "AUW118").
 * - A "TOTAL :" row carries the total PCS / cartons.
 */
export function parseBookingPdfText(text: string): BookingPdfFields {
  const warnings: string[] = [];
  const result: BookingPdfFields = {
    bcn: "",
    bookingRef: "",
    bookingStatus: "",
    portOfLoading: "",
    portOfDischarge: "",
    placeOfDelivery: "",
    transportMode: "",
    pdfOrderNo: "",
    skuItem: "",
    categories: "",
    pdfPcs: null,
    cartons: null,
    grossWeightKg: null,
    measurementCbm: null,
    rawTextLen: text.length,
    warnings,
  };
  if (!text || text.length < 50) {
    warnings.push("empty_or_tiny_pdf_text");
    return result;
  }

  // Normalise lines once.
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const next = (i: number): string => (i + 1 < lines.length ? lines[i + 1] : "");

  // BCN: first 7-9 digit run that appears before BRef label, in the header
  // block (we see "ID :" then the number before "BRef :" label).
  for (let i = 0; i < Math.min(lines.length, 30); i++) {
    const l = lines[i];
    if (/^\d{7,9}$/.test(l) && !result.bcn) {
      result.bcn = l;
      break;
    }
  }

  // BRef: a short alphanumeric starting with CTG/BL/etc., often on the line
  // just after "BCN :" (two dates may sit between the ID and the BRef, so we
  // search by shape).
  for (let i = 0; i < Math.min(lines.length, 30); i++) {
    const l = lines[i];
    if (/^[A-Z]{2,5}\d{5,10}$/.test(l) && !result.bookingRef) {
      result.bookingRef = l;
      break;
    }
  }

  // Labelled single-value fields. Labels can appear mid-line (pdf-parse often
  // concatenates two columns: e.g. "Export Licence No.Port of Loading"), so we
  // match "ends with" rather than "equals".
  const labelled: { label: RegExp; set: (v: string) => void }[] = [
    { label: /\bStatus$/i, set: (v) => (result.bookingStatus = v) },
    { label: /\bPort of Loading$/i, set: (v) => (result.portOfLoading = v) },
    { label: /\bPort of Discharge$/i, set: (v) => (result.portOfDischarge = v) },
    { label: /\bPlace of Delivery$/i, set: (v) => (result.placeOfDelivery = v) },
    { label: /\bService$/i, set: (v) => (result.transportMode = v) },
  ];
  for (let i = 0; i < lines.length; i++) {
    for (const { label, set } of labelled) {
      if (label.test(lines[i])) {
        const v = next(i);
        // Skip lines that are themselves another label.
        if (v && !/^(Expected|Export|Carrier|Freight|Estimated|FOB|Carrier's|Transportation|Gross|Quantity|Packages|Measurement|Place|Port)/i.test(v)) {
          set(v);
        }
      }
    }
  }

  // PO number — appears on its own line like "569959/3-2026".
  const poMatch = text.match(/\b(\d{5,7}\/\d+-\d{4})\b/);
  if (poMatch) result.pdfOrderNo = poMatch[1];

  // SKU/ITEM — pdf-parse concatenates it with the label on the next column
  // (e.g. "AU/5686SKU / ITEM:"), so we match the pattern itself without
  // requiring a trailing word boundary — a letter immediately following the
  // digits (the next column's label text) counts as the end.
  const skuMatch = text.match(/\b([A-Z]{2}\/\d{4,6})(?=\D|$)/);
  if (skuMatch) result.skuItem = skuMatch[1];

  // Categories = the market-sub code (e.g. AUW118).
  // Appears right after the "Categories" label block in the data table.
  // We take the first <2-letter market><letter><3-digit sub> pattern.
  const catMatch = text.match(/\b([A-Z]{2}[A-Z]\d{3})\b/);
  if (catMatch) result.categories = catMatch[1];

  // Totals row — look for "TOTAL :" and the surrounding numbers.
  // Example lines (concatenated by pdf-parse):
  //   "/" then "326.660" then "0.113" then "CARTONPCS" then "TOTAL :" then "71"
  // Simpler: find "TOTAL :" and the last PCS/CARTON numbers in that block.
  const totalIdx = lines.findIndex((l) => /^TOTAL\s*:/i.test(l));
  if (totalIdx >= 0) {
    // The total PCS = the integer immediately after "TOTAL :".
    for (let i = totalIdx + 1; i < Math.min(lines.length, totalIdx + 6); i++) {
      const n = parseInt(lines[i], 10);
      if (!isNaN(n) && result.pdfPcs === null) {
        result.pdfPcs = n;
        break;
      }
    }
    // Scan backward for cartons / weight / cbm numeric block.
    for (let i = Math.max(0, totalIdx - 10); i < totalIdx; i++) {
      const l = lines[i];
      if (/^\d+\.\d+$/.test(l)) {
        const n = parseFloat(l);
        if (n < 10 && result.measurementCbm === null) result.measurementCbm = n;
        else if (n >= 10 && result.grossWeightKg === null) result.grossWeightKg = n;
      } else if (/^\d{1,4}$/.test(l) && result.cartons === null) {
        const n = parseInt(l, 10);
        // Cartons are typically a small integer; avoid picking up a PCS number.
        if (n > 0 && n < 1000) result.cartons = n;
      }
    }
  } else {
    warnings.push("no_total_row");
  }

  // Derive an "AIR" / "SEA" transportMode if the service code gives it away.
  if (result.transportMode) {
    const m = result.transportMode.toUpperCase();
    if (m.includes("AIR")) result.transportMode = "AIR";
    else if (m === "CFS/CY" || m.includes("CY") || m.includes("CFS")) result.transportMode = "SEA";
  }

  // Normalise bookingStatus to upper-case for consistent downstream checks.
  if (result.bookingStatus) result.bookingStatus = result.bookingStatus.toUpperCase().trim();

  return result;
}
