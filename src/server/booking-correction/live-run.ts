import { createHash } from "crypto";
import { mkdir, writeFile, rename, stat, unlink } from "fs/promises";
import { join } from "path";
import { env } from "@/lib/env";
import {
  liveSearchBookings,
  openBookingDetail,
  generateBookingPdf,
  readBookingDetails,
  validatePortalPdf,
  type LiveBooking,
  type PortalPdfCapture,
} from "@/server/integrations/damco-live";
import { parseCtnsQtyTable, normalizeNumber } from "./extract";
import { normalizeStatus } from "./status";
import { matchBooking } from "./match";
import type { BookingCandidate } from "@/server/integrations/damco-portal";
import type { ExtractionResult, MatchResult } from "./batch-types";
import type { BookingLiveStep } from "./progress";

/**
 * One live run (one visible browser) at a time per process. The portal UI is a
 * single interactive window — concurrent clicks across documents corrupt it.
 */
let runChain: Promise<unknown> = Promise.resolve();
export function serializeLiveRun<T>(fn: () => Promise<T>): Promise<T> {
  const next = runChain.then(fn, fn);
  runChain = next.then(() => undefined, () => undefined);
  return next;
}

export interface LivePortalResult {
  authRequired: boolean;
  ok: boolean;
  message: string;
  entryUrl: string;
  poQuery: string;
  countryQuery: string;
  candidates: BookingCandidate[];
  pickedBookingNumber: string;
  portalPdf: {
    buffer: Buffer;
    filename: string;
    sha256: string;
    path: string;
    bytes: number;
    pages: number;
    via: PortalPdfCapture["via"];
    sourceUrl: string;
  } | null;
  portalPdfError: string;
  portalValues: { grossWeight: string; cartons: string; quantity: string; headingStatus: string; fieldStatus: string } | null;
  /** Value comparison computed on the portal-read values BEFORE the PDF is generated. */
  match: MatchResult | null;
}

function toCandidate(b: LiveBooking, companyBuyer: { company: string; buyer: string; poNumber: string; countryCode: string }): BookingCandidate {
  const status = (b.bookingStatus || "").toUpperCase();
  return {
    soNumber: b.bookingNumber,
    company: companyBuyer.company,
    buyer: companyBuyer.buyer,
    poNumber: companyBuyer.poNumber,
    countryCode: companyBuyer.countryCode,
    grossWeight: "",
    cartons: "",
    quantity: "",
    headingStatus: status,
    fieldStatus: status,
  };
}

/**
 * Parse a Damco "Booking / Booking Confirmation" PDF's embedded text to recover
 * Gross Weight / Cartons / Quantity / status. The portal's PDF carries these in
 * the HEADER tab; layout varies, so we extract defensively and leave anything
 * we cannot read as empty (never invented).
 */
/**
 * Parse the actual Damco "Booking Delivery Information" PDF layout (verified
 * against the real portal PDF captured 2026-10-20):
 *
 *   Status:            DELIVERED
 *   Quantity           263 PCS
 *   Packages           15 CARTONS
 *   Gross weight       219.500   (Kilos)
 *   Measurement        0.904
 *   TOTAL:             263 PCS   15 CARTON   219.500   0.904
 *
 * The pdf-parse text output usually keeps labels and values on nearby lines but
 * ordering can vary. We first try the reliable TOTAL row (a single line with
 * all four numbers), then fall back to label-anchored matches, then to the
 * carton/qty table parser used for H&M packing lists.
 */
export function parsePortalPdfText(text: string): { grossWeight: string; cartons: string; quantity: string; headingStatus: string; fieldStatus: string } {
  const compact = text.replace(/ /g, " ");
  const first = (re: RegExp): string => {
    const m = compact.match(re);
    return m ? m[1].trim() : "";
  };

  // (1) TOTAL row — "TOTAL : 263 PCS 15 CARTON 219.500 0.904" (whitespace varies).
  let quantity = "", cartons = "", grossWeight = "";
  const totalLine = compact.match(/TOTAL\s*:?\s*([\d.,]+)\s*(?:PCS|PIECES|PC)\s*([\d.,]+)\s*CARTON[S]?\s*([\d.,]+)/i);
  if (totalLine) {
    quantity = normalizeNumber(totalLine[1]);
    cartons = normalizeNumber(totalLine[2]);
    grossWeight = normalizeNumber(totalLine[3]);
  }

  // (2) Fall back to label-anchored matches for anything the TOTAL row missed.
  if (!grossWeight) {
    grossWeight = normalizeNumber(
      first(/Gross\s*weight[^0-9]{0,30}([\d.,]+)/i) ||
      first(/Gross\s*Weight\s*\(Kilos\)[^0-9]{0,30}([\d.,]+)/i) ||
      first(/\bGW\b[^0-9]{0,20}([\d.,]+)/i),
    );
  }
  if (!cartons) {
    cartons = normalizeNumber(
      first(/\bPackages\b[^0-9]{0,30}([\d.,]+)\s*CARTON/i) ||
      first(/Total\s*(?:Cartons?|CTNS?|Ctns?)[^0-9]{0,20}([\d.,]+)/i) ||
      first(/\bNumber\s*of\s*Cartons?[^0-9]{0,20}([\d.,]+)/i),
    );
  }
  if (!quantity) {
    quantity = normalizeNumber(
      first(/\bQuantity\b[^0-9]{0,30}([\d.,]+)\s*(?:PCS|PIECES|PC)\b/i) ||
      first(/Total\s*(?:Quantity|Qty|Pieces|Pcs|Units)[^0-9]{0,20}([\d.,]+)/i) ||
      first(/\bPieces\b[^0-9]{0,20}([\d.,]+)/i),
    );
  }

  // (3) H&M carton/qty table fallback (concatenated totals).
  if (!cartons || !quantity) {
    const table = parseCtnsQtyTable(compact);
    if (table) {
      if (!cartons) cartons = table.cartons;
      if (!quantity) quantity = table.quantity;
    }
  }

  // Status: the real PDF has a "Status" cell near the top with values like
  // DELIVERED, CONFIRMED, REQUESTED. The document heading on Damco is
  // "Booking Delivery Information" (not "BOOKING CONFIRMED"), so we rely on
  // the Status field as the authoritative value.
  const statusMatch =
    compact.match(/Status[^A-Za-z0-9]{0,10}(CONFIRMED|REQUESTED|DELIVERED|CANCELLED|AMENDED|REJECTED)\b/i) ||
    compact.match(/\b(CONFIRMED|REQUESTED|DELIVERED|CANCELLED|AMENDED|REJECTED)\b/);
  const rawStatus = (statusMatch?.[1] || "").toUpperCase();
  const normalizedHeading = rawStatus ? rawStatus : "";
  const normalizedField = rawStatus ? rawStatus : "";
  const headingStatus = normalizedHeading;
  const fieldStatus = normalizedField;

  // Prefer the normalized value only when it maps to a known status; otherwise
  // keep the raw string (so DELIVERED, CANCELLED etc. flow through for status.ts).
  const h = normalizeStatus(headingStatus);
  const f = normalizeStatus(fieldStatus);
  return {
    grossWeight,
    cartons,
    quantity,
    headingStatus: h === "UNKNOWN" ? headingStatus : h,
    fieldStatus: f === "UNKNOWN" ? fieldStatus : f,
  };
}

/**
 * Drive the real Damco portal end-to-end for ONE document (visible browser,
 * serialized via `serializeLiveRun`): auth → shipper/consignee → Booking tab →
 * PO* + SKU* search → pick → open detail → Generate PDF → store it + parse it
 * for the three totals + status. The caller compares those against the input
 * PDF via the existing `matchBooking` + `validateStatus` pipeline.
 */
export async function runLivePortalForDoc(input: {
  batchId: string;
  docId: string;
  company: string;
  buyer: string;
  extraction: ExtractionResult;
  storageDir: string;
  /** Tolerance for the Gross Weight comparison (kg). */
  grossWeightToleranceKg?: number;
  /** Called at each live sub-step so the UI can show real progress. */
  onStep?: (step: BookingLiveStep, detail?: string) => Promise<void> | void;
}): Promise<LivePortalResult> {
  const entryUrl = env.DAMCO_PORTAL_URL;
  const poQuery = input.extraction.poNumber ? `${input.extraction.poNumber}*` : "";
  const countryQuery = input.extraction.countryCode ? `${input.extraction.countryCode}*` : "";
  const report = async (step: BookingLiveStep, detail?: string) => {
    try { await input.onStep?.(step, detail); } catch { /* progress reporting must never break the run */ }
  };
  const emptyNav = {
    entryUrl,
    poQuery,
    countryQuery,
    candidates: [] as BookingCandidate[],
    pickedBookingNumber: "",
    portalPdf: null,
    portalPdfError: "",
    portalValues: null,
    match: null,
  };

  if (!env.DAMCO_LIVE_ENABLED) {
    return { authRequired: true, ok: false, message: "Live Damco automation is disabled (DAMCO_LIVE_ENABLED=false).", ...emptyNav };
  }
  if (!env.DAMCO_USERNAME || !env.DAMCO_PASSWORD) {
    return { authRequired: true, ok: false, message: "Live mode enabled but DAMCO_USERNAME/DAMCO_PASSWORD are not configured.", ...emptyNav };
  }
  if (!input.extraction.poNumber) {
    return { authRequired: false, ok: false, message: "No PO number extracted; cannot search Damco.", ...emptyNav };
  }

  const tolerance = input.grossWeightToleranceKg ?? env.BOOKING_GROSS_WEIGHT_TOLERANCE_KG;

  return serializeLiveRun(async () => {
    // STEP: Searching Booking (auth → portal → PO* + SKU* search).
    await report("searching", `Searching PO ${poQuery} / SKU ${countryQuery}`);
    const search = await liveSearchBookings({ poNumber: input.extraction.poNumber, countryCode: input.extraction.countryCode });
    if (search.authRequired) {
      return { authRequired: true, ok: false, message: search.message, ...emptyNav };
    }
    if (!search.ok || search.bookings.length === 0) {
      return { authRequired: false, ok: false, message: search.message || "No booking found.", ...emptyNav };
    }
    const candidates: BookingCandidate[] = search.bookings.map((b) =>
      toCandidate(b, { company: input.company, buyer: input.buyer, poNumber: input.extraction.poNumber, countryCode: input.extraction.countryCode }),
    );
    const picked = candidates[0];

    // STEP: Opening Booking Details.
    await report("opening-detail", `Opening booking ${picked.soNumber}`);
    const opened = await openBookingDetail(picked.soNumber);
    if (!opened) {
      return {
        authRequired: false,
        ok: false,
        message: `Could not open booking ${picked.soNumber} detail page.`,
        entryUrl,
        poQuery,
        countryQuery,
        candidates,
        pickedBookingNumber: picked.soNumber,
        portalPdf: null,
        portalPdfError: "",
        portalValues: null,
        match: null,
      };
    }

    // STEP: Verifying Values. Read the authoritative GW / Cartons / Quantity /
    // status DIRECTLY from the Details tab DOM — the real portal data compared
    // against the uploaded packing list.
    await report("verifying-values", `Reading portal values for ${picked.soNumber}`);
    const details = await readBookingDetails().catch(() => ({ grossWeight: "", cartons: "", quantity: "", status: "", confirmationNumber: "" }));

    let portalValues: LivePortalResult["portalValues"] = {
      grossWeight: details.grossWeight,
      cartons: details.cartons,
      quantity: details.quantity,
      headingStatus: details.status || picked.headingStatus,
      fieldStatus: details.status || picked.fieldStatus,
    };

    // The genuine portal PDF — captured lazily. If the DOM read is incomplete we
    // must generate it NOW to recover the values; otherwise we only generate it
    // AFTER the values match (spec: "if all values match, generate the PDF").
    let pdf: Awaited<ReturnType<typeof generateBookingPdf>> = null;
    const domIncomplete = !portalValues.grossWeight || !portalValues.cartons || !portalValues.quantity;
    if (domIncomplete) {
      await report("generating-pdf", "Portal details incomplete — generating the booking PDF to read its values");
      pdf = await generateBookingPdf(picked.soNumber);
      if (pdf) {
        try {
          const pdfParseMod = await import("pdf-parse/lib/pdf-parse.js");
          const parsed = await pdfParseMod.default(pdf.buffer);
          const fromPdf = parsePortalPdfText(parsed.text ?? "");
          portalValues = {
            grossWeight: portalValues.grossWeight || fromPdf.grossWeight,
            cartons: portalValues.cartons || fromPdf.cartons,
            quantity: portalValues.quantity || fromPdf.quantity,
            headingStatus: portalValues.headingStatus || fromPdf.headingStatus,
            fieldStatus: portalValues.fieldStatus || fromPdf.fieldStatus,
          };
        } catch {
          // pdf-parse fails on some Damco PDF variants — DOM read is the real source.
        }
      }
    }

    // Compare the three totals against the uploaded packing list.
    const match = matchBooking(
      input.extraction,
      { grossWeight: portalValues.grossWeight, cartons: portalValues.cartons, quantity: portalValues.quantity },
      { grossWeightToleranceKg: tolerance },
    );

    // Spec gate: a non-match never produces a stored Damco PDF. (If we had to
    // generate one above just to read the values, it is discarded here.)
    if (match.outcome !== "MATCHED") {
      return {
        authRequired: false,
        ok: true,
        message: `Portal values did not match: ${match.notes.join("; ") || match.outcome}.`,
        entryUrl,
        poQuery,
        countryQuery,
        candidates,
        pickedBookingNumber: picked.soNumber,
        portalPdf: null,
        portalPdfError: "",
        portalValues,
        match,
      };
    }

    // STEP: Generating PDF — values matched, capture the genuine portal PDF.
    if (!pdf) {
      await report("generating-pdf", `Generating the Damco booking PDF for ${picked.soNumber}`);
      pdf = await generateBookingPdf(picked.soNumber);
    }

    // STEP: Downloading to Backend + Verifying PDF.
    let portalPdfInfo: LivePortalResult["portalPdf"] = null;
    let portalPdfError = "";
    if (pdf) {
      const v = validatePortalPdf(pdf.buffer);
      if (!v.ok) {
        portalPdfError = `Captured response was not a valid PDF (${v.reason}).`;
      } else {
        try {
          await report("downloading", `Writing ${v.bytes} bytes to backend storage`);
          await mkdir(input.storageDir, { recursive: true });
          const path = join(input.storageDir, `${input.docId}.portal.pdf`);
          const tmpPath = `${path}.part`;
          await writeFile(tmpPath, pdf.buffer);
          const sz = await stat(tmpPath);
          if (sz.size !== pdf.buffer.length) {
            await unlink(tmpPath).catch(() => undefined);
            portalPdfError = `Partial write: on-disk size ${sz.size} ≠ buffer ${pdf.buffer.length}.`;
          } else {
            await rename(tmpPath, path).catch(async (e) => {
              await unlink(path).catch(() => undefined);
              await rename(tmpPath, path).catch(() => { throw e; });
            });
            await report("verifying-pdf", `Validated ${v.bytes}-byte, ${v.pages}-page PDF`);
            const sha256 = createHash("sha256").update(pdf.buffer).digest("hex");
            portalPdfInfo = {
              buffer: pdf.buffer,
              filename: pdf.filename,
              sha256,
              path,
              bytes: v.bytes,
              pages: v.pages,
              via: pdf.via,
              sourceUrl: pdf.sourceUrl,
            };
          }
        } catch (e) {
          portalPdfError = `Failed to write portal PDF to storage: ${(e as Error).message}`;
        }
      }
    } else {
      portalPdfError = "Portal did not deliver a PDF (no response-body, no download event, no popup PDF after retries).";
    }

    return {
      authRequired: false,
      // `ok` = live navigation completed (found + opened a booking + values
      // matched). The separate `portalPdf` / `portalPdfError` fields tell the
      // caller whether the PDF capture succeeded; capture failure is reported
      // as DOWNLOAD_FAILED by `batch.ts`, not SEARCH_FAILED.
      ok: true,
      message: portalPdfInfo
        ? `Live portal captured SO ${picked.soNumber}: GW ${portalValues?.grossWeight || "?"} / Ctn ${portalValues?.cartons || "?"} / Qty ${portalValues?.quantity || "?"}; PDF ${portalPdfInfo.bytes} bytes (${portalPdfInfo.pages} pg) via ${portalPdfInfo.via}.`
        : `Live portal reached SO ${picked.soNumber} but PDF capture failed — ${portalPdfError}`,
      entryUrl,
      poQuery,
      countryQuery,
      candidates,
      pickedBookingNumber: picked.soNumber,
      portalPdf: portalPdfInfo,
      portalPdfError,
      portalValues,
      match,
    };
  });
}
