/**
 * Scan a source folder of booking-confirmation PDFs. For each NEW PDF
 * (sha256 not already stored on any ShipmentScheduleRow):
 *
 *   1. Parse the PDF.
 *   2. Extract (orderNo prefix, market code, market+sub code, FOB if present).
 *   3. Find the matching ShipmentScheduleRow by (orderNo + marketCode) — this
 *      row was previously created by the Sales-Contract auto-router from the
 *      PO's (TOD × market) breakdown.
 *   4. Hydrate the booking fields into that row (BCN / BRef / status / ports /
 *      transport mode / gross weight / cartons / cbm / sku / pdfOrderNo /
 *      categories). Nothing is invented — fields the PDF does not expose stay
 *      as they were.
 *   5. Verify the 4-way match the user requested (orderNo, market code,
 *      sub code, FOB). Mismatches become a row-level warning but still save
 *      the extracted fields.
 *
 * Already-extracted PDFs (sha256 collision) are reported as "skipped" and
 * left alone, so re-scanning the same folder is cheap and idempotent.
 */
import { readFile, readdir, stat, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { audit } from "@/lib/audit";
import { parsePdfText } from "@/server/pdf/parse-pdf";
import { parseBookingFilename } from "./parse-filename";
import { parseBookingPdfText } from "./parse-booking-pdf";

export interface BookingFolderScanResult {
  folderPath: string;
  pdfsFound: number;
  skippedAlreadyExtracted: number;
  matchedAndHydrated: number;
  unmatched: number;
  parseFailed: number;
  items: BookingFolderScanItem[];
}

export interface BookingFolderScanItem {
  fileName: string;
  action: "hydrated" | "skipped_already_extracted" | "unmatched" | "parse_failed";
  reason: string;
  rowId?: string;
  scheduleId?: string;
  cutoffId?: string;
  orderNoPrefix: string;
  marketCode: string;
  marketSubCode: string;
  pdfFob: number | null;
  rowFob: number | null;
  fobMatches: boolean | null; // null = PDF didn't carry FOB, no comparison
  bcn: string;
  bookingRef: string;
  bookingStatus: string;
}

/** Best-effort FOB / unit price extractor from the parsed PDF text. */
function extractFobFromBookingPdf(text: string): number | null {
  if (!text) return null;
  // Common labels on H&M / Damco booking confirmations.
  const patterns = [
    /Unit\s*Price\s*(?:USD|\$)?\s*[:\s]+([\d]+\.\d{1,4})/i,
    /\bFOB\b[^0-9]{0,10}([\d]+\.\d{1,4})/i,
    /Price\/Unit[^0-9]{0,10}([\d]+\.\d{1,4})/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return null;
}

export interface BookingPdfInput {
  fileName: string;
  buffer: Buffer;
}

/** Entry point used by the browser-picked folder flow: files already in memory. */
export async function scanBookingUploads(opts: {
  pdfs: BookingPdfInput[];
  folderLabel?: string;        // what to show in the UI (e.g. "picked: 12 files")
  actor: string;
}): Promise<BookingFolderScanResult> {
  const result: BookingFolderScanResult = {
    folderPath: opts.folderLabel || "(browser-picked folder)",
    pdfsFound: opts.pdfs.length,
    skippedAlreadyExtracted: 0,
    matchedAndHydrated: 0,
    unmatched: 0,
    parseFailed: 0,
    items: [],
  };
  for (const pdf of opts.pdfs) {
    await processOneBookingPdf(result, pdf.fileName, pdf.buffer, opts.actor);
  }
  await auditScan(result, opts.actor);
  return result;
}

/** Entry point used by the typed path flow: server reads files from disk. */
export async function scanBookingFolder(opts: {
  folderPath: string;
  actor: string;
}): Promise<BookingFolderScanResult> {
  const { folderPath, actor } = opts;
  const result: BookingFolderScanResult = {
    folderPath,
    pdfsFound: 0,
    skippedAlreadyExtracted: 0,
    matchedAndHydrated: 0,
    unmatched: 0,
    parseFailed: 0,
    items: [],
  };

  let entries: string[] = [];
  try {
    entries = await readdir(folderPath);
  } catch (e) {
    throw new Error(`Could not read folder "${folderPath}": ${e instanceof Error ? e.message : "unknown"}`);
  }

  const pdfPaths: string[] = [];
  for (const name of entries) {
    const full = join(folderPath, name);
    try {
      const s = await stat(full);
      if (s.isFile() && name.toLowerCase().endsWith(".pdf")) pdfPaths.push(full);
    } catch { /* skip unreadable entries */ }
  }
  result.pdfsFound = pdfPaths.length;

  for (const path of pdfPaths) {
    const fileName = path.split(/[\\/]/).pop() || path;
    let buf: Buffer;
    try {
      buf = await readFile(path);
    } catch (e) {
      result.parseFailed++;
      result.items.push({
        fileName, action: "parse_failed",
        reason: `read failed: ${e instanceof Error ? e.message : "unknown"}`,
        orderNoPrefix: "", marketCode: "", marketSubCode: "", pdfFob: null, rowFob: null,
        fobMatches: null, bcn: "", bookingRef: "", bookingStatus: "",
      });
      continue;
    }
    await processOneBookingPdf(result, fileName, buf, actor);
  }

  await auditScan(result, actor);
  return result;
}

async function processOneBookingPdf(
  result: BookingFolderScanResult,
  fileName: string,
  buf: Buffer,
  actor: string,
): Promise<void> {
    const sha = createHash("sha256").update(buf).digest("hex");

    // Dedup: skip if any ShipmentScheduleRow already has this sha.
    const already = await prisma.shipmentScheduleRow.findFirst({
      where: { pdfSha256: sha },
      select: { id: true, scheduleId: true, cutoffId: true, orderNo: true, marketCode: true },
    });
    if (already) {
      result.skippedAlreadyExtracted++;
      result.items.push({
        fileName, action: "skipped_already_extracted",
        reason: `Already extracted into row ${already.id} (${already.orderNo} / ${already.marketCode}).`,
        rowId: already.id, scheduleId: already.scheduleId, cutoffId: already.cutoffId,
        orderNoPrefix: "", marketCode: "", marketSubCode: "",
        pdfFob: null, rowFob: null, fobMatches: null,
        bcn: "", bookingRef: "", bookingStatus: "",
      });
      return;
    }

    // Parse: filename first (fast + authoritative for the pattern the user
    // described: "<orderNoPrefix> <MarketSub>.pdf"), then PDF text.
    const nameParts = parseBookingFilename(fileName);
    let text = "";
    let fields = parseBookingPdfText("");
    try {
      const parsed = await parsePdfText(buf);
      text = parsed.text;
      fields = parseBookingPdfText(text);
    } catch {
      result.parseFailed++;
      result.items.push({
        fileName, action: "parse_failed",
        reason: "pdf-parse failed on this file",
        orderNoPrefix: nameParts.orderNoPrefix, marketCode: nameParts.marketCode, marketSubCode: nameParts.marketSubCode,
        pdfFob: null, rowFob: null, fobMatches: null,
        bcn: "", bookingRef: "", bookingStatus: "",
      });
      return;
    }

    // Resolve the 4 match keys: orderNo prefix, market code, market+sub, FOB.
    const pdfPrefix = fields.pdfOrderNo
      ? (fields.pdfOrderNo.match(/^(\d{4,})/)?.[1] ?? "")
      : "";
    const orderNoPrefix = nameParts.orderNoPrefix || pdfPrefix;
    const marketSubFromPdf = fields.categories || "";
    const marketSubCode = nameParts.marketSubCode || marketSubFromPdf;
    const marketCode =
      nameParts.marketCode ||
      (marketSubFromPdf ? marketSubFromPdf.slice(0, 2) : "") ||
      (fields.skuItem ? fields.skuItem.split("/")[0] : "");
    const pdfFob = extractFobFromBookingPdf(text);

    if (!orderNoPrefix || !marketCode) {
      result.unmatched++;
      result.items.push({
        fileName, action: "unmatched",
        reason: `Could not read orderNo+market from filename or PDF (prefix="${orderNoPrefix}", market="${marketCode}").`,
        orderNoPrefix, marketCode, marketSubCode, pdfFob, rowFob: null, fobMatches: null,
        bcn: fields.bcn, bookingRef: fields.bookingRef, bookingStatus: fields.bookingStatus,
      });
      return;
    }

    // Find the matching existing row across every schedule (orderNo prefix +
    // marketCode). The row was created earlier by the Sales-Contract
    // auto-router. Prefer an unfilled row (no pdfSha256) so we don't rewrite
    // one that was already filled by another PDF.
    const candidates = await prisma.shipmentScheduleRow.findMany({
      where: {
        marketCode,
        OR: [
          { orderNo: { startsWith: orderNoPrefix + "-" } },
          { orderNo: orderNoPrefix },
        ],
      },
      orderBy: [{ pdfSha256: "asc" }, { createdAt: "asc" }],
    });
    const row = candidates.find((r) => !r.pdfSha256) ?? candidates[0];
    if (!row) {
      result.unmatched++;
      result.items.push({
        fileName, action: "unmatched",
        reason: `No ShipmentScheduleRow found for orderNo starting "${orderNoPrefix}" and market "${marketCode}". Upload the Sales Contract first so the row exists.`,
        orderNoPrefix, marketCode, marketSubCode, pdfFob, rowFob: null, fobMatches: null,
        bcn: fields.bcn, bookingRef: fields.bookingRef, bookingStatus: fields.bookingStatus,
      });
      return;
    }

    // 4-way check (user rule 2026-10-28). orderNo + market are already matched
    // above. Sub-code is logged (never rejected: filename may abbreviate it).
    // FOB is compared only if the PDF carries one.
    let fobMatches: boolean | null = null;
    if (pdfFob !== null && row.fob !== null) {
      fobMatches = Math.abs(pdfFob - row.fob) < 0.01;
    }

    // Store the PDF under the schedule's folder so it's downloadable + auditable.
    const storeDir = join(env.STORAGE_ROOT, "shipment-schedule", row.scheduleId);
    await mkdir(storeDir, { recursive: true });
    const storagePath = join(storeDir, `${sha}.pdf`);
    try { await writeFile(storagePath, buf); } catch { /* non-fatal; row still updates */ }

    const warnings: string[] = [];
    if (fobMatches === false) {
      warnings.push(`FOB mismatch: PDF=${pdfFob}, row=${row.fob}`);
    }
    if (marketSubCode && row.marketSubCode && marketSubCode !== row.marketSubCode) {
      warnings.push(`Sub-code differs: PDF="${marketSubCode}", row="${row.marketSubCode}"`);
    }

    await prisma.shipmentScheduleRow.update({
      where: { id: row.id },
      data: {
        // Booking fields — overwrite with whatever the PDF carries.
        pdfOrderNo: fields.pdfOrderNo || row.pdfOrderNo,
        skuItem: fields.skuItem || row.skuItem,
        marketSubCode: marketSubCode || row.marketSubCode,
        bookingRef: fields.bookingRef || row.bookingRef,
        bcn: fields.bcn || row.bcn,
        bookingStatus: fields.bookingStatus || row.bookingStatus,
        portOfLoading: fields.portOfLoading || row.portOfLoading,
        portOfDischarge: fields.portOfDischarge || row.portOfDischarge,
        placeOfDelivery: fields.placeOfDelivery || row.placeOfDelivery,
        transportMode: fields.transportMode || row.transportMode,
        pdfPcs: fields.pdfPcs ?? row.pdfPcs,
        grossWeightKg: fields.grossWeightKg ?? row.grossWeightKg,
        cartons: fields.cartons ?? row.cartons,
        measurementCbm: fields.measurementCbm ?? row.measurementCbm,
        expectedDelivery: fields.expectedDelivery || row.expectedDelivery,
        pdfFileName: fileName,
        pdfSha256: sha,
        pdfPath: storagePath,
        matched: true,
        matchReason: warnings.length > 0 ? `booking_hydrated_with_warnings:${warnings.join("; ")}` : "booking_hydrated",
      },
    });

    await audit({
      entityType: "shipment-schedule",
      entityId: row.scheduleId,
      action: "row.booking_hydrated",
      actor,
      data: { rowId: row.id, fileName, bcn: fields.bcn, bookingRef: fields.bookingRef, warnings },
    });

    result.matchedAndHydrated++;
    result.items.push({
      fileName, action: "hydrated",
      reason: warnings.length > 0 ? `Hydrated with warnings: ${warnings.join("; ")}` : "Hydrated OK.",
      rowId: row.id, scheduleId: row.scheduleId, cutoffId: row.cutoffId,
      orderNoPrefix, marketCode, marketSubCode, pdfFob, rowFob: row.fob,
      fobMatches,
      bcn: fields.bcn, bookingRef: fields.bookingRef, bookingStatus: fields.bookingStatus,
    });
}

async function auditScan(result: BookingFolderScanResult, actor: string): Promise<void> {
  await audit({
    entityType: "shipment-schedule",
    entityId: "folder-scan",
    action: "booking.folder.scanned",
    actor,
    data: {
      folderPath: result.folderPath,
      pdfsFound: result.pdfsFound,
      hydrated: result.matchedAndHydrated,
      skipped: result.skippedAlreadyExtracted,
      unmatched: result.unmatched,
      parseFailed: result.parseFailed,
    },
  });
}
