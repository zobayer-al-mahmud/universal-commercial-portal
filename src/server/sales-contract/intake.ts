import { createHash } from "crypto";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";
import { writeSalesContractRow } from "@/server/integrations/ucp-adapter";
import { runPipeline, type PipelineOptions } from "./pipeline";
import type { OrderPackageInput } from "./types";

const MODULE = "sales-contract";

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function canonical(input: OrderPackageInput): string {
  return JSON.stringify({
    subject: input.subject.trim(),
    attachments: [...(input.attachments ?? [])].sort(),
    poText: input.poText ?? "",
  });
}

export interface IntakeResult {
  jobId: string;
  status: string;
  duplicate: boolean;
  orderNumbers: string[];
  reviewTicketCount: number;
  contractRowCount: number;
  ucpMessages: string[];
}

/**
 * Persist an Order Package intake end to end (SRS §B.1).
 * Idempotent on the content hash (SC-FR-016): a replayed identical package
 * creates no new job and no new rows.
 */
export async function intakeOrderPackage(
  input: OrderPackageInput,
  opts: { actor?: string; pipeline?: PipelineOptions } = {},
): Promise<IntakeResult> {
  const actor = opts.actor ?? "system";
  const hash = sha256(canonical(input));

  // Idempotency: same content hash already processed -> skip (BR-SC-22).
  const existingDoc = await prisma.sourceDocument.findUnique({ where: { sha256: hash } });
  if (existingDoc?.jobId) {
    const job = await prisma.job.findUnique({ where: { id: existingDoc.jobId } });
    await audit({
      entityType: "job",
      entityId: existingDoc.jobId,
      action: "intake.duplicate",
      actor,
      data: { hash },
    });
    return {
      jobId: existingDoc.jobId,
      status: job?.status ?? "duplicate",
      duplicate: true,
      orderNumbers: [],
      reviewTicketCount: 0,
      contractRowCount: 0,
      ucpMessages: ["Duplicate intake: identical content hash already processed."],
    };
  }

  const result = runPipeline(input, opts.pipeline);
  const businessKey = result.orderNumbers.join(",") || null;

  const job = await prisma.job.create({
    data: {
      module: MODULE,
      type: "order-package",
      businessKey,
      status: "received",
      payloadJson: JSON.stringify({ subject: input.subject, blockContractRef: input.blockContractRef }),
    },
  });

  await prisma.sourceDocument.create({
    data: {
      jobId: job.id,
      kind: "msg",
      originalName: input.subject.slice(0, 180),
      sha256: hash,
      sizeBytes: Buffer.byteLength(canonical(input)),
      mimeDetected: "application/vnd.ms-outlook",
      storagePath: `${env.STORAGE_ROOT}/sales-contract/${job.id}`,
      metadataJson: JSON.stringify({ attachments: input.attachments ?? [], sender: input.sender }),
    },
  });

  await stage(job.id, "received", "ok", `OrderNos: ${result.orderNumbers.join(", ") || "none"}`);
  await stage(job.id, "classified", "ok", `Attachments present: ${result.attachmentCheck.present.join(", ") || "none"}`);

  // Persist PO EXTRACTION rows (§C.2.1) — append only, including failed rows with reason.
  let sl = 1;
  for (const vr of result.poRows) {
    const r = vr.row;
    await prisma.poExtractionRow.create({
      data: {
        jobId: job.id,
        sl: sl++,
        dateOfOrder: r.dateOfOrder,
        orderNo: r.orderNo || "UNKNOWN",
        productNo: r.productNo,
        productName: r.productName,
        productDescription: r.productDescription,
        season: r.season,
        customsCustomerGroup: r.customsCustomerGroup,
        typeOfConstruction: r.typeOfConstruction,
        noOfPieces: r.noOfPieces,
        invoiceAveragePrice: r.invoiceAveragePrice,
        currency: r.currency,
        timeOfDelivery: r.timeOfDelivery,
        planningMarketA: r.planningMarketA,
        planningMarketB: r.planningMarketB,
        quantity: r.quantity,
        termsOfDelivery: r.termsOfDelivery,
        transportBy: r.transportBy,
        source: input.sender ?? "manual-intake",
        message: vr.issues.map((i) => `${i.code}:${i.field}`).join("; "),
        success: vr.success,
      },
    });
  }
  await stage(job.id, "extracted", "ok", `${result.poRows.length} PO row(s)`);

  // Create review tickets (dedup by code) for every review reason.
  const seen = new Set<string>();
  let reviewTicketCount = 0;
  for (const rr of result.reviewReasons) {
    if (seen.has(rr.code + rr.reason)) continue;
    seen.add(rr.code + rr.reason);
    await prisma.reviewTicket.create({
      data: {
        jobId: job.id,
        module: MODULE,
        reasonCode: rr.code,
        reason: rr.reason,
        contextJson: JSON.stringify({ severity: rr.severity }),
      },
    });
    reviewTicketCount++;
  }

  const ucpMessages: string[] = [];
  let contractRowCount = 0;

  if (result.outcome === "queued") {
    await stage(job.id, "reconciled", "failed", "Hard failure(s): routed to review queue");
    await setStatus(job.id, "queued", actor);
    ucpMessages.push("Blocked by hard validation failure(s); no contract rows written; no UCP write.");
  } else {
    // Persist draft per-contract rows (§C.2.2), append-only.
    const blockRef = input.blockContractRef ?? "AGL/H&M/99/2026";
    const nn = blockRef.match(/AGL\/H&M\/(\d{2,3})\//)?.[1] ?? "99";
    const yyyy = blockRef.match(/\/(\d{4})$/)?.[1] ?? "2026";
    const commercialRef = `AGL/H&M/${nn}-A/${yyyy}`;
    const revision = input.revision ?? 1;

    for (const cr of result.contractRows) {
      await prisma.salesContractRow.create({
        data: {
          jobId: job.id,
          blockContractRef: blockRef,
          commercialContRef: commercialRef,
          revision,
          orderNo: cr.orderNo,
          styleNo: cr.styleNo,
          description: cr.description,
          orderQty: cr.orderQty,
          totalQtyWithPackSet: cr.totalQtyWithPackSet,
          unitPrice: cr.unitPrice,
          value: cr.value,
          timeOfDelivery: cr.timeOfDelivery,
          packSet: cr.packSet,
          remarks: cr.issues.length ? "Pending business decision; see review queue" : "",
        },
      });
      contractRowCount++;

      // UCP adapter: save-as-draft only (never auto-submit unless approved).
      const submit = env.AUTO_SUBMIT && reviewTicketCount === 0;
      const ucp = await writeSalesContractRow({
        blockContractRef: blockRef,
        commercialContRef: commercialRef,
        row: cr,
        submit,
      });
      ucpMessages.push(ucp.message);
      await stage(job.id, "portal", ucp.state === "error" ? "failed" : "ok", ucp.message, {
        destinationRef: ucp.destinationRef,
        verified: ucp.verified,
        mode: ucp.mode,
      });
    }

    await stage(job.id, "reconciled", "ok", `${contractRowCount} contract row(s) drafted`);
    await setStatus(job.id, "draft", actor);
  }

  await audit({
    entityType: "job",
    entityId: job.id,
    action: "intake.processed",
    actor,
    data: { outcome: result.outcome, orderNumbers: result.orderNumbers, reviewTicketCount },
  });

  const finalJob = await prisma.job.findUnique({ where: { id: job.id } });
  return {
    jobId: job.id,
    status: finalJob?.status ?? result.outcome,
    duplicate: false,
    orderNumbers: result.orderNumbers,
    reviewTicketCount,
    contractRowCount,
    ucpMessages,
  };
}

async function stage(
  jobId: string,
  stageName: string,
  status: string,
  message?: string,
  data?: Record<string, unknown>,
) {
  await prisma.jobStageEvent.create({
    data: { jobId, stage: stageName, status, message, dataJson: JSON.stringify(data ?? {}) },
  });
}

async function setStatus(jobId: string, status: string, actor: string) {
  await prisma.job.update({ where: { id: jobId }, data: { status } });
  await audit({ entityType: "job", entityId: jobId, action: `status.${status}`, actor });
}
