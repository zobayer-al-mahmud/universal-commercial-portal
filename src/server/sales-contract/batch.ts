import { createHash } from "crypto";
import { mkdir, writeFile, readFile } from "fs/promises";
import { join } from "path";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { audit } from "@/lib/audit";
import { parsePdfText } from "@/server/pdf/parse-pdf";
import { classifyHmDoc, extractOrderNumbers, summariseExtraction } from "./parse";
import { runPipeline } from "./pipeline";
import type { PipelineResult } from "./types";
import {
  classifyBatchItem,
  type ExistingContractMatch,
  type SalesItemState,
} from "./batch-classify";

const MODULE = "sales-contract";

export interface UploadFile {
  name: string;
  buffer: Buffer;
}

export interface CreateSalesBatchResult {
  batchId: string;
  accepted: number;
  rejected: { name: string; reason: string }[];
  duplicates: number;
}

function storageDir(batchId: string): string {
  return join(env.STORAGE_ROOT, "sales-contract-batch", batchId);
}

/** Anchor Job for a batch's review tickets (created lazily, idempotent). */
async function batchJobId(batchId: string, actor: string): Promise<string> {
  const businessKey = `sc-batch:${batchId}`;
  const existing = await prisma.job.findFirst({ where: { module: MODULE, businessKey } });
  if (existing) return existing.id;
  const job = await prisma.job.create({
    data: { module: MODULE, type: "sales-contract-batch", businessKey, status: "received", payloadJson: JSON.stringify({ batchId }) },
  });
  await audit({ entityType: "job", entityId: job.id, action: "sales.batch.created", actor, data: { batchId } });
  return job.id;
}

/**
 * Validate + store a batch of uploaded PO / supporting PDFs and create the batch
 * + per-item rows. Originals are written unchanged to immutable storage.
 * Duplicate files (same sha256) are skipped. Invalid files are rejected with a
 * reason; one bad file never blocks the rest (SRS §2).
 */
export async function createSalesContractBatch(
  files: UploadFile[],
  opts: { blockRef?: string; actor?: string } = {},
): Promise<CreateSalesBatchResult> {
  const actor = opts.actor ?? "system";
  const blockRef = (opts.blockRef ?? "").trim();

  const rejected: { name: string; reason: string }[] = [];
  const maxBytes = env.SALES_MAX_FILE_MB * 1024 * 1024;

  const valid: { file: UploadFile; sha256: string }[] = [];
  const seenInBatch = new Set<string>();
  let duplicates = 0;

  for (const f of files) {
    if (!/\.pdf$/i.test(f.name)) {
      rejected.push({ name: f.name, reason: "Not a .pdf file." });
      continue;
    }
    if (f.buffer.length === 0) {
      rejected.push({ name: f.name, reason: "Empty file." });
      continue;
    }
    if (f.buffer.length > maxBytes) {
      rejected.push({ name: f.name, reason: `Exceeds ${env.SALES_MAX_FILE_MB} MB limit.` });
      continue;
    }
    if (f.buffer.subarray(0, 4).toString("latin1") !== "%PDF") {
      rejected.push({ name: f.name, reason: "File is not a valid PDF (missing %PDF header)." });
      continue;
    }
    const sha256 = createHash("sha256").update(f.buffer).digest("hex");
    if (seenInBatch.has(sha256)) {
      duplicates++;
      continue;
    }
    seenInBatch.add(sha256);
    valid.push({ file: f, sha256 });
  }

  if (valid.length === 0) {
    throw new Error(rejected.length ? `No valid PDFs: ${rejected.map((r) => `${r.name} (${r.reason})`).join("; ")}` : "No files supplied.");
  }
  if (valid.length > env.SALES_MAX_FILES) {
    throw new Error(`Too many files: ${valid.length} exceeds the limit of ${env.SALES_MAX_FILES}.`);
  }

  const batch = await prisma.salesContractBatch.create({
    data: { createdBy: actor, blockRef, totalItems: valid.length, status: "uploaded" },
  });

  const dir = storageDir(batch.id);
  await mkdir(dir, { recursive: true });

  let serial = 0;
  for (const { file, sha256 } of valid) {
    serial++;
    const safeName = file.name.replace(/[^\w.\- ]+/g, "_");
    const storagePath = join(dir, `${serial.toString().padStart(3, "0")}__${safeName}`);
    await writeFile(storagePath, file.buffer); // original preserved, never modified
    await prisma.salesContractBatchItem.create({
      data: {
        batchId: batch.id,
        serial,
        originalName: file.name,
        sha256,
        sizeBytes: file.buffer.length,
        storagePath,
        state: "UPLOADED" satisfies SalesItemState,
      },
    });
  }

  await batchJobId(batch.id, actor);
  await audit({ entityType: "job", entityId: batch.id, action: "sales.batch.uploaded", actor, data: { accepted: valid.length, rejected: rejected.length, duplicates } });

  return { batchId: batch.id, accepted: valid.length, rejected, duplicates };
}

/** Find existing contract register rows matching any of the given OrderNos. */
async function findExistingContracts(orderNumbers: string[]): Promise<ExistingContractMatch[]> {
  if (orderNumbers.length === 0) return [];
  const rows = await prisma.salesContractRow.findMany({
    where: { orderNo: { in: orderNumbers } },
    select: { orderNo: true, blockContractRef: true, commercialContRef: true, confirmed: true },
  });
  return rows.map((r) => ({
    orderNo: r.orderNo,
    blockContractRef: r.blockContractRef,
    commercialContRef: r.commercialContRef,
    confirmed: r.confirmed,
  }));
}

/**
 * Process ONE batch item: extract → cross-match → classify. Idempotent — an item
 * already in a terminal state is left untouched unless `force`. A thrown error
 * is recorded as FAILED so one file never aborts the batch (SRS §2, AC-12).
 */
export async function processSalesBatchItem(
  itemId: string,
  opts: { actor?: string; force?: boolean; seenOrderNos?: Set<string> } = {},
): Promise<SalesItemState> {
  const actor = opts.actor ?? "system";
  const item = await prisma.salesContractBatchItem.findUnique({ where: { id: itemId }, include: { batch: true } });
  if (!item) throw new Error("Batch item not found.");
  const TERMINAL: SalesItemState[] = ["DRAFTED", "DUPLICATE"];
  if (TERMINAL.includes(item.state as SalesItemState) && !opts.force) return item.state as SalesItemState;

  const setState = async (state: SalesItemState, patch: Record<string, unknown> = {}) => {
    await prisma.salesContractBatchItem.update({ where: { id: itemId }, data: { state, ...patch } });
  };

  try {
    await prisma.salesContractBatchItem.update({ where: { id: itemId }, data: { attempts: { increment: 1 }, error: "", warning: "" } });
    await setState("EXTRACTING");

    const buffer = await readFile(item.storagePath);
    // An unreadable / encrypted / scanned PDF must not hard-fail the item: treat
    // it as empty text and let the scanned/NEEDS_REVIEW path handle it (mirrors
    // the booking extractor). Never invent values from a document we cannot read.
    let text = "";
    try {
      const parsed = await parsePdfText(buffer);
      text = parsed.text ?? "";
    } catch {
      text = "";
    }
    const textChars = text.replace(/\s+/g, "").length;

    // OrderNos: from the embedded text AND the filename (BR-SC-19). Never invented.
    const orderNumbers = [...new Set([...extractOrderNumbers(text), ...extractOrderNumbers(item.originalName)])];

    // Classify the PDF kind so a Size / Country breakdown never gets pushed
    // through the PO parser (which would emit a misleading SCHEMA_DRIFT —
    // see docs/modules/hm-sales-contract.md). We still produce a rich field
    // extraction summary for the UI even when the document cannot by itself
    // draft a Sales Contract row.
    const kind = classifyHmDoc(text, item.originalName);
    const extractionSummary = summariseExtraction(text, item.originalName);

    // The PO pipeline is only meaningful for Purchase Order PDFs. For a known
    // Size or Country breakdown we skip it and emit an honest reason instead
    // of running a regex against the wrong document shape.
    const subject = [item.originalName, orderNumbers.join(", ")].filter(Boolean).join(" ");
    const pipeline: PipelineResult =
      kind === "SizePerColourBreakdown" || kind === "TotalCountryBreakdown"
        ? {
            orderNumbers,
            attachmentCheck: { expected: [], present: [kind], missing: [], ok: true },
            poRows: [],
            contractRows: [],
            reviewReasons: [
              {
                code: "NOT_A_PURCHASE_ORDER",
                reason:
                  kind === "SizePerColourBreakdown"
                    ? "This PDF is a Size / Colour Breakdown — upload it with the Purchase Order and the Total Country Breakdown via the H&M Sales Contract workflow at /hm-sales-contract."
                    : "This PDF is a Total Country Breakdown — upload it with the Purchase Order and the Size / Colour Breakdown via the H&M Sales Contract workflow at /hm-sales-contract.",
                severity: "hard",
              },
            ],
            outcome: "queued",
          }
        : runPipeline(
            { subject, poText: text, attachments: [item.originalName] },
            { skipAttachmentCheck: true },
          );

    const jobId = await batchJobId(item.batchId, actor);
    // Persist PO EXTRACTION rows for this item (append-only, incl. failed rows).
    let sl = 0;
    for (const vr of pipeline.poRows) {
      sl++;
      const r = vr.row;
      await prisma.poExtractionRow.create({
        data: {
          jobId,
          sl,
          orderNo: r.orderNo || "UNKNOWN",
          productNo: r.productNo,
          productName: r.productName,
          season: r.season,
          noOfPieces: r.noOfPieces,
          invoiceAveragePrice: r.invoiceAveragePrice,
          currency: r.currency,
          timeOfDelivery: r.timeOfDelivery,
          planningMarketA: r.planningMarketA,
          planningMarketB: r.planningMarketB,
          quantity: r.quantity,
          source: `batch:${item.batchId}:${item.originalName}`,
          message: vr.issues.map((i) => `${i.code}:${i.field}`).join("; "),
          success: vr.success,
        },
      });
    }

    const extractionJson = JSON.stringify({
      // Rich, human-readable summary for the batch UI (see
      // src/app/(portal)/sales-contract/[batchId]/page.tsx). This is what the
      // "Show extracted fields" expander renders.
      kind,
      summary: extractionSummary,
      // Pipeline-shape data retained for existing consumers.
      orderNumbers,
      poRowCount: pipeline.poRows.length,
      contractRows: pipeline.contractRows.map((c) => ({ orderNo: c.orderNo, orderQty: c.orderQty, value: c.value, unitPrice: c.unitPrice })),
      reviewReasons: pipeline.reviewReasons,
      textChars,
    });
    await setState("EXTRACTED", {
      jobId,
      orderNumbers: orderNumbers.join(","),
      poRowCount: pipeline.poRows.length,
      textChars,
      extractionJson,
    });

    // Scanned / empty PDF: no text could be read → route to review, never guess.
    if (textChars < 40 && orderNumbers.length === 0) {
      await setState("NEEDS_REVIEW", {
        decision: "NEEDS_REVIEW",
        blockWrite: true,
        reasons: "The PDF yielded little or no embedded text (likely scanned) and no OrderNo in the filename — OCR / manual entry required. NOT EXTRACTED.",
        processedAt: new Date(),
      });
      await raiseReview(jobId, actor, "SCANNED_PDF_OCR_REQUIRED", `${item.originalName}: no embedded text; OCR required.`, item.serial, item.originalName);
      await recomputeSalesBatch(item.batchId);
      return "NEEDS_REVIEW";
    }

    // --- CROSS_MATCHING + classification (§3.2) ---------------------------
    await setState("CROSS_MATCHING");
    const existingMatches = await findExistingContracts(orderNumbers);
    const result = classifyBatchItem({
      orderNumbers,
      pipelineOutcome: pipeline.outcome,
      hasPoRows: pipeline.poRows.some((r) => r.success),
      reviewReasons: pipeline.reviewReasons,
      existingMatches,
      numberingRuleResolved: env.SALES_AUTO_CREATE,
      seenOrderNosInBatch: opts.seenOrderNos ? [...opts.seenOrderNos] : [],
    });

    // Record this item's OrderNos so later items in the same batch see duplicates.
    if (opts.seenOrderNos) for (const o of orderNumbers) opts.seenOrderNos.add(o);

    // Raise review tickets for items that need human disposition.
    if (["NEEDS_REVIEW", "BLOCKED", "DUPLICATE"].includes(result.state)) {
      await raiseReview(jobId, actor, result.decision, `${item.originalName}: ${result.reasons[0] ?? result.decision}`, item.serial, item.originalName);
    }

    await setState(result.state, {
      decision: result.decision,
      targetContractRef: result.targetContractRef,
      buyerCode: result.buyerCode,
      proposed: result.proposed,
      blockWrite: result.blockWrite,
      reasons: result.reasons.join("\n"),
      warning: result.state === "DRAFTED" ? "" : result.reasons[0] ?? "",
      processedAt: new Date(),
    });
    await audit({ entityType: "document", entityId: itemId, action: "sales.item.classified", actor, data: { decision: result.decision, state: result.state, orderNumbers } });
    await recomputeSalesBatch(item.batchId);
    return result.state;
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown processing error.";
    await prisma.salesContractBatchItem.update({ where: { id: itemId }, data: { state: "FAILED", error: message, processedAt: new Date() } });
    await recomputeSalesBatch(item.batchId);
    return "FAILED";
  }
}

async function raiseReview(jobId: string, actor: string, code: string, reason: string, serial: number, name: string) {
  await prisma.reviewTicket.create({
    data: { jobId, module: MODULE, reasonCode: code, reason: `Item #${serial} (${name}): ${reason}`, contextJson: JSON.stringify({ serial }) },
  });
}

const DRAFT_STATES: SalesItemState[] = ["DRAFTED"];
const REVIEW_STATES: SalesItemState[] = ["NEEDS_REVIEW", "DUPLICATE"];
const BLOCK_STATES: SalesItemState[] = ["BLOCKED"];
const FAIL_STATES: SalesItemState[] = ["FAILED"];

/** Recompute batch-level counters + status from its items. */
export async function recomputeSalesBatch(batchId: string): Promise<void> {
  const items = await prisma.salesContractBatchItem.findMany({ where: { batchId }, select: { state: true } });
  const drafted = items.filter((d) => DRAFT_STATES.includes(d.state as SalesItemState)).length;
  const review = items.filter((d) => REVIEW_STATES.includes(d.state as SalesItemState)).length;
  const blocked = items.filter((d) => BLOCK_STATES.includes(d.state as SalesItemState)).length;
  const failed = items.filter((d) => FAIL_STATES.includes(d.state as SalesItemState)).length;
  const inFlight = items.length - drafted - review - blocked - failed;
  const status =
    inFlight > 0
      ? "processing"
      : review + blocked + failed === 0
        ? "completed"
        : drafted > 0
          ? "partial"
          : failed > 0
            ? "failed"
            : "needs_review"; // only review/blocked items, no hard failures
  await prisma.salesContractBatch.update({
    where: { id: batchId },
    data: { draftedItems: drafted, reviewItems: review, blockedItems: blocked, failedItems: failed, status },
  });
}

/** Run every not-yet-terminal item in a batch. Serialized so in-batch duplicate
 * detection (and the shared pdf-parse chain) stay deterministic. */
export async function processSalesContractBatch(batchId: string, opts: { actor?: string; force?: boolean } = {}): Promise<void> {
  const actor = opts.actor ?? "system";
  await prisma.salesContractBatch.update({ where: { id: batchId }, data: { status: "processing" } });
  const items = await prisma.salesContractBatchItem.findMany({ where: { batchId }, orderBy: { serial: "asc" } });
  const seenOrderNos = new Set<string>();
  for (const it of items) {
    const terminal = ["DRAFTED", "DUPLICATE"].includes(it.state);
    if (!opts.force && terminal) {
      for (const o of (it.orderNumbers || "").split(",").filter(Boolean)) seenOrderNos.add(o);
      continue;
    }
    await processSalesBatchItem(it.id, { actor, force: opts.force, seenOrderNos });
  }
  await recomputeSalesBatch(batchId);
  await audit({ entityType: "job", entityId: batchId, action: "sales.batch.processed", actor, data: { items: items.length } });
}
