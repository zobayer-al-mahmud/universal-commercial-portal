import { createHash } from "crypto";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { parseWeekTitle } from "@/server/shipment-schedule/schedule";
import { persistSchedule } from "@/server/shipment-schedule/intake";
import { intakeCustomsInvoice } from "@/server/customs-invoice/intake";
import { contractRowToOrder, scheduleLineToInvoice } from "./map";

/**
 * Cross-module workflow services (Milestone E). Enforce that a downstream step
 * only consumes confirmed/verified upstream data, and record the handoff links.
 */

/** Confirm (approve) a Sales Contract job: gates it for downstream scheduling. */
export async function confirmContractJob(jobId: string, actor: string): Promise<{ ok: boolean; message: string }> {
  const job = await prisma.job.findUnique({ where: { id: jobId }, include: { reviewTickets: true, contractRows: true } });
  if (!job || job.module !== "sales-contract") return { ok: false, message: "Not a Sales Contract job." };
  if (job.status === "confirmed") return { ok: false, message: "Already confirmed." };
  if (job.status !== "draft") return { ok: false, message: `Only draft jobs can be confirmed (status: ${job.status}).` };
  if (job.reviewTickets.some((t) => t.status === "open"))
    return { ok: false, message: "Resolve all open review tickets before confirming." };
  if (job.contractRows.length === 0) return { ok: false, message: "No contract rows to confirm." };

  await prisma.salesContractRow.updateMany({ where: { jobId }, data: { confirmed: true } });
  await prisma.job.update({ where: { id: jobId }, data: { status: "confirmed" } });
  await prisma.jobStageEvent.create({ data: { jobId, stage: "confirmed", status: "ok", message: "Contract confirmed for scheduling", actor } });
  await audit({ entityType: "contract", entityId: jobId, action: "contract.confirmed", actor, data: { rows: job.contractRows.length } });
  return { ok: true, message: `Confirmed ${job.contractRows.length} contract row(s).` };
}

export interface SchedulableContract {
  id: string;
  orderNo: string;
  styleNo: string;
  orderQty: number;
  unitPrice: number;
  blockContractRef: string;
  markets: string[];
}

/** Confirmed contract rows not yet scheduled, with their PO-extraction markets. */
export async function listSchedulableContracts(): Promise<SchedulableContract[]> {
  const rows = await prisma.salesContractRow.findMany({
    where: { confirmed: true, scheduledJobId: null },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  const out: SchedulableContract[] = [];
  for (const r of rows) {
    const poRows = await prisma.poExtractionRow.findMany({ where: { jobId: r.jobId, orderNo: r.orderNo } });
    const markets = [...new Set(poRows.map((p) => p.planningMarketA).filter((m): m is string => !!m))];
    out.push({ id: r.id, orderNo: r.orderNo, styleNo: r.styleNo, orderQty: r.orderQty, unitPrice: r.unitPrice, blockContractRef: r.blockContractRef, markets });
  }
  return out;
}

/** Handoff 1: build a week schedule from selected confirmed contract rows. */
export async function buildScheduleFromContracts(
  weekTitle: string,
  rowIds: string[],
  opts: { actor?: string; invoiceStart?: number } = {},
): Promise<{ jobId: string; weekNo: number; lines: number; status: string }> {
  const actor = opts.actor ?? "system";
  const week = parseWeekTitle(weekTitle);
  if (!week) throw new Error(`Could not parse week title: "${weekTitle}"`);
  if (rowIds.length === 0) throw new Error("Select at least one confirmed contract.");

  const rows = await prisma.salesContractRow.findMany({ where: { id: { in: rowIds }, confirmed: true, scheduledJobId: null } });
  if (rows.length === 0) throw new Error("No eligible (confirmed, unscheduled) contract rows selected.");

  const orders = [];
  for (const r of rows) {
    const poRows = await prisma.poExtractionRow.findMany({ where: { jobId: r.jobId, orderNo: r.orderNo } });
    const markets = [...new Set(poRows.map((p) => p.planningMarketA).filter((m): m is string => !!m))];
    orders.push(contractRowToOrder(
      { orderNo: r.orderNo, styleNo: r.styleNo, description: r.description, orderQty: r.orderQty, unitPrice: r.unitPrice, blockContractRef: r.blockContractRef, timeOfDelivery: r.timeOfDelivery },
      markets,
    ));
  }

  const hash = createHash("sha256").update(`contracts:${rowIds.sort().join(",")}:${weekTitle}`, "utf8").digest("hex");
  const res = await persistSchedule(week, orders, {
    actor,
    invoiceStart: opts.invoiceStart,
    sourceName: `schedule-from-contracts-${rowIds.length}.json`,
    sourceKind: "contract-handoff",
    sourceHash: hash,
  });

  // Link the contract rows to the schedule job (prevents double-scheduling).
  await prisma.salesContractRow.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { scheduledJobId: res.jobId } });
  await audit({ entityType: "job", entityId: res.jobId, action: "schedule.from-contracts", actor, data: { contractRowIds: rows.map((r) => r.id) } });

  return { jobId: res.jobId, weekNo: res.weekNo, lines: res.summary.lines, status: res.status };
}

export interface InvoiceableLine {
  id: string;
  invoiceNo: string;
  marketCode: string;
  orderNo: string;
  style: string;
  pcs: number;
  fob: number;
  contractNo: string;
}

/** Schedule lines with an allocated invoice number not yet turned into an invoice. */
export async function listInvoiceableScheduleLines(): Promise<InvoiceableLine[]> {
  const lines = await prisma.shipmentScheduleLine.findMany({
    where: { invoicedJobId: null, success: true, NOT: { invoiceNo: "" } },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  return lines.map((l) => ({ id: l.id, invoiceNo: l.invoiceNo, marketCode: l.marketCode, orderNo: l.orderNo, style: l.style, pcs: l.pcs, fob: l.fob, contractNo: l.contractNo }));
}

/** Handoff 2: generate a customs invoice from a schedule line. */
export async function generateInvoiceFromLine(
  lineId: string,
  actor: string,
): Promise<{ jobId: string; invoiceKey: string; status: string }> {
  const line = await prisma.shipmentScheduleLine.findUnique({ where: { id: lineId } });
  if (!line) throw new Error("Schedule line not found.");
  if (line.invoicedJobId) throw new Error("This line already has a customs invoice.");
  if (!line.invoiceNo) throw new Error("Line has no invoice number.");

  const input = scheduleLineToInvoice({
    invoiceNo: line.invoiceNo,
    marketCode: line.marketCode,
    contractNo: line.contractNo,
    contractDate: line.contractDate,
    orderNo: line.orderNo,
    style: line.style,
    composition: line.composition,
    pcs: line.pcs,
    fob: line.fob,
  });

  const res = await intakeCustomsInvoice(input, { actor });
  await prisma.shipmentScheduleLine.update({ where: { id: lineId }, data: { invoicedJobId: res.jobId } });
  await audit({ entityType: "job", entityId: res.jobId, action: "invoice.from-schedule-line", actor, data: { lineId, invoiceKey: res.invoiceKey } });

  return { jobId: res.jobId, invoiceKey: res.invoiceKey, status: res.status };
}
