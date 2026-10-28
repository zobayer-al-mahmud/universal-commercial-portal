/**
 * Pick-a-Sales-Contract + upload-up-to-3-PDFs batch workflow for the generic
 * "Sales Contract Creation" module. Reuses the H&M three-PDF-set backend so
 * one master workbook per contract, one row per unique PO, and user-visible
 * conflict detection all follow from the existing code – no parallel schema.
 *
 * Spec (user, 2026-10-20):
 *  1. Select target Sales Contract before uploading.
 *  2. Max 3 PDFs per batch.
 *  3. One master Excel per Sales Contract (already true per contract).
 *  4. One row per unique PO – merge same-PO PDFs, split different-PO PDFs.
 *  5. Never silently overwrite – detect conflicts, flag for review.
 *  6. Verification UI shows selected contract + files + extracted + final row.
 */

import { createHash } from "crypto";
import { mkdir, writeFile, readFile } from "fs/promises";
import { join } from "path";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { audit } from "@/lib/audit";
import { parsePdfText } from "@/server/pdf/parse-pdf";
import {
  buildSetResult,
  matchSet,
  parseCountryBreakdownText,
  parsePurchaseOrderText,
  parseSizeBreakdownText,
  reconcileSet,
  type SalesContractPdfKind,
  type SalesContractTemplateRow,
} from ".";
import { extractCountryCodes } from "./intake";
import { checkOrderNoConflict } from "./dedup-order-no";

export const MAX_PDFS_PER_BATCH = 3;

/** Per-file input the API passes in. `kind` is set by the user (named dropzone)
 * or sniffed from filename at the UI boundary; server trusts it. */
export interface BatchFile {
  name: string;
  buffer: Buffer;
  kind: SalesContractPdfKind;
}

export interface RejectedFile {
  name: string;
  reason: string;
}

export type PerPoAction = "created" | "merged" | "conflict" | "failed" | "rejected_duplicate_order_no";

export interface PerPoResult {
  orderNo: string;             // "" when extraction could not identify one
  poId: string | null;         // the SalesContractPo row this grouped into
  action: PerPoAction;
  state: "READY" | "BLOCKED" | "FAILED" | "NEEDS_REVIEW";
  kinds: SalesContractPdfKind[];          // kinds that landed in this PO this batch
  reasons: string[];
  rowCount: number;            // destination rows generated
  conflictFields?: string[];   // populated when action === "conflict"
}

export interface BatchResult {
  contractId: string;
  accepted: number;
  rejected: RejectedFile[];
  perPo: PerPoResult[];
}

interface Parsed {
  file: BatchFile;
  sha256: string;
  text: string;
  orderNo: string;      // extracted; "" if parse yielded nothing usable
  parseError: string;   // populated when the parser threw
}

// ---------------------------------------------------------------------------
// Pure helpers – no DB, no filesystem. Covered by tests directly.
// ---------------------------------------------------------------------------

/** Extract the Order No that identifies which PO a file belongs to. The
 * three H&M PDF kinds all carry the same `Order No:` label at the top; the
 * parsers return it on `header.orderNo`. Returns "" when nothing was found. */
export function extractOrderNo(kind: SalesContractPdfKind, text: string): string {
  if (!text) return "";
  let fromParser = "";
  try {
    if (kind === "PurchaseOrder") fromParser = parsePurchaseOrderText(text).header.orderNo || "";
    else if (kind === "SizePerColourBreakdown") fromParser = parseSizeBreakdownText(text).header.orderNo || "";
    else if (kind === "TotalCountryBreakdown") fromParser = parseCountryBreakdownText(text).header.orderNo || "";
  } catch {
    // Fall through to the regex fallback.
  }
  if (fromParser) return fromParser;
  // Regex fallback for defensive extraction when the full parser could not
  // find a header (unknown layout, scanned PDF text, etc.). Never invents –
  // only matches the "Order No: NNNNNN-NNNN" shape the real PDFs use.
  const m = text.match(/Order\s*No[:\s]+([0-9]{3,}-[0-9]{3,})/i);
  return m ? m[1] : "";
}

/** Group a flat list of parsed files by the orderNo detected from each file.
 * A file with no detectable orderNo falls into the special bucket `""`, which
 * the caller surfaces as a BLOCKED "could not identify PO" PO entry. */
export function groupByOrderNo<T extends { orderNo: string }>(parsed: T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const p of parsed) {
    const key = p.orderNo;
    const bucket = groups.get(key) ?? [];
    bucket.push(p);
    groups.set(key, bucket);
  }
  return groups;
}

/** Pure conflict detection: compare the previously-stored row for a PO with
 * the newly-generated row. The mapper now returns exactly one row per PO, so
 * the comparison is a straight field-by-field check on that single row; any
 * differing value is a conflict the user must review. */
export function detectRowConflicts(
  prev: SalesContractTemplateRow[],
  next: SalesContractTemplateRow[],
): { hasConflict: boolean; fields: string[] } {
  if (!prev.length) return { hasConflict: false, fields: [] };
  const prevRow = prev[0];
  const nextRow = next[0];
  const fields: string[] = [];
  if (!nextRow) {
    // The new upload produced no row (e.g. match failed) where there was one.
    return { hasConflict: true, fields: ["row_missing_in_new_upload"] };
  }
  const checks: [string, unknown, unknown][] = [
    ["orderQty", prevRow.orderQty, nextRow.orderQty],
    ["fob", prevRow.fob, nextRow.fob],
    ["marketQuantity", prevRow.marketQuantity, nextRow.marketQuantity],
    ["tod", prevRow.tod, nextRow.tod],
    ["country", prevRow.country, nextRow.country],
    ["styleNo", prevRow.styleNo, nextRow.styleNo],
    ["itemDes", prevRow.itemDes, nextRow.itemDes],
    ["marketCode", prevRow.marketCode, nextRow.marketCode],
  ];
  for (const [field, a, b] of checks) {
    if (a === null && b === null) continue;
    if (a !== b) fields.push(`${field} (was ${JSON.stringify(a)}, now ${JSON.stringify(b)})`);
  }
  return { hasConflict: fields.length > 0, fields };
}

/** Validate the batch's file list (count, PDF-ness, size, header, duplicate
 * kind). This is pure – I/O happens later in `uploadHmBatch`. */
export function validateBatchFiles(files: BatchFile[]): { valid: BatchFile[]; rejected: RejectedFile[] } {
  const rejected: RejectedFile[] = [];
  if (files.length === 0) {
    return { valid: [], rejected: [{ name: "(none)", reason: "No PDFs supplied." }] };
  }
  if (files.length > MAX_PDFS_PER_BATCH) {
    for (const f of files.slice(MAX_PDFS_PER_BATCH)) {
      rejected.push({ name: f.name, reason: `Max ${MAX_PDFS_PER_BATCH} PDFs per batch – this one was dropped.` });
    }
  }
  const maxBytes = env.SALES_CONTRACT_MAX_FILE_MB * 1024 * 1024;
  const valid: BatchFile[] = [];
  const seenKinds = new Set<SalesContractPdfKind>();
  for (const f of files.slice(0, MAX_PDFS_PER_BATCH)) {
    if (!/\.pdf$/i.test(f.name)) { rejected.push({ name: f.name, reason: "Not a .pdf file." }); continue; }
    if (f.buffer.length === 0) { rejected.push({ name: f.name, reason: "Empty file." }); continue; }
    if (f.buffer.length > maxBytes) { rejected.push({ name: f.name, reason: `Exceeds ${env.SALES_CONTRACT_MAX_FILE_MB} MB.` }); continue; }
    if (f.buffer.subarray(0, 4).toString("latin1") !== "%PDF") { rejected.push({ name: f.name, reason: "Missing %PDF header." }); continue; }
    if (seenKinds.has(f.kind)) { rejected.push({ name: f.name, reason: `Duplicate kind "${f.kind}" in this batch.` }); continue; }
    seenKinds.add(f.kind);
    valid.push(f);
  }
  return { valid, rejected };
}

// ---------------------------------------------------------------------------
// The DB-touching entry point. Pure functions above are composed here.
// ---------------------------------------------------------------------------

function poDir(contractId: string, poId: string): string {
  return join(env.STORAGE_ROOT, "sales-contract", contractId, poId);
}

/**
 * The main entry point used by the server action: validate → parse → group by
 * orderNo → find-or-create the SalesContractPo row per orderNo → upsert PDFs
 * by kind → re-process → compare with any previous rows for conflict detection.
 *
 * A failure or a conflict on one PO never blocks another PO in the same batch.
 */
export async function uploadHmBatch(
  contractId: string,
  files: BatchFile[],
  opts: { actor?: string } = {},
): Promise<BatchResult> {
  const actor = opts.actor ?? "system";

  // Guard: the contract must exist (prevents writing orphan PO rows if the
  // UI sent a stale id).
  const contract = await prisma.salesContract.findUnique({ where: { id: contractId }, select: { id: true } });
  if (!contract) throw new Error("Target Sales Contract not found.");

  const { valid, rejected } = validateBatchFiles(files);

  // Parse every valid file's PDF text once; feed its orderNo into the grouper.
  const parsed: Parsed[] = [];
  for (const file of valid) {
    const sha256 = createHash("sha256").update(file.buffer).digest("hex");
    let text = "";
    let parseError = "";
    try {
      const r = await parsePdfText(file.buffer);
      text = r.text ?? "";
    } catch (e) {
      parseError = e instanceof Error ? e.message : "pdf-parse failed.";
    }
    const orderNo = parseError ? "" : extractOrderNo(file.kind, text);
    parsed.push({ file, sha256, text, orderNo, parseError });
  }

  const groups = groupByOrderNo(parsed);
  const perPo: PerPoResult[] = [];

  for (const [orderNo, items] of groups) {
    // No orderNo → the files could not be identified. Emit one BLOCKED entry
    // and store nothing on the contract (we do not want "pending-..." garbage
    // rows the user has to clean up by hand).
    if (!orderNo) {
      perPo.push({
        orderNo: "",
        poId: null,
        action: "failed",
        state: "FAILED",
        kinds: items.map((i) => i.file.kind),
        reasons: items.map((i) => `${i.file.name}: ${i.parseError || "Could not extract Order No from this PDF."}`),
        rowCount: 0,
      });
      continue;
    }

    // Cross-contract dedup (user rule 2026-10-28): an Order No belongs to
    // exactly ONE Sales Contract. If this orderNo is already extracted on
    // another contract, refuse to re-extract here. The user must manually
    // move the existing PO via `reassignPoToContract` before re-uploading.
    const orderNoConflict = await checkOrderNoConflict(orderNo, contractId);
    if (orderNoConflict) {
      perPo.push({
        orderNo,
        poId: orderNoConflict.conflictingPoId,
        action: "rejected_duplicate_order_no",
        state: "BLOCKED",
        kinds: items.map((i) => i.file.kind),
        reasons: [orderNoConflict.message],
        rowCount: 0,
      });
      await audit({
        entityType: "document",
        entityId: orderNoConflict.conflictingPoId,
        action: "hm.set.rejected_cross_contract",
        actor,
        data: { orderNo, attemptedContract: contractId, existingContract: orderNoConflict.conflictingContractId },
      });
      continue;
    }

    // Find or create the PO row for this contract+orderNo (unique).
    let po = await prisma.salesContractPo.findUnique({
      where: { contractId_orderNo: { contractId, orderNo } },
    });
    const existed = !!po;
    if (!po) {
      po = await prisma.salesContractPo.create({
        data: { contractId, orderNo, state: "UPLOADED" },
      });
    }

    // Capture the previous rows before we overwrite, so conflict detection has
    // something to compare against.
    const prevRows: SalesContractTemplateRow[] = (() => {
      try { return JSON.parse(po.rowsJson || "[]") as SalesContractTemplateRow[]; } catch { return []; }
    })();

    // Persist each PDF (immutable, sha-named) and upsert the SalesContractPdf
    // row for its kind. Same-sha upload for same kind is a no-op in practice –
    // the file is just rewritten with the same content.
    try {
      const dir = poDir(contractId, po.id);
      await mkdir(dir, { recursive: true });
      for (const item of items) {
        const storagePath = join(dir, `${item.file.kind}__${item.sha256.slice(0, 12)}.pdf`);
        await writeFile(storagePath, item.file.buffer);
        await prisma.salesContractPdf.upsert({
          where: { poId_kind: { poId: po.id, kind: item.file.kind } },
          update: { originalName: item.file.name, sha256: item.sha256, sizeBytes: item.file.buffer.length, storagePath },
          create: { poId: po.id, kind: item.file.kind, originalName: item.file.name, sha256: item.sha256, sizeBytes: item.file.buffer.length, storagePath },
        });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "File write failed.";
      await prisma.salesContractPo.update({
        where: { id: po.id },
        data: { state: "FAILED", error: msg, processedAt: new Date() },
      });
      perPo.push({
        orderNo, poId: po.id, action: "failed", state: "FAILED",
        kinds: items.map((i) => i.file.kind), reasons: [msg], rowCount: 0,
      });
      continue;
    }

    // Re-extract across EVERY stored PDF for this PO so the merge sees all
    // kinds (whether this batch supplied them or a previous one did).
    await prisma.salesContractPo.update({ where: { id: po.id }, data: { attempts: { increment: 1 }, state: "EXTRACTING", error: "", warning: "" } });
    const allPdfs = await prisma.salesContractPdf.findMany({ where: { poId: po.id } });

    const texts: Record<SalesContractPdfKind, string> = {
      PurchaseOrder: "",
      SizePerColourBreakdown: "",
      TotalCountryBreakdown: "",
    };
    for (const pdf of allPdfs) {
      // Re-use the text we already parsed this batch, else read from disk.
      const inBatch = items.find((i) => i.file.kind === pdf.kind);
      if (inBatch && inBatch.text) {
        texts[pdf.kind as SalesContractPdfKind] = inBatch.text;
      } else {
        try {
          const buf = await readFile(pdf.storagePath);
          const r = await parsePdfText(buf);
          texts[pdf.kind as SalesContractPdfKind] = r.text ?? "";
        } catch { /* leave blank – match will fail if required */ }
      }
    }

    const poExtract = texts.PurchaseOrder ? safeCall(() => parsePurchaseOrderText(texts.PurchaseOrder)) : null;
    const sizeExtract = texts.SizePerColourBreakdown ? safeCall(() => parseSizeBreakdownText(texts.SizePerColourBreakdown)) : null;
    const countryExtract = texts.TotalCountryBreakdown ? safeCall(() => parseCountryBreakdownText(texts.TotalCountryBreakdown)) : null;

    const match = matchSet(poExtract, sizeExtract, countryExtract);
    const recon = reconcileSet(poExtract, sizeExtract, countryExtract);
    const result = buildSetResult(poExtract, sizeExtract, countryExtract, match, recon);

    // Conflict detection – only meaningful when the PO already had rows.
    const conflict = existed ? detectRowConflicts(prevRows, result.rows) : { hasConflict: false, fields: [] };

    let state: "READY" | "BLOCKED" | "NEEDS_REVIEW" = result.blockWrite ? "BLOCKED" : "READY";
    let action: PerPoAction = existed ? "merged" : "created";
    const reasons = [...result.reasons];
    if (conflict.hasConflict) {
      state = "NEEDS_REVIEW";
      action = "conflict";
      reasons.unshift(
        `VALUES_CONFLICT: this upload would change ${conflict.fields.length} field(s) that were already extracted for PO ${orderNo}. Review before saving.`,
        ...conflict.fields.map((f) => `  · ${f}`),
      );
    }

    await prisma.salesContractPo.update({
      where: { id: po.id },
      data: {
        orderNo,
        // When a conflict is detected we keep the PREVIOUS rowsJson intact so
        // the already-approved values are not silently overwritten; the
        // reasons blob tells the user exactly what would change.
        state,
        blockWrite: result.blockWrite || conflict.hasConflict,
        reasons: reasons.join("\n"),
        matchJson: JSON.stringify(match),
        reconJson: JSON.stringify(recon),
        poJson: JSON.stringify(poExtract),
        sizeJson: JSON.stringify(sizeExtract),
        countryJson: JSON.stringify(countryExtract),
        rowsJson: conflict.hasConflict ? po.rowsJson : JSON.stringify(result.rows),
        countryCodesJson: JSON.stringify(extractCountryCodes(countryExtract, poExtract)),
        warning: reasons[0] ?? "",
        processedAt: new Date(),
      },
    });

    await audit({
      entityType: "document",
      entityId: po.id,
      action: `hm.batch.${action}`,
      actor,
      data: { contractId, orderNo, kinds: items.map((i) => i.file.kind), state, conflictFields: conflict.fields },
    });

    // Auto-propagate to Week-wise Shipment Schedule: one row per
    // (TOD × market) with that combo's own quantity. Only when the PO
    // reaches READY and there's no conflict blocking the write.
    if (state === "READY" && !conflict.hasConflict && !result.blockWrite) {
      try {
        const { autoScheduleFromPo } = await import("@/server/shipment-schedule/auto-schedule");
        const r = await autoScheduleFromPo({ poId: po.id, actor });
        reasons.push(`Shipment schedule: ${r.routed.length} rows routed, ${r.failed.length} unroutable.`);
      } catch (e) {
        reasons.push(`Shipment schedule auto-route failed: ${e instanceof Error ? e.message : "unknown"}`);
      }
    }

    perPo.push({
      orderNo,
      poId: po.id,
      action,
      state,
      kinds: items.map((i) => i.file.kind),
      reasons,
      rowCount: conflict.hasConflict ? prevRows.length : result.rows.length,
      conflictFields: conflict.hasConflict ? conflict.fields : undefined,
    });
  }

  await audit({
    entityType: "contract",
    entityId: contractId,
    action: "hm.batch.uploaded",
    actor,
    data: { accepted: valid.length, rejected: rejected.length, pos: perPo.length },
  });

  return { contractId, accepted: valid.length, rejected, perPo };
}

function safeCall<T>(fn: () => T): T | null {
  try { return fn(); } catch { return null; }
}
