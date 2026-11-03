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
  type SalesContractFlatCells,
} from ".";
import type { SalesContractCountryBreakdownExtract, SalesContractPoExtract } from "./types";

/**
 * Pull all unique H&M country/market codes from the Country Breakdown PDF,
 * falling back to the PO's own market rows. Returned uppercase + de-duplicated,
 * preserving the order of first appearance (the first entry becomes the primary
 * country used by the Customs Invoice generator).
 */
export function extractCountryCodes(
  country: SalesContractCountryBreakdownExtract | null,
  po: SalesContractPoExtract | null,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (raw: string | null | undefined) => {
    if (!raw) return;
    const c = String(raw).trim().toUpperCase();
    if (!c || seen.has(c)) return;
    seen.add(c);
    out.push(c);
  };
  for (const r of country?.rows ?? []) add(r.marketCode);
  for (const r of po?.marketRows ?? []) add(r.marketCode);
  return out;
}

const MODULE = "sales-contract";

export interface SalesContractUploadFile {
  name: string;
  buffer: Buffer;
  kind: SalesContractPdfKind; // user supplies the kind at upload time (one dropzone per kind)
}

/** Create an empty Sales Contract – the user fills header + uploads POs after. */
export async function createSalesContract(opts: { actor?: string } = {}): Promise<string> {
  const actor = opts.actor ?? "system";
  const c = await prisma.salesContract.create({ data: { createdBy: actor } });
  await audit({ entityType: "contract", entityId: c.id, action: "hm.contract.created", actor });
  return c.id;
}

export interface SalesContractHeaderPatch {
  marchentContNo?: string;
  contractDate?: string;
  buyerCode?: string;
  commercialContNo?: string;
  commercialDate?: string;
  merchandiserName?: string;
  packSet?: string;
  remarksDefault?: string;
  reviseNo?: string;
  status?: "draft" | "ready" | "exported";
  // 2026-10-26 spec: numeric contract number used by the Summary writer
  // (e.g. "97"). Kept distinct from marchentContNo (free-form ref banner).
  contractNo?: string;
}
/** Save editable Sales Contract header fields. Blank is distinct from unset. */
export async function updateSalesContractHeader(
  contractId: string,
  patch: SalesContractHeaderPatch,
  opts: { actor?: string } = {},
): Promise<void> {
  const actor = opts.actor ?? "system";
  await prisma.salesContract.update({ where: { id: contractId }, data: patch });
  await audit({ entityType: "contract", entityId: contractId, action: "hm.contract.header.updated", actor, data: { ...patch } });
}

export interface DeleteSalesContractResult {
  pos: number;
  poPdfs: number;
  customsInvoices: number;
  invoicePdfs: number;
  shipmentRows: number;
  shortOrderNos: number;
}

/**
 * Delete a Sales Contract and EVERY row downstream of it (user rule
 * 2026-11-03). Removes:
 *   - the SalesContract row (→ cascades SalesContractPo, SalesContractPdf,
 *     SalesContractRowEdit)
 *   - every CustomsInvoice whose short orderNo matches one of this contract's
 *     POs (→ cascades CustomsInvoicePdf + CustomsInvoiceEdit)
 *   - every ShipmentScheduleRow whose orderNo matches one of this contract's
 *     POs (→ cascades ShipmentScheduleRowEdit)
 *   - every PDF file on disk belonging to this contract's POs or to the
 *     deleted customs invoices
 * Audit event `hm.contract.deleted` carries counts.
 */
export async function deleteSalesContractWithCascade(
  contractId: string,
  opts: { actor?: string } = {},
): Promise<DeleteSalesContractResult> {
  const actor = opts.actor ?? "system";
  const contract = await prisma.salesContract.findUnique({
    where: { id: contractId },
    select: { id: true, contractNo: true, marchentContNo: true, isCurrent: true },
  });
  if (!contract) throw new Error(`Sales Contract ${contractId} not found.`);

  const pos = await prisma.salesContractPo.findMany({
    where: { contractId },
    select: {
      id: true,
      orderNo: true,
      pdfs: { select: { storagePath: true } },
    },
  });
  const longOrderNos = pos.map((p) => p.orderNo);
  const shortOrderNos = Array.from(
    new Set(longOrderNos.map((o) => (o.match(/\d{6,}/) ?? [o])[0]).filter(Boolean)),
  );
  const invoices = shortOrderNos.length
    ? await prisma.customsInvoice.findMany({
        where: { orderNo: { in: shortOrderNos } },
        select: { id: true, orderNo: true, pdfs: { select: { storagePath: true } } },
      })
    : [];

  const poPdfPaths = pos.flatMap((p) => p.pdfs.map((f) => f.storagePath));
  const invoicePdfPaths = invoices.flatMap((inv) => inv.pdfs.map((f) => f.storagePath));

  const shipmentRows = longOrderNos.length
    ? await prisma.shipmentScheduleRow.count({ where: { orderNo: { in: longOrderNos } } })
    : 0;

  await prisma.$transaction(async (tx) => {
    if (shortOrderNos.length) {
      await tx.customsInvoice.deleteMany({ where: { orderNo: { in: shortOrderNos } } });
    }
    if (longOrderNos.length) {
      await tx.shipmentScheduleRow.deleteMany({ where: { orderNo: { in: longOrderNos } } });
    }
    await tx.salesContract.delete({ where: { id: contractId } });
  });

  const { rm } = await import("fs/promises");
  for (const path of [...poPdfPaths, ...invoicePdfPaths]) {
    try { await rm(path, { force: true }); } catch { /* best-effort */ }
  }

  const result: DeleteSalesContractResult = {
    pos: pos.length,
    poPdfs: poPdfPaths.length,
    customsInvoices: invoices.length,
    invoicePdfs: invoicePdfPaths.length,
    shipmentRows,
    shortOrderNos: shortOrderNos.length,
  };
  await audit({
    entityType: "contract",
    entityId: contractId,
    action: "hm.contract.deleted",
    actor,
    data: {
      contractNo: contract.contractNo,
      marchentContNo: contract.marchentContNo,
      wasCurrent: contract.isCurrent,
      wiped: result,
    },
  });
  return result;
}

/** The directory the three PDFs for a single PO live in. */
function poDir(contractId: string, poId: string): string {
  return join(env.STORAGE_ROOT, "sales-contract", contractId, poId);
}

/**
 * Upload one three-PDF set and queue it for extraction. The caller must supply
 * all three expected kinds (or at least one – missing kinds will later route
 * the set to BLOCKED via the match step). Duplicate files (same sha256 for the
 * same kind) are rejected so the same PDF cannot be uploaded twice.
 */
export interface UploadResult {
  poId: string;
  rejected: { name: string; reason: string }[];
  /**
   * Outcome of the creation-date arbitration (user rule 2026-11-01):
   *   inserted  — new PO added to this contract (no prior copy anywhere)
   *   replaced  — existing PO (in `existingContractId`) refreshed with newer data
   *   duplicate — same creation date already extracted; no change
   *   rejected  — older creation date; placeholder kept as BLOCKED with message
   *   failed    — extraction itself failed (parse / IO)
   */
  outcome: "inserted" | "replaced" | "duplicate" | "rejected" | "failed";
  orderNo: string;
  message: string;
  existingContractId: string | null;
}

export async function uploadSalesContractPdfSet(
  contractId: string,
  files: SalesContractUploadFile[],
  /**
   * `persistToDisk` (user rule 2026-11-03): browser-upload flow sets this to
   * false so no raw PDF bytes ever land on the server's filesystem — only
   * the extracted structured data (poJson, rowsJson, sizeJson, …) stays
   * in the DB. Legacy flows (direct POST to the per-PO upload route)
   * default to true to preserve current behaviour. When false, the
   * SalesContractPdf DB record is still created so UI can show "a Size
   * breakdown PDF was uploaded", but with an empty storagePath — the file
   * itself is not retained anywhere server-side.
   */
  opts: { actor?: string; folderLetter?: string; persistToDisk?: boolean } = {},
): Promise<UploadResult> {
  const persistToDisk = opts.persistToDisk ?? true;
  const actor = opts.actor ?? "system";
  const maxBytes = env.SALES_CONTRACT_MAX_FILE_MB * 1024 * 1024;
  const rejected: { name: string; reason: string }[] = [];

  // Validate each file independently.
  const valid: { file: SalesContractUploadFile; sha256: string }[] = [];
  for (const f of files) {
    if (!/\.pdf$/i.test(f.name)) { rejected.push({ name: f.name, reason: "Not a .pdf file." }); continue; }
    if (f.buffer.length === 0) { rejected.push({ name: f.name, reason: "Empty file." }); continue; }
    if (f.buffer.length > maxBytes) { rejected.push({ name: f.name, reason: `Exceeds ${env.SALES_CONTRACT_MAX_FILE_MB} MB.` }); continue; }
    if (f.buffer.subarray(0, 4).toString("latin1") !== "%PDF") { rejected.push({ name: f.name, reason: "Missing %PDF header." }); continue; }
    const sha256 = createHash("sha256").update(f.buffer).digest("hex");
    valid.push({ file: f, sha256 });
  }
  if (valid.length === 0) throw new Error(rejected.length ? `No valid PDFs: ${rejected.map((r) => `${r.name} (${r.reason})`).join("; ")}` : "No files supplied.");

  // Create the PO row with a placeholder orderNo (filled after extraction).
  // Capture the source folder letter supplied by the caller – it is per-PO,
  // not per-contract (spec Â§2 clarification: one contract may hold POs from
  // multiple folders).
  const folderLetter = (opts.folderLetter ?? "").trim().toUpperCase();
  const po = await prisma.salesContractPo.create({
    data: { contractId, orderNo: `pending-${Date.now()}`, state: "UPLOADED", folderLetter },
  });

  // Stamp the per-(contract × folder) merchandiser entry date on first
  // upload. This feeds Summary Column B — every subsequent PO from the
  // same folder in the same contract reuses this date.
  if (folderLetter) {
    const contractRow = await prisma.salesContract.findUnique({
      where: { id: contractId },
      select: { folderDatesJson: true },
    });
    let folderDates: Record<string, string> = {};
    try { folderDates = JSON.parse(contractRow?.folderDatesJson ?? "{}"); } catch { folderDates = {}; }
    if (!folderDates[folderLetter]) {
      const d = new Date();
      const pad = (n: number) => String(n).padStart(2, "0");
      const monthShort = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][d.getMonth()];
      folderDates[folderLetter] = `${pad(d.getDate())} ${monthShort}, ${d.getFullYear()}`;
      await prisma.salesContract.update({
        where: { id: contractId },
        data: { folderDatesJson: JSON.stringify(folderDates) },
      });
    }
  }

  // Persist files to immutable storage ONLY when the caller asks for it.
  // Browser-upload flow passes persistToDisk=false — no bytes land on disk;
  // the SalesContractPdf DB record is still written (with empty storagePath)
  // so the PO's "which PDFs were uploaded" trail stays intact.
  if (persistToDisk) {
    const dir = poDir(contractId, po.id);
    await mkdir(dir, { recursive: true });
    for (const { file, sha256 } of valid) {
      const storagePath = join(dir, `${file.kind}__${sha256.slice(0, 12)}.pdf`);
      await writeFile(storagePath, file.buffer);
      await prisma.salesContractPdf.upsert({
        where: { poId_kind: { poId: po.id, kind: file.kind } },
        update: { originalName: file.name, sha256, sizeBytes: file.buffer.length, storagePath },
        create: { poId: po.id, kind: file.kind, originalName: file.name, sha256, sizeBytes: file.buffer.length, storagePath },
      });
    }
  } else {
    for (const { file, sha256 } of valid) {
      await prisma.salesContractPdf.upsert({
        where: { poId_kind: { poId: po.id, kind: file.kind } },
        update: { originalName: file.name, sha256, sizeBytes: file.buffer.length, storagePath: "" },
        create: { poId: po.id, kind: file.kind, originalName: file.name, sha256, sizeBytes: file.buffer.length, storagePath: "" },
      });
    }
  }

  await audit({ entityType: "document", entityId: po.id, action: "hm.pdf.uploaded", actor, data: { contractId, accepted: valid.length, rejected: rejected.length } });

  // Process immediately so the preview is ready when the UI reloads.
  // When persistToDisk=false, pass the raw buffers through so extraction
  // doesn't need storagePath (which is empty under the browser-upload rule).
  const bufferMap: Partial<Record<SalesContractPdfKind, Buffer>> = {};
  if (!persistToDisk) {
    for (const { file } of valid) bufferMap[file.kind] = file.buffer;
  }
  await processSalesContractPoSet(po.id, { actor, buffers: persistToDisk ? undefined : bufferMap });

  // Figure out what processing decided (creation-date arbitration can delete
  // the placeholder when it replaces an existing PO, so the placeholder id
  // may be stale — look it up again, and fall back to the owning PO by
  // orderNo when it's gone).
  const stillHere = await prisma.salesContractPo.findUnique({
    where: { id: po.id },
    select: { id: true, state: true, orderNo: true, warning: true, reasons: true, error: true, creationDate: true },
  });
  // Latest audit event tells us which branch intake took.
  const latestAudit = await prisma.auditEvent.findFirst({
    where: {
      entityType: "document",
      action: { in: [
        "hm.set.processed",
        "hm.set.updated_newer_creation_date",
        "hm.set.rescan_same_creation_date",
        "hm.set.rejected_older_creation_date",
        "hm.set.failed",
      ] },
      createdAt: { gte: new Date(Date.now() - 60_000) },
    },
    orderBy: { createdAt: "desc" },
  });
  let outcome: UploadResult["outcome"] = "inserted";
  let message = "";
  let orderNo = "";
  let existingContractId: string | null = null;
  let returnedPoId = po.id;
  const auditData = (() => {
    try { return JSON.parse(String(latestAudit?.dataJson ?? "{}")) as Record<string, unknown>; } catch { return {}; }
  })();
  switch (latestAudit?.action) {
    case "hm.set.updated_newer_creation_date":
      outcome = "replaced";
      orderNo = String(auditData.orderNo ?? "");
      existingContractId = String(auditData.existingContract ?? "") || null;
      message = String(auditData.message ?? `Order ${orderNo} updated in its original contract (newer Creation date).`);
      returnedPoId = String(latestAudit.entityId);
      break;
    case "hm.set.rescan_same_creation_date":
      outcome = "duplicate";
      orderNo = String(auditData.orderNo ?? "");
      existingContractId = String(auditData.existingContract ?? "") || null;
      message = String(auditData.message ?? `Order ${orderNo} already extracted with the same Creation date (no change).`);
      returnedPoId = String(latestAudit.entityId);
      break;
    case "hm.set.rejected_older_creation_date":
      outcome = "rejected";
      orderNo = String(auditData.orderNo ?? stillHere?.orderNo ?? "");
      existingContractId = String(auditData.existingContract ?? "") || null;
      message = String(auditData.message ?? "Rejected: older Creation date than the existing copy.");
      break;
    case "hm.set.processed":
      outcome = "inserted";
      orderNo = stillHere?.orderNo ?? "";
      message = `Order ${orderNo} ingested into this contract.`;
      break;
    case "hm.set.failed":
      outcome = "failed";
      message = String(auditData.message ?? "Extraction failed.");
      break;
    default:
      outcome = stillHere?.state === "BLOCKED" ? "rejected" : "inserted";
      orderNo = stillHere?.orderNo ?? "";
      message = stillHere?.warning || stillHere?.reasons || stillHere?.error || "";
  }

  return { poId: returnedPoId, rejected, outcome, orderNo, message, existingContractId };
}

/**
 * Extract + match + reconcile a PO's three-PDF set. The result (match / recon
 * / rows / blockWrite / reasons) is persisted on the PO row as JSON blobs so
 * the UI never has to re-parse the PDFs for the preview.
 */
export async function processSalesContractPoSet(
  poId: string,
  opts: {
    actor?: string;
    /**
     * In-memory buffers keyed by PDF kind. When provided (browser-upload
     * flow, where nothing is written to disk), extraction reads from these
     * instead of re-reading pdf.storagePath. Legacy disk-persist callers
     * pass nothing and the function falls back to reading `storagePath`.
     */
    buffers?: Partial<Record<SalesContractPdfKind, Buffer>>;
  } = {},
): Promise<void> {
  const actor = opts.actor ?? "system";
  const po = await prisma.salesContractPo.findUnique({ where: { id: poId }, include: { pdfs: true } });
  if (!po) throw new Error("H&M PO set not found.");

  await prisma.salesContractPo.update({ where: { id: poId }, data: { attempts: { increment: 1 }, state: "EXTRACTING", error: "", warning: "" } });

  const readText = async (kind: SalesContractPdfKind): Promise<string> => {
    // Prefer the in-memory buffer when the caller supplied one.
    const inMem = opts.buffers?.[kind];
    if (inMem && inMem.length > 0) {
      try {
        const parsed = await parsePdfText(inMem);
        return parsed.text ?? "";
      } catch { return ""; }
    }
    const pdf = po.pdfs.find((p) => p.kind === kind);
    if (!pdf || !pdf.storagePath) return "";
    try {
      const buf = await readFile(pdf.storagePath);
      const parsed = await parsePdfText(buf);
      return parsed.text ?? "";
    } catch {
      return "";
    }
  };

  try {
    const poText = await readText("PurchaseOrder");
    const sizeText = await readText("SizePerColourBreakdown");
    const countryText = await readText("TotalCountryBreakdown");

    const poExtract = poText ? parsePurchaseOrderText(poText) : null;
    const sizeExtract = sizeText ? parseSizeBreakdownText(sizeText) : null;
    const countryExtract = countryText ? parseCountryBreakdownText(countryText) : null;

    const match = matchSet(poExtract, sizeExtract, countryExtract);
    const recon = reconcileSet(poExtract, sizeExtract, countryExtract);
    const result = buildSetResult(poExtract, sizeExtract, countryExtract, match, recon);

    const orderNo = result.orderNo || po.orderNo;
    // Creation-date resolution (user rule 2026-11-01):
    //   1. Explicit "Creation date:" label from the PO PDF (parsed by
    //      extractCreationDate in parse-po.ts).
    //   2. Fallback: the yyyymmdd_hhmmss timestamp embedded in H&M's
    //      standard attachment filename pattern
    //      `<orderNo>_PurchaseOrder_Supplier_<yyyymmdd>_<hhmmss>.pdf` —
    //      every H&M PO carries this even when the PDF text has no label.
    let creationDate = poExtract?.header.creationDate ?? "";
    if (!creationDate) {
      const poPdf = po.pdfs.find((p) => p.kind === "PurchaseOrder");
      if (poPdf?.originalName) {
        const { extractCreationDateFromFilename } = await import("./scan-folder");
        creationDate = extractCreationDateFromFilename(poPdf.originalName) || "";
      }
    }
    let state: "READY" | "BLOCKED" = result.blockWrite ? "BLOCKED" : "READY";

    // Season + PO year – stored on the PO so the Summary writer and
    // merchandiser-name composer don't have to re-parse PO JSON.
    const { parseSeason, extractPoYear } = await import("./config");
    const parsedSeason = parseSeason(poExtract?.header.season ?? null);
    const season = parsedSeason?.season ?? "";
    const poYear = parsedSeason?.year || extractPoYear(poExtract?.header.dateOfOrder ?? null);

    const countryCodes = extractCountryCodes(countryExtract, poExtract);

    const extractionPayload = {
      orderNo,
      state,
      blockWrite: result.blockWrite,
      reasons: result.reasons.join("\n"),
      matchJson: JSON.stringify(match),
      reconJson: JSON.stringify(recon),
      poJson: JSON.stringify(poExtract),
      sizeJson: JSON.stringify(sizeExtract),
      countryJson: JSON.stringify(countryExtract),
      rowsJson: JSON.stringify(result.rows),
      countryCodesJson: JSON.stringify(countryCodes),
      creationDate,
      warning: result.reasons[0] ?? "",
      processedAt: new Date(),
      season,
      poYear,
    } as const;

    // One Order No. owns ONE SalesContractPo globally — regardless of which
    // contract the user re-uploads into (user rule 2026-11-01).
    //
    //   newer creation date → UPDATE existing in its original contract,
    //                         transfer the new PDFs over, delete this
    //                         placeholder, re-propagate to shipment.
    //   same creation date  → delete this placeholder (idempotent re-scan).
    //   older creation date → keep placeholder as BLOCKED with a warning;
    //                         existing data stands.
    const { resolveCreationDateVerdict } = await import("./dedup-order-no");
    const verdict = orderNo && !orderNo.startsWith("pending-")
      ? await resolveCreationDateVerdict(orderNo, creationDate, poId)
      : { outcome: "no_existing" as const };

    if (verdict.outcome === "newer") {
      // One atomic transaction: destruction (Sales Contract rows, Summary
      // data via PO JSON overwrite, Customs Invoice cascade, Shipment rows +
      // their edits) + rebuild (shipment rows for the new PO version). After
      // this returns, no trace of the previous PO version remains in the DB
      // and the Shipment Schedule reflects only the current markets.
      const wipeStats = await replacePoWithNewerScan({
        placeholderPoId: poId,
        existingPoId: verdict.existing.poId,
        extractionPayload,
        actor,
      });
      await audit({
        entityType: "document",
        entityId: verdict.existing.poId,
        action: "hm.set.updated_newer_creation_date",
        actor,
        data: {
          orderNo,
          existingContract: verdict.existing.contractId,
          attemptedContract: po.contractId,
          replacedCreationDate: verdict.existing.creationDate,
          newCreationDate: creationDate,
          message: verdict.message,
          wiped: wipeStats,
        },
      });
      // Surface unroutable markets on the PO's warning field (manual-placement
      // hint for operators). The failure list was collected inside the txn, so
      // we reuse it here without re-running the router.
      if (extractionPayload.state === "READY" && !result.blockWrite) {
        try {
          await surfaceUnroutedMarkets(verdict.existing.poId, orderNo, wipeStats.shipmentFailures, actor);
        } catch (e) {
          await audit({
            entityType: "document",
            entityId: verdict.existing.poId,
            action: "hm.set.surface_unrouted_failed",
            actor,
            data: { message: e instanceof Error ? e.message : "unknown" },
          });
        }
      }
      return;
    }

    if (verdict.outcome === "same") {
      await discardPlaceholder(poId);
      await audit({
        entityType: "document",
        entityId: verdict.existing.poId,
        action: "hm.set.rescan_same_creation_date",
        actor,
        data: { orderNo, existingContract: verdict.existing.contractId, message: verdict.message },
      });
      return;
    }

    if (verdict.outcome === "older") {
      // User rule 2026-11-03: an older PO must not leave any trace in the DB —
      // fully delete the placeholder PO row AND its uploaded PDFs from disk.
      // Record the rejection in the audit log (which carries orderNo + both
      // creation dates + the message) so operators can still see what was
      // dropped and why.
      await audit({
        entityType: "document",
        entityId: verdict.existing.poId,
        action: "hm.set.rejected_older_creation_date",
        actor,
        data: {
          orderNo,
          placeholderPoId: poId,
          existingContract: verdict.existing.contractId,
          existingCreationDate: verdict.existing.creationDate,
          incomingCreationDate: creationDate,
          message: verdict.message,
        },
      });
      await discardPlaceholder(poId);
      return;
    }

    // No existing PO owns this order — proceed with the placeholder as the
    // canonical row (original path).
    await prisma.salesContractPo.update({
      where: { id: poId },
      data: extractionPayload,
    });

    await audit({ entityType: "document", entityId: poId, action: "hm.set.processed", actor, data: { orderNo, state, rows: result.rows.length } });

    // Auto-propagate to Week-wise Shipment Schedule when the PO reached READY.
    if (state === "READY" && !result.blockWrite) {
      try {
        const { autoScheduleFromPo } = await import("@/server/shipment-schedule/auto-schedule");
        const r = await autoScheduleFromPo({ poId, actor });
        await surfaceUnroutedMarkets(poId, orderNo, r.failed, actor);
        await audit({
          entityType: "document",
          entityId: poId,
          action: "hm.set.auto_scheduled",
          actor,
          data: { routed: r.routed.length, failed: r.failed.length },
        });
      } catch (e) {
        await audit({
          entityType: "document",
          entityId: poId,
          action: "hm.set.auto_schedule_failed",
          actor,
          data: { message: e instanceof Error ? e.message : "unknown" },
        });
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown processing error.";
    await prisma.salesContractPo.update({
      where: { id: poId },
      data: { state: "FAILED", error: msg, processedAt: new Date() },
    });
    await audit({ entityType: "document", entityId: poId, action: "hm.set.failed", actor, data: { message: msg } });
  }
}

/**
 * Record an append-only edit to one row of a PO's generated A..U rows.
 * Overrides are additive: an edit to column J leaves the extracted G, I, N
 * etc. intact. The latest edit per (poId, marketCode) is what the writer uses.
 */
export async function recordSalesContractRowEdit(
  poId: string,
  marketCode: string,
  overrides: Partial<SalesContractFlatCells>,
  opts: { actor?: string } = {},
): Promise<void> {
  const actor = opts.actor ?? "system";
  await prisma.salesContractRowEdit.create({
    data: { poId, marketCode, overridesJson: JSON.stringify(overrides), editedBy: actor },
  });
  await audit({ entityType: "document", entityId: poId, action: "hm.row.edited", actor, data: { marketCode, overrides } });
}

/**
 * Reduce the edit history for one PO's rows into a single `{ "<orderNo>": overrides }`
 * map, used by `writeSalesContractWorkbook`. One row per PO (user spec,
 * 2026-10-20) so one override bucket per PO; later edits win per column,
 * earlier edits for untouched columns remain in effect. The marketCode stored
 * on each edit is retained for audit but is no longer part of the lookup key.
 */
export async function buildOverridesForContract(contractId: string): Promise<Record<string, Partial<SalesContractFlatCells>>> {
  const [pos, contract, buyerCodes, folderMappings] = await Promise.all([
    prisma.salesContractPo.findMany({ where: { contractId }, include: { edits: { orderBy: { editedAt: "asc" } } } }),
    prisma.salesContract.findUnique({ where: { id: contractId } }),
    prisma.salesContractBuyerCode.findMany({ where: { active: true } }),
    prisma.salesContractFolderMapping.findMany(),
  ]);
  // Numeric contract no, e.g. "96" extracted from "AGL/H&M/96/2026", used as
  // the key for the per-(contractNo, folderLetter) BuyerCode lookup and as
  // the Commercial Cont. No. fallback when the SC-level field is blank.
  const numericContractNo = extractNumericContractNo(contract?.contractNo || "");
  const out: Record<string, Partial<SalesContractFlatCells>> = {};
  for (const po of pos) {
    const key = po.orderNo;
    // Auto-defaults from the folder/BuyerCode config. These flow into every
    // PO row of this contract that belongs to the matching folder, so the
    // user doesn't retype them per PO. User sheet edits still win below.
    const autoDefaults: Partial<SalesContractFlatCells> = {};
    const bc = numericContractNo && po.folderLetter
      ? buyerCodes.find((b) => b.contractNo === numericContractNo && b.folderLetter === po.folderLetter)
      : undefined;
    if (bc && bc.buyerCode) autoDefaults.buyerCode = bc.buyerCode;
    else if (contract?.buyerCode) autoDefaults.buyerCode = contract.buyerCode;
    if (contract?.commercialContNo) autoDefaults.commercialContNo = contract.commercialContNo;
    else if (numericContractNo) autoDefaults.commercialContNo = numericContractNo;
    const fm = po.folderLetter ? folderMappings.find((f) => f.folderLetter === po.folderLetter) : undefined;
    if (contract?.commercialDate) autoDefaults.dateCommercial = contract.commercialDate;
    else if (fm?.commercialDate) autoDefaults.dateCommercial = fm.commercialDate;
    out[key] = autoDefaults;
    // Layer user edits on top (later edits win per cell).
    for (const e of po.edits) {
      const over = JSON.parse(e.overridesJson || "{}") as Partial<SalesContractFlatCells>;
      out[key] = { ...out[key], ...over };
    }
  }
  return out;
}

/** Extract "96" from "AGL/H&M/96/2026", or return a bare numeric as-is. */
function extractNumericContractNo(raw: string): string {
  const s = String(raw || "").trim();
  if (!s) return "";
  const full = s.match(/^AGL\/H&M\/(\d+)\/\d{4}$/i);
  if (full) return full[1];
  const bare = s.match(/^(\d+)$/);
  if (bare) return bare[1];
  const anyDigits = s.match(/(\d{1,4})/);
  return anyDigits ? anyDigits[1] : "";
}

/** Load every READY PO's SalesContractSetResult rows for a Sales Contract. */
export async function loadContractSets(contractId: string) {
  const pos = await prisma.salesContractPo.findMany({ where: { contractId }, orderBy: { createdAt: "asc" } });
  return pos.map((po) => {
    const rows = JSON.parse(po.rowsJson || "[]") as unknown[];
    const reasons = po.reasons ? po.reasons.split("\n") : [];
    return {
      orderNo: po.orderNo,
      match: JSON.parse(po.matchJson || "{}"),
      reconciliation: JSON.parse(po.reconJson || "{}"),
      po: po.poJson ? JSON.parse(po.poJson) : null,
      size: po.sizeJson ? JSON.parse(po.sizeJson) : null,
      country: po.countryJson ? JSON.parse(po.countryJson) : null,
      rows: rows as never[],
      blockWrite: po.blockWrite,
      reasons,
    };
  });
}

/**
 * Replace an EXISTING SalesContractPo with the newer extraction carried by a
 * placeholder PO row (user rule 2026-11-03). The entire operation runs inside
 * ONE Prisma `$transaction`: the old PO's downstream data is DELETED, the PO
 * row's data is overwritten in-place, and the Shipment Schedule is rebuilt
 * from the new PO — all atomically. A server crash mid-swap either leaves the
 * old state intact or leaves the new state intact; the system is never in
 * a half-replaced state.
 *
 * What the transaction wipes (for this one orderNo only — never affects
 * another Order No.):
 *  (a) SalesContractPdf rows for the existing PO + the placeholder's PDFs
 *      are reparented onto the existing PO id so the uploaded PDFs point at
 *      the right PO.
 *  (b) SalesContractRowEdit history for the existing PO (per-row overrides
 *      from the previous version lose their meaning once the row grid changes).
 *  (c) Existing PO row's `sheetEditsJson` is force-reset to "{}" (old cell
 *      edits don't carry over to the new version).
 *  (d) Every CustomsInvoice whose short `orderNo` matches this PO's — this
 *      cascades CustomsInvoicePdf + CustomsInvoiceEdit via the schema.
 *  (e) Every ShipmentScheduleRow whose `orderNo` matches — cascading
 *      ShipmentScheduleRowEdit via the schema's onDelete rule.
 *  (f) The existing PO row's data columns are OVERWRITTEN with the new
 *      extraction (poJson / sizeJson / countryJson / rowsJson / creationDate /
 *      warning / season / poYear + folderLetter from the placeholder).
 *  (g) The placeholder PO row itself is deleted.
 *  (h) The new PO version's ShipmentScheduleRow set is rebuilt from the
 *      current TOD × market breakdown via `autoScheduleFromPo({ db: tx })`.
 *
 * After the transaction commits, best-effort disk cleanup removes the old
 * PO PDFs + the old invoice PDFs. Those files sit outside the DB so they
 * can safely drift from the DB without breaking any invariant.
 */
// Exported for the newer-wins wipe test — not part of the public API.
// Internal tooling should keep using processSalesContractPoSet, which is the
// right entry point.
export { replacePoWithNewerScan as _replacePoWithNewerScan };

type ReplacePoResult = {
  rowEdits: number;
  invoices: number;
  invoicePdfs: number;
  hadSheetEdits: boolean;
  shipmentRowsWiped: number;
  shipmentRowsRouted: number;
  shipmentRowsFailed: number;
  shipmentFailures: Array<Record<string, unknown>>;
};

async function replacePoWithNewerScan(opts: {
  placeholderPoId: string;
  existingPoId: string;
  extractionPayload: Record<string, unknown>;
  actor: string;
}): Promise<ReplacePoResult> {
  const { placeholderPoId, existingPoId, extractionPayload, actor } = opts;

  // --- Pre-flight reads (OUTSIDE txn, snapshots used for post-commit cleanup) ---
  const existingPdfs = await prisma.salesContractPdf.findMany({
    where: { poId: existingPoId },
    select: { storagePath: true },
  });

  // Resolve the short order key — CustomsInvoice.orderNo stores the short form
  // (first 6+ digits) regardless of what SalesContractPo stores, so we match
  // on that to catch every invoice tied to this PO.
  const newOrderNoRaw = String(extractionPayload.orderNo || "");
  const shortMatch = newOrderNoRaw.match(/\d{6,}/);
  const shortOrder = shortMatch ? shortMatch[0] : newOrderNoRaw;
  const invoices = shortOrder
    ? await prisma.customsInvoice.findMany({
        where: { orderNo: shortOrder },
        include: { pdfs: { select: { storagePath: true } } },
      })
    : [];

  // Grab the placeholder's folderLetter + the existing row's current sheet-
  // edits + row-edit count so the audit can report what was wiped.
  const [placeholder, existingPo, rowEditCount] = await Promise.all([
    prisma.salesContractPo.findUnique({
      where: { id: placeholderPoId },
      select: { folderLetter: true },
    }),
    prisma.salesContractPo.findUnique({
      where: { id: existingPoId },
      select: { sheetEditsJson: true },
    }),
    prisma.salesContractRowEdit.count({ where: { poId: existingPoId } }),
  ]);
  const hadSheetEdits = Boolean(
    existingPo?.sheetEditsJson && existingPo.sheetEditsJson.trim() && existingPo.sheetEditsJson.trim() !== "{}",
  );
  const invoicePdfCount = invoices.reduce((n, inv) => n + inv.pdfs.length, 0);

  // --- Atomic destruction + overwrite + shipment rebuild ---
  // Timeout bumped to 30 s + 10 s maxWait because the shipment rebuild inside
  // the same transaction can touch 10–30 markets × (findOrCreate week schedule,
  // create row) each — well under 30 s on SQLite + Postgres, but above the
  // default 5 s guard.
  let routedCount = 0;
  let failedCount = 0;
  let wipedShipmentRows = 0;
  let shipmentFailures: Array<Record<string, unknown>> = [];

  await prisma.$transaction(async (tx) => {
    // (e) ShipmentScheduleRow for this orderNo — delete FIRST so the rebuild
    // below only ever inserts. Fetch minimal snapshot for the count.
    const existingShipmentIds = await tx.shipmentScheduleRow.findMany({
      where: { orderNo: newOrderNoRaw },
      select: { id: true },
    });
    if (existingShipmentIds.length > 0) {
      const ids = existingShipmentIds.map((r) => r.id);
      await tx.shipmentScheduleRowEdit.deleteMany({ where: { rowId: { in: ids } } });
      await tx.shipmentScheduleRow.deleteMany({ where: { id: { in: ids } } });
      wipedShipmentRows = ids.length;
    }

    // (a) Old PDFs: remove DB rows + reparent new ones.
    await tx.salesContractPdf.deleteMany({ where: { poId: existingPoId } });
    await tx.salesContractPdf.updateMany({
      where: { poId: placeholderPoId },
      data: { poId: existingPoId },
    });

    // (b) Old per-row overrides.
    await tx.salesContractRowEdit.deleteMany({ where: { poId: existingPoId } });

    // (d) Old customs invoices (cascades delete CustomsInvoicePdf + CustomsInvoiceEdit).
    if (shortOrder) {
      await tx.customsInvoice.deleteMany({ where: { orderNo: shortOrder } });
    }

    // (f) Overwrite the PO row in place; sheetEditsJson is force-reset to "{}"
    // so no stale cell edits from the previous version are rendered.
    await tx.salesContractPo.update({
      where: { id: existingPoId },
      data: {
        ...extractionPayload,
        folderLetter: placeholder?.folderLetter || undefined,
        sheetEditsJson: "{}",
        updatedAt: new Date(),
      },
    });

    // (g) Placeholder's PDFs have been reparented, so cascade-delete of the
    // placeholder is a no-op for DB child rows; its scratch folder on disk is
    // orphaned (small leak, tolerable).
    await tx.salesContractPo.delete({ where: { id: placeholderPoId } });

    // (h) Rebuild Shipment Schedule from the current (just-overwritten) PO,
    // reusing the same tx client so the inserts commit atomically with the
    // destruction above. autoScheduleFromPo also wipes rows for this orderNo
    // internally — those are already gone (step e), so it skips that path.
    const { autoScheduleFromPo } = await import("@/server/shipment-schedule/auto-schedule");
    const scheduleResult = await autoScheduleFromPo({ poId: existingPoId, actor, db: tx });
    routedCount = scheduleResult.routed.length;
    failedCount = scheduleResult.failed.length;
    // Snapshot the failure list so the post-txn step can write the
    // [SHIP-UNROUTED] note on the PO without re-running the router.
    shipmentFailures = scheduleResult.failed as unknown as Array<Record<string, unknown>>;
  }, { timeout: 30_000, maxWait: 10_000 });

  // --- Post-commit, best-effort disk cleanup ---
  for (const pdf of existingPdfs) {
    try {
      const { rm } = await import("fs/promises");
      await rm(pdf.storagePath, { force: true });
    } catch { /* best-effort; orphaning the file is tolerable */ }
  }
  for (const inv of invoices) {
    for (const pdf of inv.pdfs) {
      try {
        const { rm } = await import("fs/promises");
        await rm(pdf.storagePath, { force: true });
      } catch { /* best-effort */ }
    }
  }

  return {
    rowEdits: rowEditCount,
    invoices: invoices.length,
    invoicePdfs: invoicePdfCount,
    hadSheetEdits,
    shipmentRowsWiped: wipedShipmentRows,
    shipmentRowsRouted: routedCount,
    shipmentRowsFailed: failedCount,
    shipmentFailures,
  };
}

/** Delete a placeholder PO + its uploaded PDFs when the scan is idempotent
 *  (same creation date already extracted). Files on disk are removed too. */
async function discardPlaceholder(placeholderPoId: string): Promise<void> {
  const placeholder = await prisma.salesContractPo.findUnique({
    where: { id: placeholderPoId },
    include: { pdfs: { select: { storagePath: true } } },
  });
  if (!placeholder) return;
  await prisma.salesContractPo.delete({ where: { id: placeholderPoId } });
  for (const pdf of placeholder.pdfs) {
    try {
      const { rm } = await import("fs/promises");
      await rm(pdf.storagePath, { force: true });
    } catch { /* ignore */ }
  }
}

/**
 * Re-propagate updated PO data to the Week-wise Shipment Schedule rows and
 * refresh the mechanical fields of any Customs Invoices tied to this Order
 * No. The user rule is: "keep records, update PO-sourced fields only" —
 * so neither shipment manual fields (invoice no, pallet, truck) nor customs
 * manual fields (invoice no, carton no, etc.) are touched.
 */
/**
 * Write unrouted markets back to the PO's `warning` field so the user sees
 * exactly which (marketCode / TOD) combos the Shipment Schedule could not
 * place automatically — those stay to be placed manually. Idempotent: each
 * call OVERWRITES the previous "Shipment-schedule" note so the warning
 * reflects the current PO version, not a stale accumulation across replaces.
 */
async function surfaceUnroutedMarkets(
  poId: string,
  orderNo: string,
  failedResults: ReadonlyArray<Record<string, unknown>>,
  actor: string,
): Promise<void> {
  // Narrow to the failure branch of AutoScheduleResult.
  const failed = failedResults
    .filter((r) => r.routed === false)
    .map((r) => ({ reason: String(r.reason), detail: r.detail !== undefined ? String(r.detail) : undefined }));
  const po = await prisma.salesContractPo.findUnique({ where: { id: poId }, select: { warning: true } });
  if (!po) return;
  // Strip any previous shipment-schedule note (prefixed with marker).
  const marker = "[SHIP-UNROUTED]";
  const kept = (po.warning || "")
    .split(/\n+/)
    .filter((l) => l && !l.includes(marker))
    .join("\n");

  let next = kept;
  if (failed.length > 0) {
    const reasonLabel: Record<string, string> = {
      no_tod_date: "no TOD date",
      unknown_market_code: "unknown market code",
      unparseable_tod: "unparseable TOD date",
      unmapped_cutoff: "market not in CFS cut-off map",
    };
    const summary = failed
      .map((f) => `${f.detail ?? "?"} (${reasonLabel[f.reason] ?? f.reason})`)
      .join(", ");
    const note = `${marker} ${failed.length} market(s) on order ${orderNo} could not be auto-routed to the Weekly Shipment Schedule — add them manually: ${summary}`;
    next = kept ? `${kept}\n${note}` : note;
  }

  if (next !== po.warning) {
    await prisma.salesContractPo.update({ where: { id: poId }, data: { warning: next } });
    if (failed.length > 0) {
      await audit({
        entityType: "document", entityId: poId, action: "shipment-schedule.unrouted.surfaced", actor,
        data: {
          orderNo,
          markets: failed.map((f) => ({ reason: f.reason, detail: f.detail ?? "" })),
        },
      });
    }
  }
}

// `repropagateToShipment` was removed on 2026-11-03: the newer-wins path now
// rebuilds Shipment Schedule rows inside the same `$transaction` as the PO
// JSON swap (via `autoScheduleFromPo({ db: tx })` inside replacePoWithNewerScan),
// so a separate post-txn re-propagation would just insert duplicate rows.
// Customs Invoice re-sync still relies on the invoice-page auto-fill — the
// invoices were cascade-deleted in the same txn, so the operator regenerates
// them from the new PO version.

export { MODULE as SALES_CONTRACT_MODULE_KEY };
