import { mkdir, readFile, writeFile } from "fs/promises";
import { join } from "path";
import { env } from "@/lib/env";
import { buildBookingPdf } from "./pdf-writer";
import { editPdfTextInPlace, CONFIRM_REPLACEMENTS } from "./in-place-edit";

export interface CorrectedPdfValues {
  title: string;         // "BOOKING CONFIRMED" | "BOOKING REQUESTED" | free text
  soNumber: string;
  company: string;
  buyer: string;
  poNumber: string;
  countryCode: string;
  grossWeight: string;
  cartons: string;
  quantity: string;
  bookingStatus: string; // CONFIRMED | REQUESTED | ...
  extraLines: string;    // additional free-text lines (\n separated)
  footer?: string;
  /** Who edited (for the amendment footer). */
  editor?: string;
}

/**
 * Produce the corrected booking PDF by editing the captured Damco/Maersk portal
 * PDF **in place**: the title "Booking Requested" → "Booking Confirmation" and
 * the Status field "REQUESTED" → "CONFIRMED". No page is added, no template is
 * created, and nothing is flattened to an image — every original page,
 * dimension, table, border, logo, font and all unrelated text is preserved
 * (see `editPdfTextInPlace`). If no portal PDF exists to edit, falls back to the
 * plain `buildBookingPdf` writer (clearly labelled as a UCP document).
 *
 * Returns the bytes plus how it was produced, for the caller to audit/guard.
 */
export interface RenderResult {
  buffer: Buffer;
  mode: "in-place" | "fallback-template";
  pages: number;
  /** Total text replacements applied (in-place mode). */
  replacements: number;
  /** Per-rule counts (in-place mode). */
  counts: { label: string; count: number }[];
}

export async function renderCorrectedPdfAsync(values: CorrectedPdfValues, basePdf: Buffer | null): Promise<RenderResult> {
  if (!basePdf || basePdf.length === 0) {
    const buffer = renderCorrectedPdfFallback(values);
    return { buffer, mode: "fallback-template", pages: 0, replacements: 0, counts: [] };
  }
  try {
    const res = await editPdfTextInPlace(basePdf, CONFIRM_REPLACEMENTS);
    return {
      buffer: res.buffer,
      mode: "in-place",
      pages: res.pages,
      replacements: res.totalReplacements,
      counts: res.counts.map((c) => ({ label: c.label, count: c.count })),
    };
  } catch {
    // Portal PDF unreadable by pdf-lib (rare) — never lose the request; emit the
    // clearly-labelled fallback template instead of a half-edited file.
    const buffer = renderCorrectedPdfFallback(values);
    return { buffer, mode: "fallback-template", pages: 0, replacements: 0, counts: [] };
  }
}

/**
 * Generic (template-based) PDF — used only when no original Damco PDF exists to
 * overlay on top of. Clearly labelled as a UCP document.
 */
export function renderCorrectedPdfFallback(values: CorrectedPdfValues): Buffer {
  const lines = [
    values.soNumber ? `SO Number: ${values.soNumber}` : "",
    values.company ? `Company: ${values.company}` : "",
    values.buyer ? `Buyer: ${values.buyer}` : "",
    values.poNumber ? `PO Number: ${values.poNumber}` : "",
    values.countryCode ? `Country / SKU: ${values.countryCode}` : "",
    values.grossWeight ? `Gross Weight: ${values.grossWeight} kg` : "",
    values.cartons ? `Total Cartons: ${values.cartons}` : "",
    values.quantity ? `Total Quantity: ${values.quantity}` : "",
    values.bookingStatus ? `Booking Status: ${values.bookingStatus}` : "",
    ...values.extraLines.split(/\r?\n/).map((l) => l.trim()).filter(Boolean),
  ].filter(Boolean);
  return buildBookingPdf({
    title: values.title.trim() || "BOOKING",
    lines,
    footer: values.footer || `UCP Booking Correction (no portal PDF to overlay) · ${new Date().toISOString()}${values.editor ? ` · by ${values.editor}` : ""}`,
  });
}

/**
 * Edit the captured portal PDF for a document in place and store the result in
 * the "corrected" slot. The ORIGINAL uploaded PDF and the captured portal PDF
 * are left untouched — only `${docId}.corrected.pdf` is written, so the original
 * is always preserved. Returns the stored path, byte size and how it was
 * produced (in-place edit vs fallback template) for the UI/audit.
 */
export async function writeCorrectedPdf(
  batchId: string,
  docId: string,
  values: CorrectedPdfValues,
  portalPdfPath?: string | null,
): Promise<{ path: string; size: number; mode: "in-place" | "fallback-template"; replacements: number; pages: number; counts: { label: string; count: number }[] }> {
  const dir = join(env.STORAGE_ROOT, "booking-correction", batchId);
  await mkdir(dir, { recursive: true });

  let base: Buffer | null = null;
  if (portalPdfPath) {
    try { base = await readFile(portalPdfPath); } catch { base = null; }
  }
  const res = await renderCorrectedPdfAsync(values, base);
  const path = join(dir, `${docId}.corrected.pdf`);
  await writeFile(path, res.buffer);
  return { path, size: res.buffer.length, mode: res.mode, replacements: res.replacements, pages: res.pages, counts: res.counts };
}
