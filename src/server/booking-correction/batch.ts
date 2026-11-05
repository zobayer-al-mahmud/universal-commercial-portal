import { createHash } from "crypto";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { audit } from "@/lib/audit";
import { extractFromPdf, applyManualCorrections, pdfIsReadable } from "./extract";
import { matchBooking } from "./match";
import { validateStatus } from "./status";
import { buildBookingPdf } from "./pdf-writer";
import { rowHash, type PackingRow } from "./excel";
import type { ExtractionResult, BookingState, MatchResult, ExtractedValue, ReviewReason } from "./batch-types";
import type { BookingLiveStep } from "./progress";
import {
  searchDamcoBookings,
  selectBooking,
  type BookingCandidate,
} from "@/server/integrations/damco-portal";
import { runLivePortalForDoc } from "./live-run";
import { detachDamcoBrowser } from "@/server/integrations/damco-browser";
import { runKey, startRun, requestCancel, isRunning, onCancel, cancelInfo, type RunHandle } from "@/server/automation/cancellation";

const MODULE = "booking-correction";
const BOOKING_STOP_REASON = "Stopped by the operator.";
function bookingKey(batchId: string): string {
  return runKey("booking", batchId);
}

/**
 * Record the doc ids the CURRENT run is processing on the batch (DB-backed). The
 * status API returns `runScopeJson` so the progress bar, counters, current-row
 * and log reflect ONLY the rows the user chose to process (Process Selected /
 * Retry / Reprocess) — a 3-row selection must never display as "213/372". It is
 * stored in the DB (not process memory) because the API route and the server
 * action are bundled separately by Next, so a shared in-process map is not seen
 * across them. Pass [] to clear (whole-batch run).
 */
export async function setBookingRunScope(batchId: string, docIds: string[]): Promise<void> {
  const scope = [...new Set(docIds)];
  await prisma.bookingBatch
    .update({ where: { id: batchId }, data: { runScopeJson: scope.length ? JSON.stringify(scope) : null } })
    .catch(() => undefined);
}

export interface UploadFile {
  name: string;
  buffer: Buffer;
}

export interface CreateBatchResult {
  batchId: string;
  accepted: number;
  rejected: { name: string; reason: string }[];
  duplicates: number;
}

function storageDir(batchId: string): string {
  return join(env.STORAGE_ROOT, "booking-correction", batchId);
}

/** Return the anchor Job for a batch's review tickets (created lazily). */
async function batchJobId(batchId: string, actor: string): Promise<string> {
  const businessKey = `batch:${batchId}`;
  const existing = await prisma.job.findFirst({ where: { module: MODULE, businessKey } });
  if (existing) return existing.id;
  const job = await prisma.job.create({
    data: { module: MODULE, type: "booking-batch", businessKey, status: "received", payloadJson: JSON.stringify({ batchId }) },
  });
  await audit({ entityType: "job", entityId: job.id, action: "booking.batch.created", actor, data: { batchId } });
  return job.id;
}

/**
 * Validate + store a batch of uploaded packing-list PDFs and create the batch +
 * per-document rows. Original files are written unchanged to immutable storage.
 * Duplicate files (same sha256, within or across batches) are skipped. Invalid
 * files are rejected with a reason; one bad file never blocks the rest.
 */
export async function createBookingBatch(
  files: UploadFile[],
  opts: { company?: string; buyer?: string; actor?: string } = {},
): Promise<CreateBatchResult> {
  const actor = opts.actor ?? "system";
  const company = (opts.company || env.DAMCO_DEFAULT_COMPANY).trim();
  const buyer = (opts.buyer || env.DAMCO_DEFAULT_BUYER).trim();

  const rejected: { name: string; reason: string }[] = [];
  const maxBytes = env.BOOKING_MAX_FILE_MB * 1024 * 1024;

  const valid: { file: UploadFile; sha256: string }[] = [];
  const seenInBatch = new Set<string>();
  let duplicates = 0;

  for (const f of files) {
    if (!/\.pdf$/i.test(f.name)) {
      rejected.push({ name: f.name, reason: "Not a .pdf file." });
      continue;
    }
    if (f.buffer.length === 0) {
      rejected.push({ name: f.name, reason: "Empty file." });
      continue;
    }
    if (f.buffer.length > maxBytes) {
      rejected.push({ name: f.name, reason: `Exceeds ${env.BOOKING_MAX_FILE_MB} MB limit.` });
      continue;
    }
    // Magic-byte check: a real PDF starts with "%PDF".
    if (f.buffer.subarray(0, 4).toString("latin1") !== "%PDF") {
      rejected.push({ name: f.name, reason: "File is not a valid PDF (missing %PDF header)." });
      continue;
    }
    const sha256 = createHash("sha256").update(f.buffer).digest("hex");
    if (seenInBatch.has(sha256)) {
      duplicates++;
      continue;
    }
    seenInBatch.add(sha256);
    valid.push({ file: f, sha256 });
  }

  if (valid.length === 0) {
    throw new Error(rejected.length ? `No valid PDFs: ${rejected.map((r) => `${r.name} (${r.reason})`).join("; ")}` : "No files supplied.");
  }
  if (env.BOOKING_MAX_FILES > 0 && valid.length > env.BOOKING_MAX_FILES) {
    throw new Error(`This upload has ${valid.length} files, above the configured cap of ${env.BOOKING_MAX_FILES}. Raise BOOKING_MAX_FILES (set 0 for unlimited).`);
  }

  const batch = await prisma.bookingBatch.create({
    data: { createdBy: actor, company, buyer, damcoMode: env.INTEGRATION_MODE, totalDocs: valid.length, status: "uploaded" },
  });

  const dir = storageDir(batch.id);
  await mkdir(dir, { recursive: true });

  let serial = 0;
  for (const { file, sha256 } of valid) {
    serial++;
    const safeName = file.name.replace(/[^\w.\- ]+/g, "_");
    const storagePath = join(dir, `${serial.toString().padStart(3, "0")}__${safeName}`);
    await writeFile(storagePath, file.buffer); // original preserved, never modified
    await prisma.bookingDocument.create({
      data: {
        batchId: batch.id,
        serial,
        originalName: file.name,
        sha256,
        sizeBytes: file.buffer.length,
        storagePath,
        company,
        buyer,
        state: "UPLOADED" satisfies BookingState,
      },
    });
  }

  await batchJobId(batch.id, actor);
  await audit({ entityType: "job", entityId: batch.id, action: "booking.batch.uploaded", actor, data: { accepted: valid.length, rejected: rejected.length, duplicates } });

  return { batchId: batch.id, accepted: valid.length, rejected, duplicates };
}

export interface CreateExcelBatchResult {
  batchId: string;
  accepted: number; // valid rows → processable documents
  invalid: number; // rows with validation errors (created, but held in NEEDS_REVIEW)
  duplicates: number; // identical rows skipped
  rejected: { row: number; reason: string }[];
}

/**
 * Create a batch from the supplied PackingLists workbook (Excel-driven workflow).
 * The workbook is stored once; each non-empty row becomes one BookingDocument
 * carrying the authoritative values (no PDF extraction). Valid rows start in
 * UPLOADED; invalid rows start in NEEDS_REVIEW with the validation problems, so
 * they appear in the editable grid and can be fixed before processing. Identical
 * rows (same content hash) are de-duplicated.
 */
export async function createBookingExcelBatch(
  workbook: { name: string; buffer: Buffer },
  rows: PackingRow[],
  opts: { company?: string; buyer?: string; actor?: string } = {},
): Promise<CreateExcelBatchResult> {
  const actor = opts.actor ?? "system";
  const company = (opts.company || env.DAMCO_DEFAULT_COMPANY).trim();
  const buyer = (opts.buyer || env.DAMCO_DEFAULT_BUYER).trim();

  if (rows.length === 0) throw new Error("No data rows found in the workbook.");
  if (env.BOOKING_MAX_ROWS > 0 && rows.length > env.BOOKING_MAX_ROWS) throw new Error(`This workbook has ${rows.length} rows, above the configured cap of ${env.BOOKING_MAX_ROWS}. Raise BOOKING_MAX_ROWS (set 0 for unlimited).`);

  const sourceSha256 = createHash("sha256").update(workbook.buffer).digest("hex");
  const batch = await prisma.bookingBatch.create({
    data: {
      createdBy: actor, company, buyer, damcoMode: env.INTEGRATION_MODE,
      sourceType: "excel", sourceName: workbook.name, sourceSha256,
      totalDocs: 0, status: "uploaded",
    },
  });

  const dir = storageDir(batch.id);
  await mkdir(dir, { recursive: true });
  const sourcePath = join(dir, "source.xlsx");
  await writeFile(sourcePath, workbook.buffer); // workbook preserved, never modified
  await prisma.bookingBatch.update({ where: { id: batch.id }, data: { sourcePath } });

  let accepted = 0, invalid = 0, duplicates = 0, serial = 0;
  const rejected: { row: number; reason: string }[] = [];
  const seen = new Set<string>();

  for (const r of rows) {
    const hash = rowHash(r);
    if (seen.has(hash)) { duplicates++; continue; }
    seen.add(hash);
    serial++;
    if (r.valid) accepted++;
    else { invalid++; rejected.push({ row: r.rowNo, reason: r.errors.join("; ") }); }
    await prisma.bookingDocument.create({
      data: {
        batchId: batch.id, serial,
        sourceType: "excel", rowNo: r.rowNo,
        originalName: `Row ${r.rowNo} · PO ${r.poNumber || "?"} / ${r.sku || "?"}`,
        sha256: hash, sizeBytes: 0, storagePath: "",
        company, buyer,
        poNumber: r.poNumber, countryCode: r.sku, marketCode: r.sku,
        shipper: r.shipper, frCode: r.frCode,
        extractedGrossWeight: r.grossWeight, extractedCartons: r.cartons, extractedQuantity: r.quantity,
        extractionConfidence: r.valid ? 1 : 0,
        state: (r.valid ? "UPLOADED" : "NEEDS_REVIEW") satisfies BookingState,
        warning: r.valid ? "" : r.errors.join("; "),
      },
    });
  }

  await prisma.bookingBatch.update({ where: { id: batch.id }, data: { totalDocs: accepted + invalid } });
  await batchJobId(batch.id, actor);
  await recomputeBatch(batch.id);
  await audit({ entityType: "job", entityId: batch.id, action: "booking.batch.uploaded", actor, data: { source: "excel", file: workbook.name, accepted, invalid, duplicates, rows: rows.length } });

  return { batchId: batch.id, accepted, invalid, duplicates, rejected };
}

/**
 * Build an ExtractionResult straight from an Excel-sourced document's stored row
 * values (the spreadsheet is the source of truth — no PDF to read). Mirrors the
 * shape `extractFromPdf` produces so the rest of the pipeline is unchanged.
 */
function buildExcelExtraction(doc: {
  poNumber: string; countryCode: string; marketCode: string; shipper: string; frCode: string;
  extractedGrossWeight: string; extractedCartons: string; extractedQuantity: string;
}): ExtractionResult {
  const mk = (v: string, label: string): ExtractedValue | null => (v ? { value: v, normalized: v, label, page: 0, confidence: 1 } : null);
  const reviewReasons: ReviewReason[] = [];
  const grossWeight = mk(doc.extractedGrossWeight, "Excel · Gross weight");
  const cartons = mk(doc.extractedCartons, "Excel · Packages/CARTON");
  const quantity = mk(doc.extractedQuantity, "Excel · Quantity");
  if (!doc.poNumber) reviewReasons.push({ code: "PO_MISSING", reason: "Row has no PO Number.", severity: "hard" });
  if (!doc.countryCode) reviewReasons.push({ code: "SKU_MISSING", reason: "Row has no SKU/Item code (needed for the Damco search).", severity: "hard" });
  if (!grossWeight) reviewReasons.push({ code: "GROSS_WEIGHT_MISSING", reason: "Row has no Gross weight.", severity: "hard" });
  if (!cartons) reviewReasons.push({ code: "CARTONS_MISSING", reason: "Row has no Packages/Cartons.", severity: "hard" });
  if (!quantity) reviewReasons.push({ code: "QUANTITY_MISSING", reason: "Row has no Quantity.", severity: "hard" });
  const complete = !!grossWeight && !!cartons && !!quantity && !!doc.poNumber && !!doc.countryCode && reviewReasons.every((r) => r.severity !== "hard");
  return {
    poNumber: doc.poNumber,
    countryCode: doc.countryCode,
    marketCode: doc.marketCode,
    shipper: doc.shipper,
    frCode: doc.frCode,
    grossWeight, cartons, quantity,
    complete,
    confidence: complete ? 1 : 0,
    reviewReasons,
    pages: 0,
    textChars: 0,
  };
}

async function docEvent(docId: string, stage: string, status: string, message: string, data: Record<string, unknown> = {}) {
  await prisma.bookingDocEvent.create({ data: { docId, stage, status, message, dataJson: JSON.stringify(data) } });
}

async function raiseReview(batchId: string, actor: string, code: string, reason: string, docId: string, serial: number, name: string) {
  const jobId = await batchJobId(batchId, actor);
  await prisma.reviewTicket.create({
    data: { jobId, module: MODULE, reasonCode: code, reason: `Doc #${serial} (${name}): ${reason}`, contextJson: JSON.stringify({ docId, serial }) },
  });
}

/**
 * Process ONE document through the state machine. Idempotent: a document that
 * already COMPLETED is left untouched unless `force` is set (retry). A thrown
 * error is caught and recorded as FAILED so one document never aborts the batch.
 */
export async function processDocument(docId: string, opts: { actor?: string; force?: boolean } = {}): Promise<BookingState> {
  const actor = opts.actor ?? "system";
  const doc = await prisma.bookingDocument.findUnique({ where: { id: docId }, include: { batch: true } });
  if (!doc) throw new Error("Document not found.");
  if (doc.state === "COMPLETED" && !opts.force) return "COMPLETED";

  const setState = async (state: BookingState, patch: Record<string, unknown> = {}) => {
    await prisma.bookingDocument.update({ where: { id: docId }, data: { state, ...patch } });
  };

  try {
    await prisma.bookingDocument.update({ where: { id: docId }, data: { attempts: { increment: 1 }, error: "", warning: "" } });

    // --- EXTRACTING -------------------------------------------------------
    await setState("EXTRACTING");
    let extraction: ExtractionResult;
    if (doc.sourceType === "excel") {
      // Excel-driven: the spreadsheet row carries the authoritative values —
      // there is no PDF to read. Reviewer edits are saved directly onto the row.
      extraction = buildExcelExtraction(doc);
    } else {
      const { readFile } = await import("fs/promises");
      const buffer = await readFile(doc.storagePath);
      extraction = await extractFromPdf(buffer, doc.originalName);

      // Honour reviewer corrections persisted on the document (§5 review flow).
      if (doc.manualCorrected) {
        extraction = applyManualCorrections(extraction, {
          grossWeight: doc.extractedGrossWeight,
          cartons: doc.extractedCartons,
          quantity: doc.extractedQuantity,
          poNumber: doc.poNumber,
          countryCode: doc.countryCode,
        });
      }
    }

    const extractionJson = JSON.stringify({
      grossWeight: extraction.grossWeight,
      cartons: extraction.cartons,
      quantity: extraction.quantity,
      reviewReasons: extraction.reviewReasons,
      textChars: extraction.textChars,
    });
    await prisma.bookingDocument.update({
      where: { id: docId },
      data: {
        poNumber: extraction.poNumber,
        countryCode: extraction.countryCode,
        marketCode: extraction.marketCode,
        extractedGrossWeight: extraction.grossWeight?.normalized ?? "",
        extractedCartons: extraction.cartons?.normalized ?? "",
        extractedQuantity: extraction.quantity?.normalized ?? "",
        extractionJson,
        extractionConfidence: extraction.confidence,
      },
    });
    await docEvent(docId, "extract", extraction.complete ? "ok" : "failed", `PO ${extraction.poNumber || "?"} / ${extraction.countryCode || "?"} · confidence ${(extraction.confidence * 100).toFixed(0)}%`);

    for (const rr of extraction.reviewReasons) {
      if (rr.severity === "hard") await raiseReview(doc.batchId, actor, rr.code, rr.reason, docId, doc.serial, doc.originalName);
    }
    if (!extraction.complete) {
      const hard = extraction.reviewReasons.filter((r) => r.severity === "hard");
      await setState("NEEDS_REVIEW", {
        matchOutcome: "NEEDS_REVIEW",
        warning: hard.map((r) => r.code).join("; ") || "extraction incomplete",
        processedAt: new Date(),
      });
      await recomputeBatch(doc.batchId);
      return "NEEDS_REVIEW";
    }

    // --- READY_TO_SEARCH → PORTAL_SEARCH ---------------------------------
    await setState("READY_TO_SEARCH");
    await setState("PORTAL_SEARCH");

    let booking: BookingCandidate;
    let searchMode: "mock" | "dryrun" | "live" = "mock";
    let entryUrl = "";
    let poQuery = "";
    let countryQuery = "";
    let liveMatch: MatchResult | null = null;

    if (env.INTEGRATION_MODE === "live") {
      // Real visible-browser automation (serialized globally — one at a time per PC).
      await prisma.bookingBatch.update({ where: { id: doc.batchId }, data: { liveStatus: "running", liveStep: "opening-portal", liveDocId: docId, liveStartedAt: new Date(), liveUpdatedAt: new Date(), liveMessage: `Opening Damco portal for PO ${extraction.poNumber}*` } });
      await prisma.bookingDocument.update({ where: { id: docId }, data: { liveStep: "opening-portal" } });
      // Persist each fine-grained live sub-step so the UI progress indicator
      // reflects the real backend state (never a simulated clock).
      const onStep = async (step: BookingLiveStep, detail?: string) => {
        await prisma.bookingDocument.update({ where: { id: docId }, data: { liveStep: step } }).catch(() => undefined);
        await prisma.bookingBatch.update({ where: { id: doc.batchId }, data: { liveStep: step, liveMessage: detail ?? step, liveUpdatedAt: new Date() } }).catch(() => undefined);
        await docEvent(docId, step, "info", detail ?? step).catch(() => undefined);
      };
      const dirLive = storageDir(doc.batchId);
      const live = await runLivePortalForDoc({ batchId: doc.batchId, docId, company: doc.company, buyer: doc.buyer, extraction, storageDir: dirLive, grossWeightToleranceKg: env.BOOKING_GROSS_WEIGHT_TOLERANCE_KG, onStep });
      searchMode = "live";
      entryUrl = live.entryUrl; poQuery = live.poQuery; countryQuery = live.countryQuery;
      await docEvent(docId, "portal-search", live.ok ? "ok" : "failed", live.message, { entryUrl, poQuery, countryQuery, mode: searchMode, candidates: live.candidates.length });
      await prisma.bookingDocument.update({ where: { id: docId }, data: { candidatesJson: JSON.stringify(live.candidates), searchCriteria: `PO ${poQuery} SKU ${countryQuery}`, liveStep: "portal-search" } });

      if (live.authRequired) {
        await setState("PORTAL_AUTH_REQUIRED", { error: live.message, processedAt: new Date() });
        await raiseReview(doc.batchId, actor, "PORTAL_AUTH_REQUIRED", live.message, docId, doc.serial, doc.originalName);
        await prisma.bookingBatch.update({ where: { id: doc.batchId }, data: { liveStatus: "blocked", liveMessage: live.message, liveUpdatedAt: new Date() } });
        await recomputeBatch(doc.batchId);
        return "PORTAL_AUTH_REQUIRED";
      }
      // Genuine search failure (auth OK but no candidates / portal error). The
      // ambiguous and no-unique-match cases come back with ok:true + a non-MATCHED
      // `match` (pickedBookingNumber may be empty) and are handled by the gate below.
      if (!live.ok) {
        await setState("SEARCH_FAILED", { matchOutcome: "SEARCH_FAILED", error: live.message, processedAt: new Date() });
        await raiseReview(doc.batchId, actor, "SEARCH_FAILED", live.message, docId, doc.serial, doc.originalName);
        await prisma.bookingBatch.update({ where: { id: doc.batchId }, data: { liveStatus: "running", liveMessage: live.message, liveUpdatedAt: new Date() } });
        await recomputeBatch(doc.batchId);
        return "SEARCH_FAILED";
      }

      // Spec gate: verify the three values BEFORE a Damco PDF is accepted. The
      // live run already skipped PDF capture on a non-match; record the outcome
      // here (MISMATCH / NEEDS_REVIEW) — a mismatch is never a DOWNLOAD_FAILED.
      if (live.match && live.match.outcome !== "MATCHED") {
        const st: BookingState = live.match.outcome === "MISMATCH" ? "MISMATCH" : "NEEDS_REVIEW";
        await prisma.bookingDocument.update({
          where: { id: docId },
          data: {
            bookingRef: live.pickedBookingNumber,
            bookingGrossWeight: live.portalValues?.grossWeight ?? "",
            bookingCartons: live.portalValues?.cartons ?? "",
            bookingQuantity: live.portalValues?.quantity ?? "",
            matchOutcome: live.match.outcome,
            matchJson: JSON.stringify(live.match),
            liveStep: "verifying-values",
          },
        });
        await docEvent(docId, "match", "failed", `${live.match.outcome}${live.match.notes.length ? " · " + live.match.notes.join("; ") : ""}`);
        await setState(st, { warning: live.match.notes.join("; "), processedAt: new Date() });
        await raiseReview(doc.batchId, actor, live.match.outcome, `SO ${live.pickedBookingNumber}: ${live.match.notes.join("; ") || live.match.outcome}`, docId, doc.serial, doc.originalName);
        await prisma.bookingBatch.update({ where: { id: doc.batchId }, data: { liveStatus: "running", liveMessage: `Values did not match for booking ${live.pickedBookingNumber}.`, liveUpdatedAt: new Date() } });
        await recomputeBatch(doc.batchId);
        return st;
      }

      // Store the genuine portal PDF (never a UCP substitute) + portal-read values.
      const pv = live.portalValues ?? { grossWeight: "", cartons: "", quantity: "", headingStatus: "", fieldStatus: "" };
      await prisma.bookingDocument.update({
        where: { id: docId },
        data: {
          liveStep: live.portalPdf ? "pdf-captured" : "pdf-failed",
          portalPdfPath: live.portalPdf?.path ?? null,
          portalPdfSha256: live.portalPdf?.sha256 ?? "",
          portalValuesJson: JSON.stringify({ ...pv, portalPdfBytes: live.portalPdf?.bytes ?? 0, portalPdfPages: live.portalPdf?.pages ?? 0, portalPdfVia: live.portalPdf?.via ?? "", portalPdfSourceUrl: live.portalPdf?.sourceUrl ?? "" }),
        },
      });
      await docEvent(
        docId,
        "pdf-download",
        live.portalPdf ? "ok" : "failed",
        live.portalPdf
          ? `Captured ${live.portalPdf.bytes} bytes (${live.portalPdf.pages} pg) via ${live.portalPdf.via}; sha256 ${live.portalPdf.sha256.slice(0, 12)}…`
          : live.portalPdfError || "Portal PDF capture failed.",
        { bytes: live.portalPdf?.bytes ?? 0, pages: live.portalPdf?.pages ?? 0, via: live.portalPdf?.via ?? "", sha256: live.portalPdf?.sha256 ?? "" },
      );

      // Fail CLOSED: in live mode, no portal PDF means we never claim COMPLETED.
      // The booking was found, but the portal download step failed — record it
      // as DOWNLOAD_FAILED so the user can retry (the search is cached in
      // candidatesJson and liveStep so retry resumes from here).
      if (!live.portalPdf) {
        await setState("DOWNLOAD_FAILED", { matchOutcome: "", error: live.portalPdfError || "Portal PDF capture failed.", processedAt: new Date(), bookingRef: live.pickedBookingNumber });
        await raiseReview(doc.batchId, actor, "DOWNLOAD_FAILED", live.portalPdfError || "Portal PDF capture failed.", docId, doc.serial, doc.originalName);
        await prisma.bookingBatch.update({ where: { id: doc.batchId }, data: { liveStatus: "running", liveStep: "pdf-failed", liveMessage: live.portalPdfError || "Portal PDF capture failed.", liveUpdatedAt: new Date() } });
        await recomputeBatch(doc.batchId);
        return "DOWNLOAD_FAILED";
      }
      booking = {
        soNumber: live.pickedBookingNumber,
        company: doc.company,
        buyer: doc.buyer,
        poNumber: extraction.poNumber,
        countryCode: extraction.countryCode,
        grossWeight: pv.grossWeight,
        cartons: pv.cartons,
        quantity: pv.quantity,
        headingStatus: pv.headingStatus,
        fieldStatus: pv.fieldStatus,
      };
      liveMatch = live.match; // MATCHED (non-matches returned above)
    } else {
      const search = await searchDamcoBookings({ company: doc.company, buyer: doc.buyer, extraction });
      searchMode = search.mode;
      entryUrl = search.entryUrl; poQuery = search.poQuery; countryQuery = search.countryQuery;
      await docEvent(docId, "portal-search", search.ok ? "ok" : "failed", search.message, { entryUrl, poQuery, countryQuery, mode: searchMode });

      if (search.authRequired) {
        await setState("PORTAL_AUTH_REQUIRED", { error: search.message, processedAt: new Date() });
        await raiseReview(doc.batchId, actor, "PORTAL_AUTH_REQUIRED", search.message, docId, doc.serial, doc.originalName);
        await recomputeBatch(doc.batchId);
        return "PORTAL_AUTH_REQUIRED";
      }
      if (!search.ok) {
        await setState("SEARCH_FAILED", { matchOutcome: "SEARCH_FAILED", error: search.message, processedAt: new Date() });
        await raiseReview(doc.batchId, actor, "SEARCH_FAILED", search.message, docId, doc.serial, doc.originalName);
        await recomputeBatch(doc.batchId);
        return "SEARCH_FAILED";
      }
      if (search.candidates.length === 0) {
        await setState("SEARCH_FAILED", { matchOutcome: "SEARCH_FAILED", error: `No booking found for PO ${extraction.poNumber}.`, candidatesJson: "[]", processedAt: new Date() });
        await raiseReview(doc.batchId, actor, "NO_BOOKING_FOUND", `No booking found for PO ${extraction.poNumber}* / country ${extraction.countryCode}*.`, docId, doc.serial, doc.originalName);
        await recomputeBatch(doc.batchId);
        return "SEARCH_FAILED";
      }

      const picked = selectBooking(search.candidates, { company: doc.company, buyer: doc.buyer, extraction });
      await prisma.bookingDocument.update({ where: { id: docId }, data: { candidatesJson: JSON.stringify(search.candidates) } });
      if (!picked.booking || picked.ambiguous) {
        await setState("NEEDS_REVIEW", { matchOutcome: "NEEDS_REVIEW", warning: picked.reason, bookingRef: picked.booking?.soNumber ?? "", processedAt: new Date() });
        await raiseReview(doc.batchId, actor, "BOOKING_AMBIGUOUS", picked.reason, docId, doc.serial, doc.originalName);
        await recomputeBatch(doc.batchId);
        return "NEEDS_REVIEW";
      }
      booking = picked.booking;
    }

    // --- BOOKING_MATCHING -------------------------------------------------
    await setState("BOOKING_MATCHING", {
      bookingRef: booking.soNumber,
      bookingGrossWeight: booking.grossWeight,
      bookingCartons: booking.cartons,
      bookingQuantity: booking.quantity,
    });
    // Live mode already computed the match on the portal-read values; reuse it
    // so the stored result matches what gated the PDF. Mock mode matches here.
    const match = liveMatch ?? matchBooking(extraction, { grossWeight: booking.grossWeight, cartons: booking.cartons, quantity: booking.quantity, poNumber: booking.poNumber, sku: booking.countryCode }, { grossWeightToleranceKg: env.BOOKING_GROSS_WEIGHT_TOLERANCE_KG });
    await prisma.bookingDocument.update({ where: { id: docId }, data: { matchOutcome: match.outcome, matchJson: JSON.stringify(match) } });
    await docEvent(docId, "match", match.outcome === "MATCHED" ? "ok" : "failed", `${match.outcome}${match.notes.length ? " · " + match.notes.join("; ") : ""}`);

    if (match.outcome !== "MATCHED") {
      const state: BookingState = match.outcome === "MISMATCH" ? "MISMATCH" : "NEEDS_REVIEW";
      await setState(state, { warning: match.notes.join("; "), processedAt: new Date() });
      await raiseReview(doc.batchId, actor, match.outcome, `SO ${booking.soNumber}: ${match.notes.join("; ") || match.outcome}`, docId, doc.serial, doc.originalName);
      await recomputeBatch(doc.batchId);
      return state;
    }

    // --- PDF_GENERATING ---------------------------------------------------
    // Only a MATCHED document proceeds to the successful PDF workflow (§9).
    await setState("PDF_GENERATING");
    const status = validateStatus(booking.headingStatus, booking.fieldStatus);
    const pdf = buildBookingPdf({
      title: `BOOKING ${status.headingStatus}`,
      lines: [
        `SO Number: ${booking.soNumber}`,
        `Company: ${booking.company}`,
        `Buyer: ${booking.buyer}`,
        `PO Number: ${booking.poNumber}`,
        `Country: ${booking.countryCode}`,
        `Gross Weight: ${booking.grossWeight} kg`,
        `Total Cartons: ${booking.cartons}`,
        `Total Quantity: ${booking.quantity}`,
        `Booking Status: ${status.fieldStatus}`,
      ],
      footer: `Generated by UCP Booking Correction · mode=${searchMode} · ${new Date().toISOString()}`,
    });
    const dir = storageDir(doc.batchId);
    await mkdir(dir, { recursive: true });
    const generatedPdfPath = join(dir, `${doc.id}.generated.pdf`);
    await writeFile(generatedPdfPath, pdf);

    // Re-validate the generated PDF: it must be a valid, readable PDF (§10).
    // Where text is extractable, confirm the expected status appears in it.
    const check = await pdfIsReadable(pdf);
    const textOk = check.text.length === 0 || check.text.toUpperCase().includes(status.headingStatus);
    const readable = check.ok && textOk;
    await docEvent(docId, "pdf-generate", readable ? "ok" : "failed", readable ? `Generated + re-validated (${pdf.length} bytes, ${check.pages} page)` : "Generated PDF failed validation");
    if (!readable) {
      await setState("DOWNLOAD_FAILED", { generatedPdfPath, error: "Generated PDF failed re-validation.", processedAt: new Date() });
      await raiseReview(doc.batchId, actor, "DOWNLOAD_FAILED", "Generated PDF failed re-validation.", docId, doc.serial, doc.originalName);
      await recomputeBatch(doc.batchId);
      return "DOWNLOAD_FAILED";
    }

    // --- STATUS_VALIDATION → COMPLETED -----------------------------------
    await setState("STATUS_VALIDATION", { generatedPdfPath, headingStatus: status.headingStatus, fieldStatus: status.fieldStatus, finalStatus: status.finalStatus });
    await docEvent(docId, "status-validate", status.finalStatus === "CONFIRMED" ? "ok" : "failed", status.message);

    if (status.finalStatus === "CONFIRMED" || status.finalStatus === "DELIVERED") {
      await setState("COMPLETED", { processedAt: new Date() });
      await recomputeBatch(doc.batchId);
      await audit({ entityType: "job", entityId: doc.batchId, action: "booking.document.completed", actor, data: { docId, so: booking.soNumber, finalStatus: status.finalStatus } });
      return "COMPLETED";
    }
    // REQUESTED / STATUS_MISMATCH / NEEDS_REVIEW — never reported as confirmed.
    const state: BookingState = status.finalStatus === "REQUESTED" ? "PORTAL_AUTH_REQUIRED" : status.finalStatus === "STATUS_MISMATCH" ? "STATUS_MISMATCH" : "NEEDS_REVIEW";
    await setState(state, { warning: status.message, processedAt: new Date() });
    await raiseReview(doc.batchId, actor, status.finalStatus, `SO ${booking.soNumber}: ${status.message}`, docId, doc.serial, doc.originalName);
    await recomputeBatch(doc.batchId);
    return state;
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown processing error.";
    await prisma.bookingDocument.update({ where: { id: docId }, data: { state: "FAILED", error: message, processedAt: new Date() } });
    await docEvent(docId, "error", "failed", message);
    await recomputeBatch(doc.batchId);
    return "FAILED";
  }
}

const SUCCESS_STATES: BookingState[] = ["COMPLETED"];
const REVIEW_STATES: BookingState[] = ["NEEDS_REVIEW", "MISMATCH", "STATUS_MISMATCH", "PORTAL_AUTH_REQUIRED"];
const FAIL_STATES: BookingState[] = ["SEARCH_FAILED", "DOWNLOAD_FAILED", "FAILED"];

/** Documents actively mid-pipeline (a run is working on them). UPLOADED is NOT
 *  here — it is "pending / not started" and must never read as "processing". */
const ACTIVE_STATES: BookingState[] = ["EXTRACTING", "READY_TO_SEARCH", "PORTAL_SEARCH", "BOOKING_MATCHING", "PDF_GENERATING", "STATUS_VALIDATION"];

/** Recompute batch-level counters + status from its documents. */
export async function recomputeBatch(batchId: string): Promise<void> {
  const docs = await prisma.bookingDocument.findMany({ where: { batchId }, select: { state: true } });
  const completed = docs.filter((d) => SUCCESS_STATES.includes(d.state as BookingState)).length;
  const review = docs.filter((d) => REVIEW_STATES.includes(d.state as BookingState)).length;
  const failed = docs.filter((d) => FAIL_STATES.includes(d.state as BookingState)).length;
  const active = docs.filter((d) => ACTIVE_STATES.includes(d.state as BookingState)).length;
  const pending = docs.length - completed - review - failed - active; // UPLOADED, not yet started
  // "processing" ONLY while something is actively mid-pipeline — a finished run
  // that left pending UPLOADED rows is NOT "processing" (it is "partial"), so the
  // status badge and Recent-batches list stop showing "Processing" after the run.
  let status: string;
  if (active > 0) status = "processing";
  else if (pending === 0) status = failed + review === 0 ? "completed" : completed > 0 ? "partial" : "failed";
  // Idle with rows still pending: "partial" once a run has produced any result
  // (completed or failed), else "uploaded" (nothing processed yet — review rows
  // here are just invalid-on-upload data awaiting correction).
  else status = completed > 0 || failed > 0 ? "partial" : "uploaded";
  await prisma.bookingBatch.update({ where: { id: batchId }, data: { completedDocs: completed, reviewDocs: review, failedDocs: failed, status } });
}

/**
 * Drain a queue of document ids with bounded concurrency, honouring a Stop:
 * workers start no new document once the run is cancelled, and the run finalizes
 * (batch parked as stopped) instead of being reported as finished. Shared by
 * Process Selected and Process All.
 */
async function drainDocuments(batchId: string, queue: string[], opts: { actor: string; force?: boolean }): Promise<boolean> {
  const run = startRun(bookingKey(batchId));
  // A Stop closes the visible Damco browser so an in-flight portal step throws
  // at once instead of running to its navigation timeout.
  onCancel(bookingKey(batchId), () => { void detachDamcoBrowser().catch(() => undefined); });
  // Record exactly which docs THIS run processes, so the UI progress/counters show
  // only them (Process Selected of 3 rows must read "0/3 → 3/3", never "/372").
  await setBookingRunScope(batchId, queue);
  const limit = env.INTEGRATION_MODE === "live" ? 1 : Math.max(1, env.BOOKING_CONCURRENCY);
  let cursor = 0;
  async function worker() {
    while (cursor < queue.length) {
      if (run.signal.aborted) break; // Stop requested → start no more documents.
      const id = queue[cursor++];
      await processDocument(id, { actor: opts.actor, force: opts.force });
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, worker));
  } finally {
    run.end();
  }
  const aborted = run.signal.aborted;
  await recomputeBatch(batchId);
  if (aborted) {
    await finalizeBookingStop(batchId, opts.actor);
  } else if (env.INTEGRATION_MODE === "live") {
    await prisma.bookingBatch.update({ where: { id: batchId }, data: { liveStatus: "finished", liveStep: "", liveMessage: "Run finished.", liveUpdatedAt: new Date() } }).catch(() => undefined);
  }
  return aborted;
}

/** Run a specific subset of documents (Process Selected) with bounded concurrency. */
export async function processSelected(batchId: string, docIds: string[], opts: { actor?: string; force?: boolean } = {}): Promise<void> {
  const actor = opts.actor ?? "system";
  if (docIds.length === 0) return;
  await prisma.bookingBatch.update({ where: { id: batchId }, data: { status: "processing" } });
  const docs = await prisma.bookingDocument.findMany({ where: { batchId, id: { in: docIds } }, orderBy: { serial: "asc" } });
  const queue = docs.filter((d) => opts.force || !SUCCESS_STATES.includes(d.state as BookingState)).map((d) => d.id);
  const aborted = await drainDocuments(batchId, queue, { actor, force: opts.force });
  await audit({ entityType: "job", entityId: batchId, action: aborted ? "booking.batch.stopped" : "booking.batch.processed", actor, data: { docs: queue.length, selected: docIds.length, mode: env.INTEGRATION_MODE } });
}

/** Run every not-yet-successful document in a batch with bounded concurrency. */
export async function processBatch(batchId: string, opts: { actor?: string; force?: boolean } = {}): Promise<void> {
  const actor = opts.actor ?? "system";
  await prisma.bookingBatch.update({ where: { id: batchId }, data: { status: "processing" } });
  const docs = await prisma.bookingDocument.findMany({ where: { batchId }, orderBy: { serial: "asc" } });
  const queue = docs.filter((d) => opts.force || !SUCCESS_STATES.includes(d.state as BookingState)).map((d) => d.id);
  const aborted = await drainDocuments(batchId, queue, { actor, force: opts.force });
  await audit({ entityType: "job", entityId: batchId, action: aborted ? "booking.batch.stopped" : "booking.batch.processed", actor, data: { docs: queue.length, mode: env.INTEGRATION_MODE } });
}

/**
 * Reconcile DB state after a Stop. Completed documents + their PDFs are kept.
 * The document that was in flight when the browser was closed (the live run's
 * `liveDocId`, if still non-terminal) is recorded as Stopped — never Completed —
 * and remains retryable; documents not yet started stay in their pre-run state
 * (resumable by Process All / Process Selected). The batch is parked as stopped.
 * Idempotent.
 */
async function finalizeBookingStop(batchId: string, actor: string): Promise<void> {
  const batch = await prisma.bookingBatch.findUnique({ where: { id: batchId } });
  const inFlightId = batch?.liveDocId || "";
  if (inFlightId) {
    const doc = await prisma.bookingDocument.findUnique({ where: { id: inFlightId } });
    if (doc && !SUCCESS_STATES.includes(doc.state as BookingState)) {
      await prisma.bookingDocument.update({ where: { id: inFlightId }, data: { state: "FAILED", liveStep: "", error: BOOKING_STOP_REASON, warning: BOOKING_STOP_REASON, processedAt: new Date() } }).catch(() => undefined);
      await prisma.bookingDocEvent.create({ data: { docId: inFlightId, stage: "stopped", status: "failed", message: BOOKING_STOP_REASON, dataJson: "{}" } }).catch(() => undefined);
    }
  }
  await recomputeBatch(batchId);
  // Only park as stopped when work actually remains; a batch that finished at the
  // instant Stop landed keeps its real completed/partial verdict from recompute.
  const remaining = await prisma.bookingDocument.count({ where: { batchId, state: { notIn: ["COMPLETED", "MISMATCH", "STATUS_MISMATCH", "SEARCH_FAILED", "DOWNLOAD_FAILED", "FAILED", "NEEDS_REVIEW", "PORTAL_AUTH_REQUIRED"] } } });
  if (remaining > 0) {
    await prisma.bookingBatch.update({ where: { id: batchId }, data: { status: "stopped", liveStatus: "stopped", liveStep: "", liveDocId: null, liveMessage: BOOKING_STOP_REASON, liveUpdatedAt: new Date() } }).catch(() => undefined);
  } else {
    await prisma.bookingBatch.update({ where: { id: batchId }, data: { liveStatus: "finished", liveStep: "", liveDocId: null, liveMessage: BOOKING_STOP_REASON, liveUpdatedAt: new Date() } }).catch(() => undefined);
  }
}

/**
 * Request that a running booking batch stop. Flips the shared cancel flag (which
 * closes the Damco browser so an in-flight portal step throws at once), records
 * the reason, and — if no loop is attached in this process — reconciles the DB
 * directly. Completed documents and their PDFs are never touched.
 */
export async function requestStopBookingBatch(batchId: string, actor: string): Promise<{ ok: boolean; message: string }> {
  const batch = await prisma.bookingBatch.findUnique({ where: { id: batchId } });
  if (!batch) return { ok: false, message: "Batch not found." };
  const key = bookingKey(batchId);
  const live = isRunning(key);
  requestCancel(key, BOOKING_STOP_REASON);
  await prisma.bookingBatch.update({ where: { id: batchId }, data: { status: "stopping", liveMessage: "Stopping…", liveUpdatedAt: new Date() } }).catch(() => undefined);
  const info = cancelInfo(key);
  await audit({ entityType: "job", entityId: batchId, action: "booking.batch.stop-requested", actor, data: { reason: info?.reason ?? BOOKING_STOP_REASON, at: (info?.at ?? new Date()).toISOString(), liveLoop: live } });
  if (!live) await finalizeBookingStop(batchId, actor);
  return { ok: true, message: "Stop requested." };
}
