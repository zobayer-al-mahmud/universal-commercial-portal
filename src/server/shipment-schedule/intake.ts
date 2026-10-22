import { createHash } from "crypto";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { audit } from "@/lib/audit";
import { parsePdfText } from "@/server/pdf/parse-pdf";
import { parseBookingFilename } from "./parse-filename";
import { parseBookingPdfText } from "./parse-booking-pdf";
import { matchByOrderNoPrefix } from "./match-sales-contract";
import type { SalesContractLookup } from "./types";

/**
 * Create a brand-new Shipment Schedule with two default cut-offs ("1st cut off"
 * and "2nd cut off"). Dates are blank until the user enters them.
 */
export async function createSchedule(opts: { weekTitle: string; weekNo?: number | null; actor: string }): Promise<{ id: string }> {
  const sched = await prisma.shipmentSchedule.create({
    data: {
      weekTitle: opts.weekTitle.trim(),
      weekNo: opts.weekNo ?? null,
      createdBy: opts.actor,
      cutoffs: {
        create: [
          { label: "1st cut off", date: "", sortOrder: 1 },
          { label: "2nd cut off", date: "", sortOrder: 2 },
        ],
      },
    },
  });
  await audit({ entityType: "shipment-schedule", entityId: sched.id, action: "schedule.created", actor: opts.actor, data: { weekTitle: opts.weekTitle } });
  return { id: sched.id };
}

export async function updateScheduleTitle(id: string, weekTitle: string, weekNo: number | null, actor: string): Promise<void> {
  await prisma.shipmentSchedule.update({ where: { id }, data: { weekTitle: weekTitle.trim(), weekNo } });
  await audit({ entityType: "shipment-schedule", entityId: id, action: "schedule.title.updated", actor, data: { weekTitle, weekNo } });
}

export async function addCutoff(scheduleId: string, label: string, date: string, actor: string): Promise<void> {
  const count = await prisma.shipmentScheduleCutoff.count({ where: { scheduleId } });
  await prisma.shipmentScheduleCutoff.create({
    data: { scheduleId, label: label.trim(), date: date.trim(), sortOrder: count + 1 },
  });
  await audit({ entityType: "shipment-schedule", entityId: scheduleId, action: "cutoff.added", actor, data: { label, date } });
}

export async function updateCutoff(id: string, label: string, date: string, actor: string): Promise<void> {
  const prev = await prisma.shipmentScheduleCutoff.findUnique({ where: { id } });
  if (!prev) throw new Error("Cut-off not found.");
  await prisma.shipmentScheduleCutoff.update({ where: { id }, data: { label: label.trim(), date: date.trim() } });
  await audit({ entityType: "shipment-schedule", entityId: prev.scheduleId, action: "cutoff.updated", actor, data: { id, label, date } });
}

export async function deleteCutoff(id: string, actor: string): Promise<void> {
  const prev = await prisma.shipmentScheduleCutoff.findUnique({ where: { id } });
  if (!prev) return;
  // Row-level cascade will clear the rows that were assigned to this cutoff —
  // this is intentional: deleting a cutoff throws away its PDFs' extracted rows.
  await prisma.shipmentScheduleCutoff.delete({ where: { id } });
  await audit({ entityType: "shipment-schedule", entityId: prev.scheduleId, action: "cutoff.deleted", actor, data: { id, label: prev.label } });
}

export interface UploadedPdf {
  name: string;
  buffer: Buffer;
}

export interface ProcessResult {
  rowId: string;
  fileName: string;
  orderNoPrefix: string;
  marketCode: string;
  marketSubCode: string;
  matched: boolean;
  matchReason: string;
  bookingStatus: string;
  pdfPcs: number | null;
  cartons: number | null;
}

/**
 * Upload one or more booking-confirmation PDFs to a specific cut-off, parse
 * them, cross-match the OrderNo against the H&M Sales Contract POs, and
 * persist one ShipmentScheduleRow per PDF.
 *
 * - sha256-dedup: the same file re-uploaded against the same schedule is
 *   recognised and the earlier row is kept (idempotent).
 * - Storage: PDFs are copied verbatim into
 *   STORAGE_ROOT/shipment-schedule/<scheduleId>/<sha256>.pdf
 * - Sales-contract hydration is best-effort — unmatched PDFs still create a
 *   row (so the user sees it) with matched=false + matchReason explaining why.
 */
export async function uploadPdfsToCutoff(opts: {
  scheduleId: string;
  cutoffId: string;
  files: UploadedPdf[];
  actor: string;
}): Promise<ProcessResult[]> {
  const { scheduleId, cutoffId, files, actor } = opts;
  if (files.length === 0) return [];

  const [schedule, cutoff] = await Promise.all([
    prisma.shipmentSchedule.findUnique({ where: { id: scheduleId } }),
    prisma.shipmentScheduleCutoff.findUnique({ where: { id: cutoffId } }),
  ]);
  if (!schedule) throw new Error("Shipment schedule not found.");
  if (!cutoff || cutoff.scheduleId !== scheduleId) throw new Error("Cut-off does not belong to this schedule.");

  const storeDir = join(env.STORAGE_ROOT, "shipment-schedule", scheduleId);
  await mkdir(storeDir, { recursive: true });

  const results: ProcessResult[] = [];

  for (const f of files) {
    const sha = createHash("sha256").update(f.buffer).digest("hex");
    const storagePath = join(storeDir, `${sha}.pdf`);
    await writeFile(storagePath, f.buffer);

    const filenameParts = parseBookingFilename(f.name);
    let text = "";
    let pdfFields = parseBookingPdfText(""); // defaults
    try {
      const parsed = await parsePdfText(f.buffer);
      text = parsed.text;
      pdfFields = parseBookingPdfText(text);
    } catch {
      pdfFields.warnings.push("pdf_parse_failed");
    }

    // Look up sales-contract candidates by the orderNo prefix. We fetch a
    // small window: all READY POs whose orderNo starts with the digits.
    let matchReason = "no_sales_contract_po";
    let matched = false;
    let hydrated: {
      buyerCode: string;
      contractNo: string;
      contractDate: string;
      orderNo: string;
      pcs: number | null;
      style: string;
      fob: number | null;
      composition: string;
      cat: string;
      hts: string;
    } | undefined;
    if (filenameParts.ok) {
      const pos = await prisma.hmSalesContractPo.findMany({
        where: { orderNo: { startsWith: filenameParts.orderNoPrefix + "-" } },
        include: { contract: true },
        take: 20,
      });
      const candidates: SalesContractLookup[] = pos.map((p) => ({
        contract: {
          marchentContNo: p.contract.marchentContNo,
          contractDate: p.contract.contractDate,
          buyerCode: p.contract.buyerCode,
          commercialContNo: p.contract.commercialContNo,
          commercialDate: p.contract.commercialDate,
        },
        orderNo: p.orderNo,
        state: p.state,
        rowsJson: p.rowsJson,
      }));
      const m = matchByOrderNoPrefix(filenameParts.orderNoPrefix, candidates);
      matched = m.matched;
      matchReason = m.reason;
      hydrated = m.hydrated;
    } else {
      matchReason = `bad_filename:${filenameParts.reason ?? "unknown"}`;
    }

    // Idempotency: if this (schedule, sha) is already stored, update the
    // existing row's cutoff to the newly chosen one (user may have changed
    // their mind) and skip re-match. New metadata is still applied.
    const existing = await prisma.shipmentScheduleRow.findFirst({ where: { scheduleId, pdfSha256: sha } });

    const data = {
      scheduleId,
      cutoffId,
      buyerCode: hydrated?.buyerCode ?? "",
      contractNo: hydrated?.contractNo ?? "",
      contractDate: hydrated?.contractDate ?? "",
      orderNo: hydrated?.orderNo ?? filenameParts.orderNoPrefix,
      pcs: hydrated?.pcs ?? null,
      style: hydrated?.style ?? "",
      fob: hydrated?.fob ?? null,
      composition: hydrated?.composition ?? "",
      cat: hydrated?.cat ?? "",
      hts: hydrated?.hts ?? "",
      pdfOrderNo: pdfFields.pdfOrderNo,
      marketCode: filenameParts.marketCode,
      marketSubCode: filenameParts.marketSubCode,
      skuItem: pdfFields.skuItem,
      bookingRef: pdfFields.bookingRef,
      bcn: pdfFields.bcn,
      bookingStatus: pdfFields.bookingStatus,
      portOfLoading: pdfFields.portOfLoading,
      portOfDischarge: pdfFields.portOfDischarge,
      placeOfDelivery: pdfFields.placeOfDelivery,
      transportMode: pdfFields.transportMode,
      pdfPcs: pdfFields.pdfPcs,
      grossWeightKg: pdfFields.grossWeightKg,
      cartons: pdfFields.cartons,
      measurementCbm: pdfFields.measurementCbm,
      pdfFileName: f.name,
      pdfSha256: sha,
      pdfPath: storagePath,
      matched,
      matchReason,
    } as const;

    let rowId: string;
    if (existing) {
      await prisma.shipmentScheduleRow.update({ where: { id: existing.id }, data });
      rowId = existing.id;
    } else {
      const created = await prisma.shipmentScheduleRow.create({ data });
      rowId = created.id;
    }

    await audit({
      entityType: "shipment-schedule",
      entityId: scheduleId,
      action: "row.ingested",
      actor,
      data: { rowId, fileName: f.name, cutoffId, matched, matchReason, bcn: pdfFields.bcn, bookingRef: pdfFields.bookingRef },
    });

    results.push({
      rowId,
      fileName: f.name,
      orderNoPrefix: filenameParts.orderNoPrefix,
      marketCode: filenameParts.marketCode,
      marketSubCode: filenameParts.marketSubCode,
      matched,
      matchReason,
      bookingStatus: pdfFields.bookingStatus,
      pdfPcs: pdfFields.pdfPcs,
      cartons: pdfFields.cartons,
    });
  }

  return results;
}

/** Move an existing row to a different cut-off (e.g. after review). */
export async function moveRowToCutoff(rowId: string, cutoffId: string, actor: string): Promise<void> {
  const row = await prisma.shipmentScheduleRow.findUnique({ where: { id: rowId } });
  if (!row) throw new Error("Row not found.");
  const dst = await prisma.shipmentScheduleCutoff.findUnique({ where: { id: cutoffId } });
  if (!dst || dst.scheduleId !== row.scheduleId) throw new Error("Target cut-off does not belong to this schedule.");
  await prisma.shipmentScheduleRow.update({ where: { id: rowId }, data: { cutoffId } });
  await audit({ entityType: "shipment-schedule", entityId: row.scheduleId, action: "row.moved", actor, data: { rowId, from: row.cutoffId, to: cutoffId } });
}

/** Delete a row (and its edit history). The PDF file stays on disk for audit. */
export async function deleteRow(rowId: string, actor: string): Promise<void> {
  const row = await prisma.shipmentScheduleRow.findUnique({ where: { id: rowId } });
  if (!row) return;
  await prisma.shipmentScheduleRow.delete({ where: { id: rowId } });
  await audit({ entityType: "shipment-schedule", entityId: row.scheduleId, action: "row.deleted", actor, data: { rowId, pdfFileName: row.pdfFileName } });
}
