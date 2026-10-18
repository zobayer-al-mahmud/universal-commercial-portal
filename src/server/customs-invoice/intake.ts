import { createHash } from "crypto";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { buildCustomsInvoice } from "./build";
import type { CustomsInvoiceInput } from "./types";

const MODULE = "customs-invoice";

async function loadCargoDeliveryMap(): Promise<Record<string, string>> {
  const rows = await prisma.referenceData.findMany({ where: { type: "market-consignee", active: true } });
  const map: Record<string, string> = {};
  for (const r of rows) map[r.code.toUpperCase()] = r.value;
  return map;
}

export interface CustomsInvoiceIntakeResult {
  jobId: string;
  invoiceKey: string;
  duplicate: boolean;
  status: string;
  totalQty: number;
  totalValue: number;
  reviewTicketCount: number;
}

/**
 * Build and persist one customs invoice as a job + CustomsInvoice record.
 * Fail-closed on hard validation failures (no invoice persisted path that writes
 * a consequential document; stays queued for review).
 */
export async function intakeCustomsInvoice(
  input: CustomsInvoiceInput,
  opts: { actor?: string } = {},
): Promise<CustomsInvoiceIntakeResult> {
  const actor = opts.actor ?? "system";
  const cargoDeliveryByMarket = await loadCargoDeliveryMap();
  const doc = buildCustomsInvoice(input, { cargoDeliveryByMarket });

  const hash = createHash("sha256").update(JSON.stringify(input), "utf8").digest("hex");
  const existing = await prisma.sourceDocument.findUnique({ where: { sha256: hash } });
  if (existing?.jobId) {
    const job = await prisma.job.findUnique({ where: { id: existing.jobId } });
    return {
      jobId: existing.jobId,
      invoiceKey: doc.invoiceKey,
      duplicate: true,
      status: job?.status ?? "duplicate",
      totalQty: doc.totalQty,
      totalValue: doc.totalValue,
      reviewTicketCount: 0,
    };
  }

  const status = doc.success ? "draft" : "queued";

  const job = await prisma.job.create({
    data: {
      module: MODULE,
      type: "customs-invoice",
      businessKey: doc.invoiceKey,
      status: "received",
      payloadJson: JSON.stringify({ invoiceKey: doc.invoiceKey, contractNo: doc.contractNo }),
      resultJson: JSON.stringify({ totalQty: doc.totalQty, totalValue: doc.totalValue }),
    },
  });

  await prisma.sourceDocument.create({
    data: {
      jobId: job.id,
      kind: "invoice-input",
      originalName: `customs-invoice-${doc.invoiceKey}.json`,
      sha256: hash,
      sizeBytes: Buffer.byteLength(JSON.stringify(input)),
      mimeDetected: "application/json",
      storagePath: `./var/storage/customs-invoice/${job.id}`,
      metadataJson: JSON.stringify({ invoiceKey: doc.invoiceKey }),
    },
  });

  await prisma.jobStageEvent.create({
    data: { jobId: job.id, stage: "classified", status: "ok", message: `Invoice ${doc.invoiceKey}; ${doc.lineItems.length} line item(s)` },
  });

  if (doc.success) {
    await prisma.customsInvoice.create({
      data: {
        jobId: job.id,
        invoiceNumber: doc.invoiceNumber,
        marketCode: doc.marketCode,
        invoiceKey: doc.invoiceKey,
        invoiceDate: doc.invoiceDate,
        contractNo: doc.contractNo,
        contractDate: doc.contractDate,
        hmOrderNo: doc.hmOrderNo,
        expNo: doc.expNo,
        expDate: doc.expDate,
        portOfLoading: doc.portOfLoading,
        portOfDelivery: doc.portOfDelivery,
        countryOfOrigin: doc.countryOfOrigin,
        countryOfFinalDestination: doc.countryOfFinalDestination,
        exporterName: doc.exporterName,
        buyerName: doc.buyerName,
        consigneeName: doc.consigneeName,
        cargoDeliveryName: doc.cargoDeliveryName,
        currency: doc.currency,
        totalQty: doc.totalQty,
        totalValue: doc.totalValue,
        lineItemsJson: JSON.stringify(doc.lineItems),
        status: "draft",
        message: doc.issues.map((i) => i.code).join("; "),
      },
    });
  }

  const seen = new Set<string>();
  let reviewTicketCount = 0;
  for (const issue of doc.issues) {
    const key = issue.code + issue.message;
    if (seen.has(key)) continue;
    seen.add(key);
    await prisma.reviewTicket.create({
      data: {
        jobId: job.id,
        module: MODULE,
        reasonCode: issue.code,
        reason: `${issue.field}: ${issue.message}`,
        contextJson: JSON.stringify({ severity: issue.severity }),
      },
    });
    reviewTicketCount++;
  }

  await prisma.jobStageEvent.create({
    data: {
      jobId: job.id,
      stage: "reconciled",
      status: doc.success ? "ok" : "failed",
      message: doc.success ? `Invoice drafted; total ${doc.currency} ${doc.totalValue}` : "Hard failure(s); routed to review",
    },
  });

  await prisma.job.update({ where: { id: job.id }, data: { status } });
  await audit({ entityType: "job", entityId: job.id, action: "customs-invoice.built", actor, data: { invoiceKey: doc.invoiceKey, status, totalValue: doc.totalValue } });

  return {
    jobId: job.id,
    invoiceKey: doc.invoiceKey,
    duplicate: false,
    status,
    totalQty: doc.totalQty,
    totalValue: doc.totalValue,
    reviewTicketCount,
  };
}
