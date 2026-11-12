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
  type BookingDetailValues,
} from "@/server/integrations/damco-live";
import { parseCtnsQtyTable, normalizeNumber } from "./extract";
import { normalizeStatus } from "./status";
import { matchBooking } from "./match";
import { selectBooking } from "./select-booking";
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
    // Scope grid results to this batch's trading entity in code (grid rows carry
    // shipper + consignee). We no longer pre-select the shipper dropdown, whose
    // onchange reloads the page and broke Booking-tab activation. Match the FULL
    // company/buyer name (whitespace-flexible) so the shipper filter still tells
    // GARMENTS from SPORTSWEAR; liveSearchBookings fails open (keeps all rows) if
    // a format difference means nothing matches, so a too-strict pattern never
    // produces a false "no booking".
    const nameMatch = (s: string): RegExp | undefined => {
      const t = (s || "").trim();
      if (!t) return undefined;
      const pat = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
      return new RegExp(pat, "i");
    };
    const search = await liveSearchBookings({
      poNumber: input.extraction.poNumber,
      countryCode: input.extraction.countryCode,
      companyMatch: nameMatch(input.company),
      buyerMatch: nameMatch(input.buyer),
    });
    if (search.authRequired) {
      return { authRequired: true, ok: false, message: search.message, ...emptyNav };
    }
    if (!search.ok || search.bookings.length === 0) {
      return { authRequired: false, ok: false, message: search.message || "No booking found.", ...emptyNav };
    }
    const candidates: BookingCandidate[] = search.bookings.map((b) =>
      toCandidate(b, { company: input.company, buyer: input.buyer, poNumber: input.extraction.poNumber, countryCode: input.extraction.countryCode }),
    );

    // STEP: Opening Booking Details — inspect EVERY candidate (spec §2). We never
    // pick candidates[0] blindly: each booking's Details tab is opened and the
    // relevant fields (GW/Cartons/Qty + PO/SKU/FR) are read and matched against
    // the Excel row. Only a UNIQUE full match is selected; 0 or ≥2 → flagged for
    // manual review (never an arbitrary pick). Shipper is not a match criterion.
    await report("opening-detail", `Inspecting ${candidates.length} candidate booking(s)`);

    interface Inspected {
      cand: BookingCandidate;
      values: NonNullable<LivePortalResult["portalValues"]>;
      details: BookingDetailValues | null;
      match: MatchResult | null;
      pdf: PortalPdfCapture | null; // cached if we had to generate it to read values
    }
    const inspected: Inspected[] = [];
    const IDENTITY_FIELDS: string[] = ["poNumber", "sku", "frCode"];
    const identityConflicts = (m: MatchResult | null): boolean =>
      !!m && m.comparisons.some((c) => IDENTITY_FIELDS.includes(c.field) && !c.match);
    // Uppercase-alphanumeric core (same rule selectBooking uses). When the row
    // carries an FR, only an FR-matching candidate can ever be selected, so a
    // non-matching candidate's totals are irrelevant — we skip generating its
    // booking PDF (a slow, timeout-capped race) just to recover them. Selection
    // still runs on the real FR read, so this never changes which booking wins.
    const core = (v: string | undefined): string => String(v ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    const rowFr = core(input.extraction.frCode);

    for (const cand of candidates) {
      // Open each candidate by DIRECT URL (search.shipperId) so EVERY candidate is
      // inspected, not just the first — the results-grid link is gone once we have
      // navigated into any candidate's detail.
      const opened = await openBookingDetail(cand.soNumber, search.shipperId);
      if (!opened) {
        inspected.push({ cand, values: { grossWeight: "", cartons: "", quantity: "", headingStatus: cand.headingStatus, fieldStatus: cand.fieldStatus }, details: null, match: null, pdf: null });
        continue;
      }
      await report("verifying-values", `Reading portal values for ${cand.soNumber}`);
      const details = await readBookingDetails().catch(() => null);
      const values: Inspected["values"] = {
        grossWeight: details?.grossWeight ?? "",
        cartons: details?.cartons ?? "",
        quantity: details?.quantity ?? "",
        headingStatus: details?.status || cand.headingStatus,
        fieldStatus: details?.status || cand.fieldStatus,
      };

      // If the Details DOM read is incomplete, recover the totals from the genuine
      // portal PDF (cached so the chosen candidate reuses it rather than re-downloading).
      // Skip this for a candidate the row's FR already rules out — its totals can
      // never make it the selected booking, so the PDF round-trip is pure waste.
      const couldBeSelected = !rowFr || core(details?.frCode) === rowFr;
      let pdf: PortalPdfCapture | null = null;
      if (couldBeSelected && (!values.grossWeight || !values.cartons || !values.quantity)) {
        await report("generating-pdf", `Portal details incomplete for ${cand.soNumber} — reading its booking PDF`);
        pdf = await generateBookingPdf(cand.soNumber);
        if (pdf) {
          try {
            const pdfParseMod = await import("pdf-parse/lib/pdf-parse.js");
            const parsed = await pdfParseMod.default(pdf.buffer);
            const fromPdf = parsePortalPdfText(parsed.text ?? "");
            values.grossWeight = values.grossWeight || fromPdf.grossWeight;
            values.cartons = values.cartons || fromPdf.cartons;
            values.quantity = values.quantity || fromPdf.quantity;
            values.headingStatus = values.headingStatus || fromPdf.headingStatus;
            values.fieldStatus = values.fieldStatus || fromPdf.fieldStatus;
          } catch { /* DOM read is the real source; PDF text parse is best-effort */ }
        }
      }

      // Enrich the candidate record (for the UI) with what the portal showed.
      cand.grossWeight = values.grossWeight;
      cand.cartons = values.cartons;
      cand.quantity = values.quantity;
      cand.headingStatus = values.headingStatus;
      cand.fieldStatus = values.fieldStatus;

      const m = matchBooking(
        input.extraction,
        {
          grossWeight: values.grossWeight,
          cartons: values.cartons,
          quantity: values.quantity,
          poNumber: details?.poNumber,
          sku: details?.sku,
          frCode: details?.frCode,
        },
        { grossWeightToleranceKg: tolerance },
      );
      inspected.push({ cand, values, details, match: m, pdf });
    }

    // --- Select the correct booking (§2/§9) --------------------------------
    // FR is the decisive disambiguator when the packing-list row carries one:
    // of all candidates whose Damco Details FR equals the row's FR, exactly one
    // is the correct booking. We read every candidate's FR above; here we pick
    // by FR first, and the totals (already compared in `matchBooking`) then
    // decide the final state (COMPLETED vs flag-for-Damco-correction). Without
    // an FR on the row (legacy PDF path) we fall back to totals + PO/SKU.
    const selection = selectBooking(
      inspected.map((i) => ({
        frCode: i.details?.frCode,
        matched: i.match?.outcome === "MATCHED",
        identityOk: !identityConflicts(i.match),
      })),
      input.extraction.frCode ?? "",
    );
    const frList = inspected.map((i) => `${i.cand.soNumber}→FR ${i.details?.frCode || "?"}`).join("; ");
    const basisLabel = (b: "fr" | "totals") => (b === "fr" ? `FR ${input.extraction.frCode}` : "PO/SKU + totals");

    // The row carried an FR but no candidate matched it → never guess by totals.
    if (selection.kind === "no-fr-candidate") {
      return {
        authRequired: false, ok: true,
        message: `No candidate booking's FR matched the packing-list FR ${input.extraction.frCode} (checked ${inspected.length}: ${frList}); manual review required.`,
        entryUrl, poQuery, countryQuery, candidates, pickedBookingNumber: "",
        portalPdf: null, portalPdfError: "", portalValues: inspected[0]?.values ?? null,
        match: { outcome: "NEEDS_REVIEW", comparisons: inspected.find((i) => i.match)?.match?.comparisons ?? [], notes: [`None of the ${candidates.length} candidate booking(s) had FR ${input.extraction.frCode}. FR by candidate: ${frList}.`] },
      };
    }

    // ≥2 candidates indistinguishable on the basis → ambiguous; never pick blindly.
    if (selection.kind === "ambiguous") {
      const picks = selection.indices.map((idx) => inspected[idx]);
      const nums = picks.map((p) => p.cand.soNumber).join(", ");
      return {
        authRequired: false, ok: true,
        message: `Ambiguous: ${picks.length} bookings (${nums}) match the packing-list row on ${basisLabel(selection.basis)}; manual review required.`,
        entryUrl, poQuery, countryQuery, candidates, pickedBookingNumber: "",
        portalPdf: null, portalPdfError: "", portalValues: null,
        match: { outcome: "NEEDS_REVIEW", comparisons: picks[0].match?.comparisons ?? [], notes: [`${picks.length} candidate bookings (${nums}) matched on ${basisLabel(selection.basis)} — UCP will not choose arbitrarily. Resolve in the portal and re-process.`] },
      };
    }

    // No FR on the row; identity matched a candidate but a total differs → flag it
    // (right booking, wrong totals) so the reviewer corrects it on Damco.
    if (selection.kind === "wrong-totals") {
      const wt = inspected[selection.index];
      return {
        authRequired: false, ok: true,
        message: `Booking ${wt.cand.soNumber} matches the Excel row's identity but a value differs: ${wt.match!.notes.join("; ")}. Correct it on Damco, then re-verify.`,
        entryUrl, poQuery, countryQuery, candidates, pickedBookingNumber: wt.cand.soNumber,
        portalPdf: null, portalPdfError: "", portalValues: wt.values, match: wt.match,
      };
    }

    // Nothing matched at all (no FR on the row, no totals/identity agreement).
    if (selection.kind === "none") {
      return {
        authRequired: false, ok: true,
        message: `No candidate booking matched the Excel row (PO ${poQuery}, SKU ${countryQuery}); manual review required.`,
        entryUrl, poQuery, countryQuery, candidates, pickedBookingNumber: "",
        portalPdf: null, portalPdfError: "", portalValues: inspected[0]?.values ?? null,
        match: { outcome: "NEEDS_REVIEW", comparisons: inspected[0]?.match?.comparisons ?? [], notes: [`None of the ${candidates.length} candidate booking(s) matched on PO/SKU/FR + totals.`] },
      };
    }

    // selection.kind === "selected": FR (or totals, when no FR) identified exactly
    // one booking. The totals now decide its final state.
    const chosen = inspected[selection.index];
    const picked = chosen.cand;
    const portalValues: LivePortalResult["portalValues"] = chosen.values;
    const match = chosen.match!;

    // Right booking (selected by FR) but a total differs → select it and surface
    // the diff so the reviewer corrects it on Damco (never auto-confirmed).
    if (match.outcome !== "MATCHED") {
      return {
        authRequired: false, ok: true,
        message: `Booking ${picked.soNumber} was selected on ${basisLabel(selection.basis)} but a value differs: ${match.notes.join("; ")}. Correct it on Damco, then re-verify.`,
        entryUrl, poQuery, countryQuery, candidates, pickedBookingNumber: picked.soNumber,
        portalPdf: null, portalPdfError: "", portalValues, match,
      };
    }

    // STEP: Generating PDF. If the chosen candidate's PDF was already captured
    // while inspecting it (its DOM totals were incomplete), reuse that exact
    // document — no need to re-open the booking and re-generate. Only when it was
    // not captured do we re-open the chosen booking (we navigated through the
    // other candidates) and generate it now.
    let pdf: Awaited<ReturnType<typeof generateBookingPdf>> = chosen.pdf;
    if (!pdf) {
      await report("opening-detail", `Opening matched booking ${picked.soNumber}`);
      await openBookingDetail(picked.soNumber);
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
