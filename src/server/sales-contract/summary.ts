/**
 * End-to-end orchestration for the consolidated H&M Summary Excel.
 *
 * Pulls every READY PO from the DB, resolves per-PO config (folder mapping,
 * buyer code, contract-level date), builds summary rows, and hands them to
 * `writeSummaryWorkbook`. All contracts are included in ascending contract-
 * number order (spec Â§12), and manual columns P/T/U are preserved by the
 * writer when a template path is supplied.
 */
import { join } from "node:path";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { resolvePoDerivedFields } from "./config";
import { getFolderMapping, lookupBuyerCode } from "./config-intake";
import { writeSummaryWorkbook, type SalesContractSummaryWriteResult } from "./summary-writer";
import { buildExtraPricesFromPo, mapToSummaryRows, type SalesContractSummaryRow } from "./summary-rows";
import type { SalesContractCountryBreakdownExtract, SalesContractPoExtract } from "./types";
import type { SalesContractSummaryConfig } from "./summary-rows";

export interface GenerateSummaryOptions {
  templatePath?: string;      // existing Summary file to merge against; preserved
  outputPath?: string;        // defaults to STORAGE_ROOT/sales-contract/summary/<ts>.xlsx
  /** Restrict to one Sales Contract (by SalesContract.id). Default: all. */
  contractId?: string;
  /** Restrict to a list of Sales Contracts (by SalesContract.id). Default: all.
   *  When set alongside `contractId`, the single id is folded in automatically. */
  contractIds?: string[];
  /** Deduplicate POs by their short order no, keeping the OLDEST extracted
   *  copy. Default true — a PO scanned into several contracts (e.g. because
   *  the folder was re-scanned) only appears once in the Summary. */
  dedupByOrderNo?: boolean;
}

export interface GenerateSummaryResult extends SalesContractSummaryWriteResult {
  skippedPos: { orderNo: string; reasons: string[] }[];
}

export async function generateHmSummary(opts: GenerateSummaryOptions = {}): Promise<GenerateSummaryResult> {
  // Resolve the contract filter: single `contractId`, a list of `contractIds`,
  // or nothing (= all contracts).
  const idSet = new Set<string>();
  if (opts.contractId) idSet.add(opts.contractId);
  for (const id of opts.contractIds ?? []) if (id) idSet.add(id);
  const where = idSet.size > 0 ? { contractId: { in: [...idSet] } } : {};
  const dedup = opts.dedupByOrderNo !== false; // default true
  let pos = await prisma.salesContractPo.findMany({
    where: { ...where, state: "READY", blockWrite: false },
    include: { contract: true },
    orderBy: [{ contract: { contractNo: "asc" } }, { folderLetter: "asc" }, { createdAt: "asc" }],
  });
  // Dedup by short order-no (first 6+ digits) — a PO scanned into several
  // contracts (e.g. after a folder re-scan) appears only once, with the
  // OLDEST extracted copy winning (user rule 2026-10-29). Ties within one
  // contract keep the earlier createdAt via the orderBy above.
  if (dedup) {
    const seen = new Set<string>();
    pos = pos.filter((p) => {
      const m = (p.orderNo || "").match(/\d{6,}/);
      const key = m ? m[0] : p.orderNo;
      if (!key) return true;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  const folderMappings = new Map<string, Awaited<ReturnType<typeof getFolderMapping>>>();
  const folderSequence: { folderLetter: string; sequence: number }[] = [];
  const skipped: GenerateSummaryResult["skippedPos"] = [];

  const payload: { poId: string; po: SalesContractPoExtract; config: SalesContractSummaryConfig }[] = [];
  for (const po of pos) {
    const reasons: string[] = [];
    let poExtract: SalesContractPoExtract | null = null;
    let countryExtract: SalesContractCountryBreakdownExtract | null = null;
    try { poExtract = JSON.parse(po.poJson || "null"); } catch { poExtract = null; }
    try { countryExtract = JSON.parse(po.countryJson || "null"); } catch { countryExtract = null; }
    if (!poExtract) { reasons.push("NO_PO_EXTRACT"); skipped.push({ orderNo: po.orderNo, reasons }); continue; }

    const contractNo = po.contract.contractNo || po.contract.commercialContNo;
    if (!contractNo) reasons.push("CONTRACT_NO_MISSING_ON_CONTRACT");
    const folderLetter = (po.folderLetter || "").toUpperCase();
    if (!folderLetter) reasons.push("FOLDER_LETTER_MISSING_ON_PO");

    if (reasons.length) { skipped.push({ orderNo: po.orderNo, reasons }); continue; }

    let folder = folderMappings.get(folderLetter);
    if (folder === undefined) {
      folder = await getFolderMapping(folderLetter);
      folderMappings.set(folderLetter, folder);
      if (folder) folderSequence.push({ folderLetter: folder.folderLetter, sequence: folder.sequence });
    }
    if (!folder) { skipped.push({ orderNo: po.orderNo, reasons: ["FOLDER_MAPPING_MISSING"] }); continue; }

    const buyerCode = (await lookupBuyerCode(contractNo, folderLetter)) ?? "";
    if (!buyerCode) reasons.push("BUYER_CODE_MISSING");

    const resolved = resolvePoDerivedFields({
      header: poExtract.header,
      contractNo,
      folderLetter,
      merchandisers: folder.merchandisers,
    });
    for (const w of resolved.warnings) reasons.push(w);

    const extraPrices = buildExtraPricesFromPo(poExtract, countryExtract);
    // 2026-10-27 rule change:
    //   Column B = date THIS folder started feeding THIS contract (stamped
    //              on first PO upload, stored in SalesContract.folderDatesJson).
    //   Column E = Sales Contract date (one date per contract) — contract.contractDate.
    let folderDates: Record<string, string> = {};
    try { folderDates = JSON.parse((po.contract as { folderDatesJson?: string }).folderDatesJson ?? "{}"); } catch { folderDates = {}; }
    const folderEntryDate = folderDates[folderLetter] ?? "";

    // 2026-10-27 pack/set rule — Column S = PO's No of Pieces (so Single mode
    // shows 1, Multipack 2/3/… shows the pack size); Column R = qty ×
    // No of Pieces. If the PO extractor didn't surface a value, fall back
    // to the Sales-Contract-level packSet or "1".
    const noOfPieces = Number.isFinite(poExtract.noOfPieces) ? Number(poExtract.noOfPieces) : null;
    const packSetForRow = noOfPieces !== null && noOfPieces > 0
      ? String(noOfPieces)
      : (po.contract.packSet || "1");

    const config: SalesContractSummaryConfig = {
      contractNo,
      folderLetter,
      contractDate: po.contract.contractDate ?? "",   // → Column E
      folderCommercialDate: folderEntryDate,          // → Column B
      buyerCode,
      merchandiserName: resolved.merchandiserName,
      packSet: packSetForRow,
      marchentContNoOverride: po.contract.marchentContNo || resolved.contractRef,
      extraPrices,
    };
    if (extraPrices.length > 0) reasons.push(`MULTI_PRICE_PRESERVED:${extraPrices.length}`);
    payload.push({ poId: po.id, po: poExtract, config });

    if (reasons.length) {
      // Non-fatal – still include the PO in the Summary, but surface in skipped
      // for the UI's review queue.
      skipped.push({ orderNo: po.orderNo, reasons });
    }
  }

  const outputPath = opts.outputPath ?? join(
    env.STORAGE_ROOT,
    "sales-contract",
    "summary",
    `HM_Summary_${timestamp()}.xlsx`,
  );
  const result = await writeSummaryWorkbook({
    templatePath: opts.templatePath,
    outputPath,
    pos: payload,
    folderSequence,
  });
  return { ...result, skippedPos: skipped };
}

/**
 * In-memory variant of generateHmSummary — returns the mapped summary rows
 * (same shape the xlsx writer renders) without touching disk. Used by the
 * "View summary" page so the UI can show the exact rows the Download Summary
 * .xlsx would produce.
 *
 * Honours the same `contractIds` filter + `dedupByOrderNo` rule as the
 * writer path.
 */
export async function collectSummaryRows(
  opts: Pick<GenerateSummaryOptions, "contractId" | "contractIds" | "dedupByOrderNo"> = {},
): Promise<{
  rows: SalesContractSummaryRow[];
  skippedPos: GenerateSummaryResult["skippedPos"];
  contractCount: number;
}> {
  const idSet = new Set<string>();
  if (opts.contractId) idSet.add(opts.contractId);
  for (const id of opts.contractIds ?? []) if (id) idSet.add(id);
  const where = idSet.size > 0 ? { contractId: { in: [...idSet] } } : {};
  const dedup = opts.dedupByOrderNo !== false;
  let pos = await prisma.salesContractPo.findMany({
    where: { ...where, state: "READY", blockWrite: false },
    include: { contract: true },
    orderBy: [{ contract: { contractNo: "asc" } }, { folderLetter: "asc" }, { createdAt: "asc" }],
  });
  if (dedup) {
    const seen = new Set<string>();
    pos = pos.filter((p) => {
      const m = (p.orderNo || "").match(/\d{6,}/);
      const key = m ? m[0] : p.orderNo;
      if (!key) return true;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  const skipped: GenerateSummaryResult["skippedPos"] = [];
  const rows: SalesContractSummaryRow[] = [];
  const contractIdsSeen = new Set<string>();
  const folderMappings = new Map<string, Awaited<ReturnType<typeof getFolderMapping>>>();
  for (const po of pos) {
    contractIdsSeen.add(po.contractId);
    let poExtract: SalesContractPoExtract | null = null;
    let countryExtract: SalesContractCountryBreakdownExtract | null = null;
    try { poExtract = JSON.parse(po.poJson || "null"); } catch { poExtract = null; }
    try { countryExtract = JSON.parse(po.countryJson || "null"); } catch { countryExtract = null; }
    if (!poExtract) { skipped.push({ orderNo: po.orderNo, reasons: ["NO_PO_EXTRACT"] }); continue; }
    const contractNo = po.contract.contractNo || po.contract.commercialContNo;
    const folderLetter = (po.folderLetter || "").toUpperCase();
    if (!contractNo || !folderLetter) {
      skipped.push({ orderNo: po.orderNo, reasons: ["CONTRACT_NO_OR_FOLDER_MISSING"] });
      continue;
    }
    let folder = folderMappings.get(folderLetter);
    if (folder === undefined) {
      folder = await getFolderMapping(folderLetter);
      folderMappings.set(folderLetter, folder);
    }
    if (!folder) { skipped.push({ orderNo: po.orderNo, reasons: ["FOLDER_MAPPING_MISSING"] }); continue; }
    const buyerCode = (await lookupBuyerCode(contractNo, folderLetter)) ?? "";
    const resolved = resolvePoDerivedFields({
      header: poExtract.header,
      contractNo,
      folderLetter,
      merchandisers: folder.merchandisers,
    });
    let folderDates: Record<string, string> = {};
    try { folderDates = JSON.parse((po.contract as { folderDatesJson?: string }).folderDatesJson ?? "{}"); } catch { folderDates = {}; }
    const folderEntryDate = folderDates[folderLetter] ?? "";
    const noOfPieces = Number.isFinite(poExtract.noOfPieces) ? Number(poExtract.noOfPieces) : null;
    const packSetForRow = noOfPieces !== null && noOfPieces > 0 ? String(noOfPieces) : (po.contract.packSet || "1");
    const extraPrices = buildExtraPricesFromPo(poExtract, countryExtract);
    const config: SalesContractSummaryConfig = {
      contractNo,
      folderLetter,
      contractDate: po.contract.contractDate ?? "",
      folderCommercialDate: folderEntryDate,
      buyerCode,
      merchandiserName: resolved.merchandiserName,
      packSet: packSetForRow,
      marchentContNoOverride: po.contract.marchentContNo || resolved.contractRef,
      extraPrices,
    };
    for (const r of mapToSummaryRows(poExtract, config, po.id)) rows.push(r);
  }
  return { rows, skippedPos: skipped, contractCount: contractIdsSeen.size };
}

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}
