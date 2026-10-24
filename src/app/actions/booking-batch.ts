"use server";

import { revalidatePath } from "next/cache";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { normalizeNumber } from "@/server/booking-correction/extract";
import {
  createBookingBatch,
  processBatch,
  processDocument,
} from "@/server/booking-correction/batch";
import { writeCorrectedPdf, type CorrectedPdfValues } from "@/server/booking-correction/corrected-pdf";
import { env } from "@/lib/env";
import { createHash } from "crypto";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { liveSearchBookings, openBookingDetail, generateBookingPdf } from "@/server/integrations/damco-live";
import { serializeLiveRun, parsePortalPdfText } from "@/server/booking-correction/live-run";
import { normalizeStatus } from "@/server/booking-correction/status";

export interface UploadState {
  error?: string;
  batchId?: string;
  accepted?: number;
  duplicates?: number;
  rejected?: { name: string; reason: string }[];
}

/** Multi-PDF batch upload → store → process (bounded concurrency). */
export async function uploadBookingBatchAction(_prev: UploadState, formData: FormData): Promise<UploadState> {
  const user = await getSessionUser();
  if (!user) return { error: "Not authenticated." };
  if (!userHasPermission(user, PERMISSIONS.JOB_CREATE)) return { error: "You do not have permission to create jobs." };

  const entries = formData.getAll("files").filter((e): e is File => e instanceof File && e.size >= 0 && e.name !== "");
  if (entries.length === 0) return { error: "Select at least one PDF." };

  const company = String(formData.get("company") ?? "").trim() || undefined;
  const buyer = String(formData.get("buyer") ?? "").trim() || undefined;

  try {
    const files = await Promise.all(entries.map(async (f) => ({ name: f.name, buffer: Buffer.from(await f.arrayBuffer()) })));
    const res = await createBookingBatch(files, { company, buyer, actor: user.email });
    // Auto-start processing in the BACKGROUND so the batch page's live progress
    // indicator can poll real state while the (possibly long) live run proceeds.
    void processBatch(res.batchId, { actor: user.email }).catch((e) => console.error("[booking] background processing failed", e));
    revalidatePath("/modules/booking-correction");
    revalidatePath(`/booking/${res.batchId}`);
    revalidatePath("/jobs");
    revalidatePath("/dashboard");
    return { batchId: res.batchId, accepted: res.accepted, duplicates: res.duplicates, rejected: res.rejected };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Upload failed." };
  }
}

/** Retry a single document independently (§4). */
export async function retryBookingDocAction(formData: FormData): Promise<void> {
  const user = await getSessionUser();
  if (!user || !userHasPermission(user, PERMISSIONS.JOB_RETRY)) return;
  const docId = String(formData.get("docId") ?? "");
  const batchId = String(formData.get("batchId") ?? "");
  if (!docId) return;
  // Reset the live step so the indicator restarts cleanly, then run in the background.
  await prisma.bookingDocument.update({ where: { id: docId }, data: { liveStep: "", error: "", warning: "" } }).catch(() => undefined);
  void processDocument(docId, { actor: user.email, force: true }).catch((e) => console.error("[booking] retry failed", e));
  await audit({ entityType: "job", entityId: batchId, action: "booking.document.retried", actor: user.email, data: { docId } });
  revalidatePath(`/booking/${batchId}`);
  revalidatePath("/dashboard");
}

/** Reprocess all non-completed documents in a batch. */
export async function reprocessBatchAction(formData: FormData): Promise<void> {
  const user = await getSessionUser();
  if (!user || !userHasPermission(user, PERMISSIONS.JOB_RETRY)) return;
  const batchId = String(formData.get("batchId") ?? "");
  if (!batchId) return;
  void processBatch(batchId, { actor: user.email }).catch((e) => console.error("[booking] reprocess failed", e));
  revalidatePath(`/booking/${batchId}`);
}

export interface CorrectionState {
  error?: string;
  ok?: boolean;
}

/** Manually correct extracted values; recorded in the audit log, then reprocess. */
export async function applyExtractionCorrectionAction(_prev: CorrectionState, formData: FormData): Promise<CorrectionState> {
  const user = await getSessionUser();
  if (!user) return { error: "Not authenticated." };
  if (!userHasPermission(user, PERMISSIONS.BOOKING_REVIEW)) return { error: "You do not have permission to correct extractions." };

  const docId = String(formData.get("docId") ?? "");
  const doc = await prisma.bookingDocument.findUnique({ where: { id: docId } });
  if (!doc) return { error: "Document not found." };

  const gross = normalizeNumber(String(formData.get("grossWeight") ?? ""));
  const cartons = normalizeNumber(String(formData.get("cartons") ?? ""));
  const quantity = normalizeNumber(String(formData.get("quantity") ?? ""));
  const poNumber = String(formData.get("poNumber") ?? "").trim();
  const countryCode = String(formData.get("countryCode") ?? "").trim().toUpperCase();

  const before = { gross: doc.extractedGrossWeight, cartons: doc.extractedCartons, quantity: doc.extractedQuantity, po: doc.poNumber, country: doc.countryCode };
  await prisma.bookingDocument.update({
    where: { id: docId },
    data: {
      extractedGrossWeight: gross || doc.extractedGrossWeight,
      extractedCartons: cartons || doc.extractedCartons,
      extractedQuantity: quantity || doc.extractedQuantity,
      poNumber: poNumber || doc.poNumber,
      countryCode: countryCode || doc.countryCode,
      manualCorrected: true,
      correctedBy: user.email,
      state: "UPLOADED",
      matchOutcome: "",
      warning: "",
      error: "",
    },
  });
  await prisma.bookingDocEvent.create({
    data: { docId, stage: "manual-correction", status: "ok", actor: user.email, message: "Extracted values corrected by reviewer", dataJson: JSON.stringify({ before, after: { gross, cartons, quantity, po: poNumber, country: countryCode } }) },
  });
  await audit({ entityType: "document", entityId: docId, action: "booking.extraction.corrected", actor: user.email, data: { before, after: { gross, cartons, quantity, poNumber, countryCode } } });

  // Re-run the pipeline; processDocument overlays the stored manual corrections
  // on top of re-extraction so the reviewer's values are honoured.
  await processDocument(docId, { actor: user.email, force: true });
  revalidatePath(`/booking/${doc.batchId}`);
  return { ok: true };
}

export interface EditPdfState { error?: string; ok?: boolean; path?: string }

/** Save edited PDF text (title, status, totals, extra lines) + regenerate the PDF. */
export async function saveCorrectedPdfAction(_prev: EditPdfState, formData: FormData): Promise<EditPdfState> {
  const user = await getSessionUser();
  if (!user) return { error: "Not authenticated." };
  if (!userHasPermission(user, PERMISSIONS.BOOKING_REVIEW)) return { error: "You do not have permission to edit booking PDFs." };

  const docId = String(formData.get("docId") ?? "");
  const doc = await prisma.bookingDocument.findUnique({ where: { id: docId } });
  if (!doc) return { error: "Document not found." };

  // GATE (spec): never change the document to Confirmed unless the Damco portal
  // status has been verified as confirmed. The verified portal status is stored
  // on the document by the one-click re-verify flow (headingStatus + fieldStatus).
  const verifiedConfirmed =
    normalizeStatus(doc.headingStatus || "") === "CONFIRMED" &&
    normalizeStatus(doc.fieldStatus || "") === "CONFIRMED";
  if (!verifiedConfirmed) {
    return { error: "UCP will not change this document to “Booking Confirmation / CONFIRMED” until the Damco portal status is verified as confirmed. Run the one-click re-verify first — no PDF was changed." };
  }
  if (!doc.portalPdfPath) {
    return { error: "No captured Damco portal PDF to edit for this document. Re-verify to capture the portal PDF first — no PDF was changed." };
  }

  // Values are kept for the audit and the no-portal fallback; the in-place edit
  // itself only swaps the title/status text in the captured portal PDF.
  const values: CorrectedPdfValues = {
    title: String(formData.get("title") ?? "").trim(),
    soNumber: String(formData.get("soNumber") ?? "").trim(),
    company: String(formData.get("company") ?? "").trim(),
    buyer: String(formData.get("buyer") ?? "").trim(),
    poNumber: String(formData.get("poNumber") ?? "").trim(),
    countryCode: String(formData.get("countryCode") ?? "").trim().toUpperCase(),
    grossWeight: String(formData.get("grossWeight") ?? "").trim(),
    cartons: String(formData.get("cartons") ?? "").trim(),
    quantity: String(formData.get("quantity") ?? "").trim(),
    bookingStatus: String(formData.get("bookingStatus") ?? "").trim().toUpperCase(),
    extraLines: String(formData.get("extraLines") ?? ""),
    footer: String(formData.get("footer") ?? "").trim() || undefined,
  };
  values.editor = user.email;
  const written = await writeCorrectedPdf(doc.batchId, doc.id, values, doc.portalPdfPath);
  await prisma.bookingDocument.update({ where: { id: doc.id }, data: { correctedPdfPath: written.path } });

  const titleCount = written.counts.find((c) => c.label === "title")?.count ?? 0;
  const statusCount = written.counts.find((c) => c.label === "status")?.count ?? 0;
  const note = written.mode === "in-place"
    ? `In-place edit (${written.pages} pages preserved): title×${titleCount}, status×${statusCount}, ${written.size} bytes.`
    : `No portal PDF to edit — fallback template written (${written.size} bytes).`;
  await prisma.bookingDocEvent.create({ data: { docId: doc.id, stage: "pdf-edit", status: written.replacements > 0 || written.mode === "fallback-template" ? "ok" : "failed", actor: user.email, message: `Corrected PDF: ${note}`, dataJson: JSON.stringify({ mode: written.mode, pages: written.pages, replacements: written.replacements, counts: written.counts }) } });
  await audit({ entityType: "document", entityId: doc.id, action: "booking.pdf.edited", actor: user.email, data: { mode: written.mode, pages: written.pages, replacements: written.replacements, titleCount, statusCount } });
  revalidatePath(`/booking/${doc.batchId}`);
  revalidatePath(`/booking/doc/${doc.id}/edit`);
  if (written.mode === "in-place" && written.replacements === 0) {
    return { ok: true, path: written.path, error: "Edited, but the portal PDF did not contain “Booking Requested”/“REQUESTED” to replace — the document may already be confirmed, or its text is not editable. Verify the download." };
  }
  return { ok: true, path: written.path };
}

/**
 * One-click booking status correction (§4 of the spec).
 *
 * This NEVER rewrites a PDF's title/status locally to CONFIRMED. Instead it:
 *   1. Re-opens the real Damco portal booking (serialized visible-browser run);
 *   2. Downloads a FRESH portal PDF;
 *   3. Parses that PDF's heading + status;
 *   4. Marks the UCP document CONFIRMED **only when the portal itself reports
 *      CONFIRMED on both the heading AND the status field**;
 *   5. Stores the fresh portal PDF (never a locally-synthesised substitute);
 *   6. If the portal still shows REQUESTED (or anything other than CONFIRMED),
 *      records that outcome with a clear reviewer message — never a success.
 *
 * UCP does not perform the status-changing portal action: that remains an
 * authorised human workflow in the Damco UI. UCP only refreshes and verifies.
 */
export async function confirmBookingPdfAction(formData: FormData): Promise<void> {
  const user = await getSessionUser();
  if (!user || !userHasPermission(user, PERMISSIONS.BOOKING_REVIEW)) return;
  const docId = String(formData.get("docId") ?? "");
  const doc = await prisma.bookingDocument.findUnique({ where: { id: docId } });
  if (!doc) return;

  const previousStatus = doc.finalStatus || `${doc.headingStatus || "?"}/${doc.fieldStatus || "?"}`;

  // Live-mode-only: without the real portal we can't verify anything, so
  // refuse and tell the reviewer.
  if (env.INTEGRATION_MODE !== "live" || !env.DAMCO_LIVE_ENABLED || !env.DAMCO_USERNAME || !env.DAMCO_PASSWORD) {
    await prisma.bookingDocEvent.create({ data: { docId: doc.id, stage: "one-click-confirm", status: "failed", actor: user.email, message: "Live Damco integration is not configured; UCP cannot verify a Booking Confirmed status. No PDF produced.", dataJson: "{}" } });
    await audit({ entityType: "document", entityId: doc.id, action: "booking.confirm.rejected", actor: user.email, data: { reason: "live-mode-not-configured", previousStatus } });
    revalidatePath(`/booking/${doc.batchId}`);
    return;
  }
  if (!doc.poNumber) {
    await prisma.bookingDocEvent.create({ data: { docId: doc.id, stage: "one-click-confirm", status: "failed", actor: user.email, message: "PO number missing on this document; cannot re-verify in the portal.", dataJson: "{}" } });
    revalidatePath(`/booking/${doc.batchId}`);
    return;
  }

  const result = await serializeLiveRun(async () => {
    const search = await liveSearchBookings({ poNumber: doc.poNumber, countryCode: doc.countryCode });
    if (search.authRequired) return { ok: false, kind: "AUTH", message: search.message } as const;
    if (!search.ok || search.bookings.length === 0) return { ok: false, kind: "NO_MATCH", message: search.message || "No booking found in the portal." } as const;
    const picked = search.bookings[0];
    const opened = await openBookingDetail(picked.bookingNumber);
    if (!opened) return { ok: false, kind: "NO_MATCH", message: `Could not open booking ${picked.bookingNumber}.` } as const;
    const pdf = await generateBookingPdf(picked.bookingNumber);
    if (!pdf) return { ok: false, kind: "NO_PDF", message: `Portal did not deliver a PDF for booking ${picked.bookingNumber}.` } as const;
    const sha256 = createHash("sha256").update(pdf.buffer).digest("hex");
    const dir = join(env.STORAGE_ROOT, "booking-correction", doc.batchId);
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${doc.id}.portal.pdf`);
    await writeFile(path, pdf.buffer);
    let heading = ""; let field = "";
    try {
      const pdfParseMod = await import("pdf-parse/lib/pdf-parse.js");
      const parsed = await pdfParseMod.default(pdf.buffer);
      const pv = parsePortalPdfText(parsed.text ?? "");
      heading = pv.headingStatus; field = pv.fieldStatus;
    } catch { /* keep blanks → treated as UNKNOWN below */ }
    return { ok: true, kind: "OK", bookingNumber: picked.bookingNumber, pdfPath: path, pdfSha256: sha256, heading, field } as const;
  });

  if (!result.ok) {
    const code = result.kind === "AUTH" ? "PORTAL_AUTH_REQUIRED" : result.kind === "NO_MATCH" ? "BOOKING_NOT_FOUND" : "DOWNLOAD_FAILED";
    await prisma.bookingDocument.update({ where: { id: doc.id }, data: { warning: result.message, state: code === "PORTAL_AUTH_REQUIRED" ? "PORTAL_AUTH_REQUIRED" : doc.state, processedAt: new Date() } });
    await prisma.bookingDocEvent.create({ data: { docId: doc.id, stage: "one-click-confirm", status: "failed", actor: user.email, message: `Confirmation re-verify failed: ${result.message}`, dataJson: JSON.stringify({ reason: result.kind }) } });
    await audit({ entityType: "document", entityId: doc.id, action: "booking.confirm.rejected", actor: user.email, data: { reason: result.kind, previousStatus, message: result.message } });
    revalidatePath(`/booking/${doc.batchId}`);
    return;
  }

  const heading = normalizeStatus(result.heading);
  const field = normalizeStatus(result.field);
  const portalIsConfirmed = heading === "CONFIRMED" && field === "CONFIRMED";

  if (!portalIsConfirmed) {
    // Portal does NOT currently confirm this booking. Store the fresh PDF so
    // the reviewer can see what the portal is really showing, keep the UCP
    // state honest (never COMPLETED), and surface what action is needed.
    await prisma.bookingDocument.update({
      where: { id: doc.id },
      data: {
        portalPdfPath: result.pdfPath,
        portalPdfSha256: result.pdfSha256,
        bookingRef: result.bookingNumber,
        headingStatus: heading,
        fieldStatus: field,
        finalStatus: heading === "REQUESTED" && field === "REQUESTED" ? "REQUESTED" : "NEEDS_REVIEW",
        state: "PORTAL_AUTH_REQUIRED",
        warning: `Portal still reports heading='${heading || "UNKNOWN"}', status='${field || "UNKNOWN"}'. UCP never marks a booking confirmed unless the portal does — complete the authorised confirmation in Damco, then click again.`,
        processedAt: new Date(),
      },
    });
    await prisma.bookingDocEvent.create({ data: { docId: doc.id, stage: "one-click-confirm", status: "failed", actor: user.email, message: `Portal did not report CONFIRMED (heading=${heading}, field=${field}). PDF stored for review; status NOT changed.`, dataJson: JSON.stringify({ heading, field, bookingNumber: result.bookingNumber }) } });
    await audit({ entityType: "document", entityId: doc.id, action: "booking.confirm.rejected", actor: user.email, data: { previousStatus, portalHeading: heading, portalField: field, reason: "portal-not-confirmed" } });
    revalidatePath(`/booking/${doc.batchId}`);
    return;
  }

  // Portal says CONFIRMED on both heading and field — store the real portal
  // PDF (never a UCP substitute) and mark the document COMPLETED.
  await prisma.bookingDocument.update({
    where: { id: doc.id },
    data: {
      portalPdfPath: result.pdfPath,
      portalPdfSha256: result.pdfSha256,
      bookingRef: result.bookingNumber,
      headingStatus: "CONFIRMED",
      fieldStatus: "CONFIRMED",
      finalStatus: "CONFIRMED",
      state: "COMPLETED",
      warning: "",
      error: "",
      processedAt: new Date(),
    },
  });
  await prisma.bookingDocEvent.create({ data: { docId: doc.id, stage: "one-click-confirm", status: "ok", actor: user.email, message: `Portal verified CONFIRMED. Fresh portal PDF stored (${result.pdfSha256.slice(0, 10)}…).`, dataJson: JSON.stringify({ bookingNumber: result.bookingNumber }) } });
  await audit({ entityType: "document", entityId: doc.id, action: "booking.confirm.verified", actor: user.email, data: { previousStatus, finalStatus: "CONFIRMED", bookingNumber: result.bookingNumber } });
  revalidatePath(`/booking/${doc.batchId}`);
}

/** Explicit "start/resume" trigger for the dashboard. Idempotent. */
export async function startBookingBatchAction(formData: FormData): Promise<void> {
  const user = await getSessionUser();
  if (!user || !userHasPermission(user, PERMISSIONS.JOB_RETRY)) return;
  const batchId = String(formData.get("batchId") ?? "");
  if (!batchId) return;
  const batch = await prisma.bookingBatch.findUnique({ where: { id: batchId }, include: { documents: { select: { state: true } } } });
  if (!batch) return;
  const pending = batch.documents.filter((d) => d.state !== "COMPLETED").length;
  if (pending === 0) return;
  if (batch.liveStatus === "running") return;
  // Mark running synchronously to close the double-start race, then run in the
  // background so the UI can poll live progress instead of blocking the request.
  if (env.INTEGRATION_MODE === "live") {
    await prisma.bookingBatch.update({ where: { id: batchId }, data: { liveStatus: "running", liveUpdatedAt: new Date() } }).catch(() => undefined);
  }
  void processBatch(batchId, { actor: user.email }).catch((e) => console.error("[booking] start failed", e));
  revalidatePath(`/booking/${batchId}`);
}
