import { createHash } from "crypto";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { parseCsvRecords } from "@/lib/csv";
import { buildSchedule, parseWeekTitle } from "./schedule";
import type { ScheduleOrderInput, WeekDefinition } from "./types";

const MODULE = "shipment-schedule";

function pick(rec: Record<string, string>, keys: string[]): string {
  for (const k of keys) if (rec[k] != null && rec[k] !== "") return rec[k];
  return "";
}

function toOrders(records: Record<string, string>[]): ScheduleOrderInput[] {
  return records.map((r) => ({
    buyerCode: pick(r, ["Buyer Code", "BuyerCode"]),
    contractNo: pick(r, ["Cont.No.", "Contract No", "Cont No", "ContractNo"]),
    contractDate: pick(r, ["Date", "Contract Date"]),
    orderNo: pick(r, ["OrderNo.", "OrderNo", "Order No.", "Order No"]),
    pcs: parseInt(pick(r, ["PCS", "Pcs", "Qty"]).replace(/[^\d]/g, "") || "0", 10),
    style: pick(r, ["STYLE", "Style"]),
    fob: parseFloat(pick(r, ["FOB", "Fob"]).replace(/[^\d.]/g, "") || "0"),
    composition: pick(r, ["COMPOSITION", "Composition"]),
    incoterm: pick(r, ["CAT", "Incoterm", "Terms"]) || "FCA",
    transport: pick(r, ["HTS", "Transport"]) || "Sea",
    markets: pick(r, ["Markets", "Market", "INVOICE"])
      .split(/[|;]/)
      .map((m) => m.trim())
      .filter(Boolean),
  }));
}

export interface ScheduleIntakeResult {
  jobId: string;
  weekNo: number;
  duplicate: boolean;
  status: string;
  summary: { orders: number; lines: number; totalPcs: number; totalValue: number; invoiceFrom: string | null; invoiceTo: string | null };
  reviewTicketCount: number;
}

/**
 * Build a schedule from already-prepared orders and persist it (job + lines +
 * tickets + audit). Shared by the CSV intake and the Sales-Contract handoff.
 */
export async function persistSchedule(
  week: WeekDefinition,
  orders: ScheduleOrderInput[],
  opts: { actor?: string; invoiceStart?: number; sourceName: string; sourceKind: string; sourceHash: string },
): Promise<ScheduleIntakeResult> {
  const actor = opts.actor ?? "system";
  const result = buildSchedule(week, orders, { invoiceStart: opts.invoiceStart });

  const job = await prisma.job.create({
    data: {
      module: MODULE,
      type: "week-schedule",
      businessKey: `Week ${week.weekNo}`,
      status: "received",
      payloadJson: JSON.stringify({ week }),
      resultJson: JSON.stringify(result.summary),
    },
  });

  await prisma.sourceDocument.create({
    data: {
      jobId: job.id,
      kind: opts.sourceKind,
      originalName: opts.sourceName,
      sha256: opts.sourceHash,
      sizeBytes: Buffer.byteLength(opts.sourceName),
      mimeDetected: opts.sourceKind === "csv" ? "text/csv" : "application/json",
      storagePath: `./var/storage/shipment-schedule/${job.id}`,
      metadataJson: JSON.stringify({ week }),
    },
  });

  await prisma.jobStageEvent.create({
    data: { jobId: job.id, stage: "classified", status: "ok", message: `Week ${week.weekNo}; ${result.summary.orders} orders` },
  });

  await prisma.shipmentScheduleLine.createMany({
    data: result.lines.map((l) => ({
      jobId: job.id,
      weekNo: l.weekNo,
      firstCutOff: l.firstCutOff,
      secondCutOff: l.secondCutOff,
      buyerCode: l.buyerCode,
      contractNo: l.contractNo,
      contractDate: l.contractDate,
      orderNo: l.orderNo,
      style: l.style,
      composition: l.composition,
      incoterm: l.incoterm,
      transport: l.transport,
      pcs: l.pcs,
      fob: l.fob,
      value: l.value,
      marketCode: l.marketCode,
      invoiceNo: l.invoiceNo,
      cutOff: l.cutOff,
      message: l.issues.map((i) => `${i.code}:${i.field}`).join("; "),
      success: l.success,
    })),
  });

  const seen = new Set<string>();
  let reviewTicketCount = 0;
  for (const rr of result.reviewReasons) {
    const key = rr.code + rr.reason;
    if (seen.has(key)) continue;
    seen.add(key);
    await prisma.reviewTicket.create({
      data: { jobId: job.id, module: MODULE, reasonCode: rr.code, reason: rr.reason, contextJson: JSON.stringify({ severity: rr.severity }) },
    });
    reviewTicketCount++;
  }

  await prisma.jobStageEvent.create({
    data: {
      jobId: job.id,
      stage: "reconciled",
      status: result.outcome === "queued" ? "failed" : "ok",
      message: `${result.summary.lines} lines; invoices ${result.summary.invoiceFrom ?? "-"}..${result.summary.invoiceTo ?? "-"}`,
    },
  });

  await prisma.job.update({ where: { id: job.id }, data: { status: result.outcome } });
  await audit({ entityType: "job", entityId: job.id, action: "schedule.built", actor, data: { week, summary: result.summary, outcome: result.outcome } });

  return {
    jobId: job.id,
    weekNo: week.weekNo,
    duplicate: false,
    status: result.outcome,
    summary: result.summary,
    reviewTicketCount,
  };
}

/**
 * Ingest a week title + orders CSV, build the schedule, and persist it.
 * Idempotent on the (title + CSV) content hash.
 */
export async function intakeWeekSchedule(
  weekTitle: string,
  csvText: string,
  opts: { actor?: string; invoiceStart?: number } = {},
): Promise<ScheduleIntakeResult> {
  const week = parseWeekTitle(weekTitle);
  if (!week) throw new Error(`Could not parse week title: "${weekTitle}"`);

  const records = parseCsvRecords(csvText);
  if (records.length === 0) throw new Error("No order rows parsed from CSV.");
  const orders = toOrders(records);

  const hash = createHash("sha256").update(`${weekTitle}\n${csvText}`, "utf8").digest("hex");
  const existing = await prisma.sourceDocument.findUnique({ where: { sha256: hash } });
  if (existing?.jobId) {
    const job = await prisma.job.findUnique({ where: { id: existing.jobId } });
    return {
      jobId: existing.jobId,
      weekNo: week.weekNo,
      duplicate: true,
      status: job?.status ?? "duplicate",
      summary: { orders: records.length, lines: 0, totalPcs: 0, totalValue: 0, invoiceFrom: null, invoiceTo: null },
      reviewTicketCount: 0,
    };
  }

  return persistSchedule(week, orders, {
    actor: opts.actor,
    invoiceStart: opts.invoiceStart,
    sourceName: `${weekTitle}.csv`,
    sourceKind: "csv",
    sourceHash: hash,
  });
}
