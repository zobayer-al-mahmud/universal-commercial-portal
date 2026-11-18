/**
 * Bulk booking-PDF ingest triggered from the Customs Invoice list page
 * (user rule 2026-11-12). Each uploaded PDF is parsed in memory and written
 * directly to the matching CustomsInvoice — matched by short order number
 * parsed from the filename. No ShipmentScheduleRow is created or touched;
 * no schedules or cut-offs are fabricated. If no invoice exists for the
 * order the file is skipped with a clear reason (user rule: skip + warning).
 *
 * The invoice detail page's open-time auto-sync was made non-destructive in
 * the same change, so these PDF-sourced values survive the next page open.
 */
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { parseBookingFilename } from "@/server/shipment-schedule/parse-filename";
import { parseBookingPdfText } from "@/server/shipment-schedule/parse-booking-pdf";
import { updateInvoiceFields } from "./intake";
import { shortOrderKey } from "./pull-data";
import type { InvoiceFields } from "./types";

// Node `pdf-parse` import — lazy so the serverless bundle doesn't eagerly
// pull pdfjs when the module graph is traced.
async function parsePdfBuffer(buf: Buffer): Promise<string> {
  const mod = await import("pdf-parse");
  const pdfParse = (mod.default ?? mod) as (b: Buffer) => Promise<{ text: string }>;
  const r = await pdfParse(buf);
  return r.text ?? "";
}

export interface BookingIngestFileInput {
  filename: string;
  buffer: Buffer;
}

export type BookingIngestOutcome =
  | "matched"              // at least one invoice updated
  | "skipped_no_invoice"   // parsed OK, no CustomsInvoice exists for this order yet
  | "skipped_bad_filename" // filename didn't yield an order-no prefix
  | "skipped_empty_pdf"    // PDF had no extractable text / no useful fields
  | "error";

export interface BookingIngestFileResult {
  filename: string;
  outcome: BookingIngestOutcome;
  reason?: string;
  orderNoPrefix: string;
  marketSubCode: string;
  updatedInvoiceIds: string[];
  // Fields actually written on at least one invoice (so the UI can show
  // "ports + cartons + weight + measurement filled in" per file).
  filledFields: Record<string, string | number>;
}

export interface BookingIngestResult {
  totalFiles: number;
  matched: number;
  skipped: number;
  errors: number;
  files: BookingIngestFileResult[];
}

export async function ingestBookingPdfsForInvoices(
  files: BookingIngestFileInput[],
  opts: { actor?: string } = {},
): Promise<BookingIngestResult> {
  const results: BookingIngestFileResult[] = [];
  for (const f of files) {
    results.push(await ingestOne(f, opts.actor));
  }
  const matched = results.filter((r) => r.outcome === "matched").length;
  const skipped = results.filter((r) => r.outcome.startsWith("skipped_")).length;
  const errors = results.filter((r) => r.outcome === "error").length;
  return { totalFiles: results.length, matched, skipped, errors, files: results };
}

async function ingestOne(
  file: BookingIngestFileInput,
  actor: string | undefined,
): Promise<BookingIngestFileResult> {
  const base: BookingIngestFileResult = {
    filename: file.filename,
    outcome: "error",
    orderNoPrefix: "",
    marketSubCode: "",
    updatedInvoiceIds: [],
    filledFields: {},
  };

  const nameParts = parseBookingFilename(file.filename);
  base.orderNoPrefix = nameParts.orderNoPrefix;
  base.marketSubCode = nameParts.marketSubCode;
  if (!nameParts.ok || !nameParts.orderNoPrefix) {
    return { ...base, outcome: "skipped_bad_filename", reason: nameParts.reason ?? "filename has no order-no prefix" };
  }

  let text = "";
  try {
    text = await parsePdfBuffer(file.buffer);
  } catch (e) {
    return { ...base, outcome: "error", reason: e instanceof Error ? e.message : "pdf-parse failed" };
  }
  if (!text || text.length < 50) {
    return { ...base, outcome: "skipped_empty_pdf", reason: "pdf had no extractable text" };
  }

  const parsed = parseBookingPdfText(text);

  // Resolve the invoice(s). CustomsInvoice.orderNo is the short key (e.g.
  // "644637"); the filename gives us the same short key as `orderNoPrefix`.
  const shortKey = shortOrderKey(nameParts.orderNoPrefix);
  const invoices = await prisma.customsInvoice.findMany({
    where: { orderNo: shortKey },
    select: { id: true },
  });
  if (invoices.length === 0) {
    return {
      ...base,
      outcome: "skipped_no_invoice",
      reason: `no Customs Invoice exists for order ${shortKey} — create it from the Customs Invoice list first`,
    };
  }

  // Build the field patch — ONLY non-empty values go in, so a field the
  // parser couldn't extract never clobbers a value the user already typed.
  const patch: Partial<InvoiceFields> = {};
  const setStr = (k: keyof InvoiceFields, v: string) => {
    if (v && v.trim() !== "") (patch as Record<string, unknown>)[k] = v;
  };
  const setNum = (k: keyof InvoiceFields, v: number | null) => {
    if (v != null && Number.isFinite(v)) (patch as Record<string, unknown>)[k] = v;
  };
  setStr("portOfLoading", parsed.portOfLoading);
  setStr("portOfDischarge", parsed.portOfDischarge);
  setStr("placeOfDelivery", parsed.placeOfDelivery);
  setStr("transportMode", parsed.transportMode);
  setNum("totalCartons", parsed.cartons);
  setNum("grossWeightKg", parsed.grossWeightKg);
  setNum("measurementCbm", parsed.measurementCbm);
  // Expected Delivery → the invoice's `invoiceDate` prefill. Only when the
  // invoice hasn't been given a date yet — the user's typed invoiceDate wins.
  // (Headline fields like invoiceNumber are never set here; the user owns them.)
  const expectedDelivery = parsed.expectedDelivery?.trim() ?? "";

  // Load current invoice rows to apply the "non-empty + backfill-only" rules.
  const current = await prisma.customsInvoice.findMany({
    where: { id: { in: invoices.map((i) => i.id) } },
    select: { id: true, invoiceDate: true },
  });

  const updatedInvoiceIds: string[] = [];
  for (const inv of current) {
    const invPatch: Partial<InvoiceFields> = { ...patch };
    if (expectedDelivery && !inv.invoiceDate) invPatch.invoiceDate = expectedDelivery;
    if (Object.keys(invPatch).length === 0) continue;
    await updateInvoiceFields(inv.id, invPatch, { actor: actor ?? "system", source: "booking-pdf" });
    updatedInvoiceIds.push(inv.id);
  }

  if (updatedInvoiceIds.length === 0) {
    return {
      ...base,
      outcome: "skipped_empty_pdf",
      reason: "PDF parsed but every field was already set on the invoice",
    };
  }

  // Record what landed on the invoice (not the raw parse, so the UI reflects
  // what the operator can go confirm).
  const filled: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(patch)) if (v != null && v !== "") filled[k] = v as string | number;
  if (expectedDelivery) filled["invoiceDate"] = expectedDelivery;

  await audit({
    entityType: "customs-invoice",
    entityId: updatedInvoiceIds.join(","),
    action: "customs-invoice.booking-pdf.ingested",
    actor: actor ?? "system",
    data: {
      fileName: file.filename,
      orderNoPrefix: nameParts.orderNoPrefix,
      marketSubCode: nameParts.marketSubCode,
      invoiceIds: updatedInvoiceIds,
      filledFieldKeys: Object.keys(filled),
    },
  });

  return {
    ...base,
    outcome: "matched",
    updatedInvoiceIds,
    filledFields: filled,
  };
}
