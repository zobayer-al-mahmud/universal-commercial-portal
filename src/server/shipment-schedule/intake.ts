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
  // Row-level cascade will clear the rows that were assigned to this cutoff –
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
 * - Sales-contract hydration is best-effort – unmatched PDFs still create a
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

    // Decide the order-no prefix to match on: the filename-derived digits win
    // when present (it's what the user named the file for); otherwise fall back
    // to the PO: value extracted from the PDF text (e.g. "698518/5-2027" →
    // "698518"). This lets a bare "698518.pdf" filename still hydrate properly.
    const pdfPrefix = pdfFields.pdfOrderNo
      ? (pdfFields.pdfOrderNo.match(/^(\d{4,})/)?.[1] ?? "")
      : "";
    const orderNoPrefix = filenameParts.orderNoPrefix || pdfPrefix;

    // Look up sales-contract candidates by the orderNo prefix. We fetch a
    // small window: all POs whose orderNo starts with the digits.
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
      marketCode: string;
      marketSubCode: string;
    } | undefined;
    if (orderNoPrefix) {
      const pos = await prisma.salesContractPo.findMany({
        where: { orderNo: { startsWith: orderNoPrefix + "-" } },
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
      const m = matchByOrderNoPrefix(orderNoPrefix, candidates);
      matched = m.matched;
      matchReason = m.reason;
      hydrated = m.hydrated;
    } else {
      matchReason = `bad_filename:${filenameParts.reason ?? "unknown"}`;
    }

    // Resolve the market+sub code. Priority: filename → PDF categories cell
    // (e.g. "PAW317") → Sales Contract hydration (anchor row's market).
    const marketSubFromPdf = pdfFields.categories || "";
    const marketSubCode = filenameParts.marketSubCode || marketSubFromPdf || hydrated?.marketSubCode || "";
    const marketCode =
      filenameParts.marketCode ||
      (marketSubFromPdf ? marketSubFromPdf.slice(0, 2) : "") ||
      hydrated?.marketCode || "";

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
      // Market+Sub = country code + sub (e.g. "AUW118" / "PAW317"); Market =
      // country code alone (e.g. "AU" / "PA"). Resolution priority defined
      // above: filename → PDF Categories cell → Sales Contract hydration.
      marketCode,
      marketSubCode,
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
      expectedDelivery: pdfFields.expectedDelivery,
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

/**
 * Lookup a row that already owns a given invoiceNo. Used to enforce the global
 * uniqueness rule: an invoice number may appear on at most one
 * ShipmentScheduleRow across every schedule + cut-off (user spec 2026-10-28).
 *
 * Returns null when the number is free (including when it's blank — "" is
 * never considered a duplicate because many rows start without a number).
 */
export async function findRowOwningInvoiceNo(
  invoiceNo: string,
  excludeRowId?: string,
): Promise<
  | {
      rowId: string;
      scheduleId: string;
      weekTitle: string;
      cutoffLabel: string;
      orderNo: string;
    }
  | null
> {
  const trimmed = (invoiceNo ?? "").trim();
  if (!trimmed) return null;
  const owner = await prisma.shipmentScheduleRow.findFirst({
    where: {
      invoiceNo: trimmed,
      ...(excludeRowId ? { NOT: { id: excludeRowId } } : {}),
    },
    include: {
      schedule: { select: { weekTitle: true } },
      cutoff: { select: { label: true } },
    },
  });
  if (!owner) return null;
  return {
    rowId: owner.id,
    scheduleId: owner.scheduleId,
    weekTitle: owner.schedule.weekTitle,
    cutoffLabel: owner.cutoff.label,
    orderNo: owner.orderNo,
  };
}

/**
 * Allocate sequential invoice numbers across every row of this week's
 * schedule. Numbering runs cut-off by cut-off (sortOrder ascending), then row
 * by row (createdAt ascending). Example: start=2000 with a week whose 1st
 * cut-off has 6 rows and 2nd cut-off has 4 rows produces 2000..2005 on the
 * 1st cut-off, 2006..2009 on the 2nd.
 *
 * Every row is OVERWRITTEN (no "skip when already set"), because the user's
 * flow is "I'm numbering this week from X" — if they want to protect one row
 * they can edit it afterwards. Change history is recorded in
 * ShipmentScheduleRowEdit so the previous value stays auditable.
 *
 * Globally-unique precheck: before writing anything, the full target range
 * [start .. start+N-1] is checked against every OTHER schedule. If any number
 * in the range already lives on a row outside this schedule, the whole
 * allocation aborts (no partial writes). This upholds the invariant that one
 * invoice number appears on at most one row across every week + cut-off.
 */
export async function allocateInvoiceNumbers(opts: {
  scheduleId: string;
  startNumber: number;
  actor: string;
}): Promise<{
  updated: number;
  firstAssigned: string;
  lastAssigned: string;
}> {
  const { scheduleId, actor } = opts;
  const start = Math.floor(opts.startNumber);
  if (!Number.isFinite(start) || start < 0) {
    throw new Error("Starting invoice number must be a non-negative integer.");
  }
  const cutoffs = await prisma.shipmentScheduleCutoff.findMany({
    where: { scheduleId },
    orderBy: { sortOrder: "asc" },
    include: { rows: { orderBy: { createdAt: "asc" } } },
  });
  // Flatten to [row, row, …] in the exact order the user asked for.
  const flat = cutoffs.flatMap((c) => c.rows);
  if (flat.length === 0) {
    return { updated: 0, firstAssigned: "", lastAssigned: "" };
  }

  // Pre-check: no number in the target range may already live on a row of
  // ANOTHER schedule. Doing this before any write keeps the allocation atomic
  // from the user's point of view (either every row updates, or none do).
  const range: string[] = [];
  for (let i = 0; i < flat.length; i++) range.push(String(start + i));
  const clashes = await prisma.shipmentScheduleRow.findMany({
    where: { invoiceNo: { in: range }, scheduleId: { not: scheduleId } },
    select: { invoiceNo: true, scheduleId: true, schedule: { select: { weekTitle: true } } },
    take: 10,
  });
  if (clashes.length > 0) {
    const sample = clashes
      .map((c) => `${c.invoiceNo} (already in “${c.schedule.weekTitle}”)`)
      .join(", ");
    throw new Error(
      `Invoice numbers must be unique across every week. These numbers are already in use: ${sample}.`,
    );
  }

  let n = start;
  for (const row of flat) {
    const next = String(n);
    if (row.invoiceNo !== next) {
      await prisma.shipmentScheduleRow.update({ where: { id: row.id }, data: { invoiceNo: next } });
      await prisma.shipmentScheduleRowEdit.create({
        data: {
          rowId: row.id,
          field: "invoiceNo",
          oldValue: row.invoiceNo,
          newValue: next,
          reason: `Auto-allocated from ${start}`,
          editor: actor,
        },
      });
    }
    n++;
  }
  const last = String(n - 1);
  await audit({
    entityType: "shipment-schedule",
    entityId: scheduleId,
    action: "invoice.allocated",
    actor,
    data: { start: String(start), end: last, rows: flat.length },
  });
  return { updated: flat.length, firstAssigned: String(start), lastAssigned: last };
}

/** Delete a row (and its edit history). The PDF file stays on disk for audit. */
export async function deleteRow(rowId: string, actor: string): Promise<void> {
  const row = await prisma.shipmentScheduleRow.findUnique({ where: { id: rowId } });
  if (!row) return;
  await prisma.shipmentScheduleRow.delete({ where: { id: rowId } });
  await audit({ entityType: "shipment-schedule", entityId: row.scheduleId, action: "row.deleted", actor, data: { rowId, pdfFileName: row.pdfFileName } });
}
