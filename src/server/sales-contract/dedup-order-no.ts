/**
 * Cross-contract order-no deduplication (user rule 2026-10-28).
 *
 * An Order No must belong to exactly ONE Sales Contract. Re-extracting the
 * same Order No PDFs onto a different Sales Contract is rejected: the user
 * must FIRST manually move the existing PO with `reassignPoToContract`
 * (config-intake.ts), then re-upload.
 *
 * Pure: no I/O beyond the Prisma lookup the caller runs.
 */
import { prisma } from "@/lib/db";

export interface OrderNoDedupConflict {
  orderNo: string;
  conflictingPoId: string;
  conflictingContractId: string;
  conflictingContractNo: string; // e.g. "97" / "AGL/H&M/96/2026"
  message: string;
}

/**
 * Returns a conflict record when `orderNo` already belongs to a different
 * Sales Contract; returns null when the order-no is free or already owned by
 * `targetContractId` (the caller is adding/updating within its own contract).
 *
 * `orderNo` is normalised (trim + uppercase); empty / "pending-..." sentinels
 * never conflict (they identify an unextracted upload).
 */
export async function checkOrderNoConflict(
  orderNo: string,
  targetContractId: string,
): Promise<OrderNoDedupConflict | null> {
  const normalised = String(orderNo || "").trim();
  if (!normalised) return null;
  if (normalised.startsWith("pending-")) return null;

  const existing = await prisma.salesContractPo.findFirst({
    where: { orderNo: normalised, contractId: { not: targetContractId } },
    include: { contract: { select: { contractNo: true, id: true } } },
    orderBy: { createdAt: "asc" },
  });
  if (!existing) return null;

  return {
    orderNo: normalised,
    conflictingPoId: existing.id,
    conflictingContractId: existing.contractId,
    conflictingContractNo: existing.contract?.contractNo || "",
    message:
      `Order No ${normalised} is already extracted on Sales Contract ` +
      `${existing.contract?.contractNo || existing.contractId}. ` +
      `Move that PO to this contract first before re-uploading (manual move only).`,
  };
}
