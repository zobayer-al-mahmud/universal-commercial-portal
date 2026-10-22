import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";

/**
 * Cross-module workflow services. Shipment-schedule and invoice-from-line
 * handoffs were removed on 2026-10-20 while the Week-wise Shipment Schedule
 * module is being rebuilt from scratch. Only Sales Contract confirmation
 * remains here.
 */

/** Confirm (approve) a Sales Contract job. */
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
  await prisma.jobStageEvent.create({ data: { jobId, stage: "confirmed", status: "ok", message: "Contract confirmed", actor } });
  await audit({ entityType: "contract", entityId: jobId, action: "contract.confirmed", actor, data: { rows: job.contractRows.length } });
  return { ok: true, message: `Confirmed ${job.contractRows.length} contract row(s).` };
}
