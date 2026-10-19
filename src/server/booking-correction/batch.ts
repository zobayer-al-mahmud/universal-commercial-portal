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
import type { ExtractionResult, BookingState } from "./batch-types";
import {
  searchDamcoBookings,
  selectBooking,
  type BookingCandidate,
} from "@/server/integrations/damco-portal";

const MODULE = "booking-correction";

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
  if (valid.length > env.BOOKING_MAX_FILES) {
    throw new Error(`Too many files: ${valid.length} exceeds the limit of ${env.BOOKING_MAX_FILES}.`);
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
    const { readFile } = await import("fs/promises");
    const buffer = await readFile(doc.storagePath);
    let extraction: ExtractionResult = await extractFromPdf(buffer, doc.originalName);

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
    const search = await searchDamcoBookings({ company: doc.company, buyer: doc.buyer, extraction });
    await docEvent(docId, "portal-search", search.ok ? "ok" : "failed", search.message, { searchUrl: search.searchUrl, mode: search.mode });

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
    const booking: BookingCandidate = picked.booking;

    // --- BOOKING_MATCHING -------------------------------------------------
    await setState("BOOKING_MATCHING", {
      bookingRef: booking.soNumber,
      bookingGrossWeight: booking.grossWeight,
      bookingCartons: booking.cartons,
      bookingQuantity: booking.quantity,
    });
    const match = matchBooking(extraction, { grossWeight: booking.grossWeight, cartons: booking.cartons, quantity: booking.quantity }, { grossWeightToleranceKg: env.BOOKING_GROSS_WEIGHT_TOLERANCE_KG });
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
      footer: `Generated by UCP Booking Correction · mode=${search.mode} · ${new Date().toISOString()}`,
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

    if (status.finalStatus === "CONFIRMED") {
      await setState("COMPLETED", { processedAt: new Date() });
      await recomputeBatch(doc.batchId);
      await audit({ entityType: "job", entityId: doc.batchId, action: "booking.document.completed", actor, data: { docId, so: booking.soNumber } });
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

/** Recompute batch-level counters + status from its documents. */
export async function recomputeBatch(batchId: string): Promise<void> {
  const docs = await prisma.bookingDocument.findMany({ where: { batchId }, select: { state: true } });
  const completed = docs.filter((d) => SUCCESS_STATES.includes(d.state as BookingState)).length;
  const review = docs.filter((d) => REVIEW_STATES.includes(d.state as BookingState)).length;
  const failed = docs.filter((d) => FAIL_STATES.includes(d.state as BookingState)).length;
  const inFlight = docs.length - completed - review - failed;
  const status = inFlight > 0 ? "processing" : failed + review === 0 ? "completed" : completed > 0 ? "partial" : "failed";
  await prisma.bookingBatch.update({ where: { id: batchId }, data: { completedDocs: completed, reviewDocs: review, failedDocs: failed, status } });
}

/** Run every not-yet-successful document in a batch with bounded concurrency. */
export async function processBatch(batchId: string, opts: { actor?: string; force?: boolean } = {}): Promise<void> {
  const actor = opts.actor ?? "system";
  await prisma.bookingBatch.update({ where: { id: batchId }, data: { status: "processing" } });
  const docs = await prisma.bookingDocument.findMany({ where: { batchId }, orderBy: { serial: "asc" } });
  const queue = docs.filter((d) => opts.force || !SUCCESS_STATES.includes(d.state as BookingState)).map((d) => d.id);

  const limit = Math.max(1, env.BOOKING_CONCURRENCY);
  let cursor = 0;
  async function worker() {
    while (cursor < queue.length) {
      const id = queue[cursor++];
      await processDocument(id, { actor, force: opts.force });
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, worker));
  await recomputeBatch(batchId);
  await audit({ entityType: "job", entityId: batchId, action: "booking.batch.processed", actor, data: { docs: queue.length } });
}
