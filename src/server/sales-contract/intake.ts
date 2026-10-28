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
export async function uploadSalesContractPdfSet(
  contractId: string,
  files: SalesContractUploadFile[],
  opts: { actor?: string; folderLetter?: string } = {},
): Promise<{ poId: string; rejected: { name: string; reason: string }[] }> {
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

  // Persist files to immutable storage. The orderNo is backfilled below.
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

  await audit({ entityType: "document", entityId: po.id, action: "hm.pdf.uploaded", actor, data: { contractId, accepted: valid.length, rejected: rejected.length } });

  // Process immediately so the preview is ready when the UI reloads.
  await processSalesContractPoSet(po.id, { actor });

  return { poId: po.id, rejected };
}

/**
 * Extract + match + reconcile a PO's three-PDF set. The result (match / recon
 * / rows / blockWrite / reasons) is persisted on the PO row as JSON blobs so
 * the UI never has to re-parse the PDFs for the preview.
 */
export async function processSalesContractPoSet(
  poId: string,
  opts: { actor?: string } = {},
): Promise<void> {
  const actor = opts.actor ?? "system";
  const po = await prisma.salesContractPo.findUnique({ where: { id: poId }, include: { pdfs: true } });
  if (!po) throw new Error("H&M PO set not found.");

  await prisma.salesContractPo.update({ where: { id: poId }, data: { attempts: { increment: 1 }, state: "EXTRACTING", error: "", warning: "" } });

  const readText = async (kind: SalesContractPdfKind): Promise<string> => {
    const pdf = po.pdfs.find((p) => p.kind === kind);
    if (!pdf) return "";
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
    let state: "READY" | "BLOCKED" = result.blockWrite ? "BLOCKED" : "READY";

    // Cross-contract dedup (user rule 2026-10-28): refuse to accept this
    // extraction if the order-no already belongs to another Sales Contract.
    // The user must first move the existing PO via `reassignPoToContract`.
    const { checkOrderNoConflict } = await import("./dedup-order-no");
    const conflict = await checkOrderNoConflict(orderNo, po.contractId);
    if (conflict) {
      await prisma.salesContractPo.update({
        where: { id: poId },
        data: {
          state: "BLOCKED",
          blockWrite: true,
          error: conflict.message,
          reasons: conflict.message,
          processedAt: new Date(),
        },
      });
      await audit({
        entityType: "document",
        entityId: poId,
        action: "hm.set.rejected_cross_contract",
        actor,
        data: { orderNo, attemptedContract: po.contractId, existingContract: conflict.conflictingContractId },
      });
      return;
    }

    // Extract country codes from the Country Breakdown PDF (and the PO's own
    // market list as a fallback). Deduped + uppercased so the Customs Invoice
    // module can match a template without going through Shipment Schedule.
    const countryCodes = extractCountryCodes(countryExtract, poExtract);

    // Season + PO year – stored on the PO so the Summary writer and
    // merchandiser-name composer don't have to re-parse PO JSON. Season is
    // the raw "<season>-<year>" string if confident; the parsed parts live
    // on `season` and `poYear`.
    const { parseSeason, extractPoYear } = await import("./config");
    const parsedSeason = parseSeason(poExtract?.header.season ?? null);
    const season = parsedSeason?.season ?? "";
    const poYear = parsedSeason?.year || extractPoYear(poExtract?.header.dateOfOrder ?? null);

    await prisma.salesContractPo.update({
      where: { id: poId },
      data: {
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
        warning: result.reasons[0] ?? "",
        processedAt: new Date(),
        season,
        poYear,
      },
    });

    await audit({ entityType: "document", entityId: poId, action: "hm.set.processed", actor, data: { orderNo, state, rows: result.rows.length } });

    // Auto-propagate to Week-wise Shipment Schedule when the PO reached READY.
    if (state === "READY" && !result.blockWrite) {
      try {
        const { autoScheduleFromPo } = await import("@/server/shipment-schedule/auto-schedule");
        const r = await autoScheduleFromPo({ poId, actor });
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

export { MODULE as SALES_CONTRACT_MODULE_KEY };
