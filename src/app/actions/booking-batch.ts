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
    await processBatch(res.batchId, { actor: user.email });
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
  await processDocument(docId, { actor: user.email, force: true });
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
  await processBatch(batchId, { actor: user.email });
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
