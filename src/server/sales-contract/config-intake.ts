/**
 * Database access for the H&M config layer:
 *
 *  - folder-mapping CRUD        (SalesContractFolderMapping)
 *  - buyer-code CRUD            (SalesContractBuyerCode)
 *  - current-contract selector  (SalesContract.isCurrent)
 *  - folder-letter + per-folder commercial date lookups used by the writer
 *
 * All writes are idempotent and audited; the pure helpers in `./config.ts` do
 * the formatting.
 */
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";

export interface FolderMappingInput {
  folderLetter: string;
  sequence?: number;
  merchandisers: string[];
  commercialDate?: string;
  sourceFolderPath?: string;
  active?: boolean;
}

export async function upsertFolderMapping(
  input: FolderMappingInput,
  opts: { actor?: string } = {},
): Promise<void> {
  const actor = opts.actor ?? "system";
  const key = input.folderLetter.trim().toUpperCase();
  if (!key) throw new Error("folderLetter is required");
  const data = {
    merchandisersJson: JSON.stringify(input.merchandisers ?? []),
    sequence: input.sequence ?? 0,
    commercialDate: input.commercialDate ?? "",
    sourceFolderPath: input.sourceFolderPath ?? "",
    active: input.active ?? true,
  };
  await prisma.salesContractFolderMapping.upsert({
    where: { folderLetter: key },
    update: data,
    create: { folderLetter: key, ...data },
  });
  await audit({
    entityType: "contract",
    entityId: `hm-folder-${key}`,
    action: "hm.folder.mapping.upserted",
    actor,
    data: { folderLetter: key, merchandisers: input.merchandisers, commercialDate: input.commercialDate ?? "" },
  });
}

export interface FolderMappingRecord extends FolderMappingInput {
  folderLetter: string;
  sequence: number;
  active: boolean;
  commercialDate: string;
  sourceFolderPath: string;
  merchandisers: string[];
}
export async function listFolderMappings(): Promise<FolderMappingRecord[]> {
  const rows = await prisma.salesContractFolderMapping.findMany({ orderBy: [{ sequence: "asc" }, { folderLetter: "asc" }] });
  return rows.map((r) => ({
    folderLetter: r.folderLetter,
    sequence: r.sequence,
    merchandisers: safeArr(r.merchandisersJson),
    commercialDate: r.commercialDate,
    sourceFolderPath: r.sourceFolderPath ?? "",
    active: r.active,
  }));
}
export async function getFolderMapping(folderLetter: string): Promise<FolderMappingRecord | null> {
  const key = folderLetter.trim().toUpperCase();
  if (!key) return null;
  const r = await prisma.salesContractFolderMapping.findUnique({ where: { folderLetter: key } });
  if (!r) return null;
  return {
    folderLetter: r.folderLetter,
    sequence: r.sequence,
    merchandisers: safeArr(r.merchandisersJson),
    commercialDate: r.commercialDate,
    sourceFolderPath: r.sourceFolderPath ?? "",
    active: r.active,
  };
}

export interface BuyerCodeInput {
  contractNo: string;
  folderLetter: string;
  buyerCode: string;
  active?: boolean;
}
export async function upsertBuyerCode(
  input: BuyerCodeInput,
  opts: { actor?: string } = {},
): Promise<void> {
  const actor = opts.actor ?? "system";
  const contractNo = input.contractNo.trim();
  const folderLetter = input.folderLetter.trim().toUpperCase();
  if (!contractNo || !folderLetter || !input.buyerCode?.trim()) {
    throw new Error("contractNo, folderLetter, and buyerCode are all required");
  }
  await prisma.salesContractBuyerCode.upsert({
    where: { contractNo_folderLetter: { contractNo, folderLetter } },
    update: { buyerCode: input.buyerCode.trim(), active: input.active ?? true },
    create: { contractNo, folderLetter, buyerCode: input.buyerCode.trim(), active: input.active ?? true },
  });
  await audit({
    entityType: "contract",
    entityId: `hm-buyercode-${contractNo}-${folderLetter}`,
    action: "hm.buyercode.upserted",
    actor,
    data: { contractNo, folderLetter, buyerCode: input.buyerCode.trim() },
  });
}

export async function listBuyerCodes(): Promise<BuyerCodeInput[]> {
  const rows = await prisma.salesContractBuyerCode.findMany({ orderBy: [{ contractNo: "asc" }, { folderLetter: "asc" }] });
  return rows.map((r) => ({
    contractNo: r.contractNo,
    folderLetter: r.folderLetter,
    buyerCode: r.buyerCode,
    active: r.active,
  }));
}

export async function lookupBuyerCode(contractNo: string, folderLetter: string): Promise<string | null> {
  const c = contractNo.trim();
  const f = folderLetter.trim().toUpperCase();
  if (!c || !f) return null;
  const r = await prisma.salesContractBuyerCode.findUnique({
    where: { contractNo_folderLetter: { contractNo: c, folderLetter: f } },
  });
  if (!r || !r.active) return null;
  return r.buyerCode;
}

export async function setCurrentContract(
  contractId: string,
  opts: { actor?: string } = {},
): Promise<void> {
  const actor = opts.actor ?? "system";
  if (!contractId) throw new Error("contractId required");
  await prisma.$transaction([
    prisma.salesContract.updateMany({ where: { isCurrent: true }, data: { isCurrent: false } }),
    prisma.salesContract.update({ where: { id: contractId }, data: { isCurrent: true } }),
  ]);
  await audit({
    entityType: "contract",
    entityId: contractId,
    action: "hm.contract.setCurrent",
    actor,
  });
}

export async function getCurrentContract() {
  return prisma.salesContract.findFirst({ where: { isCurrent: true } });
}

export async function reassignPoToContract(
  poId: string,
  newContractId: string,
  opts: { actor?: string } = {},
): Promise<void> {
  const actor = opts.actor ?? "system";
  const po = await prisma.salesContractPo.findUnique({ where: { id: poId } });
  if (!po) throw new Error("PO not found");
  const prev = po.contractId;
  if (prev === newContractId) return;

  // Target contract must not already have a PO with this orderNo (would
  // violate the (contractId, orderNo) unique index). The user has to delete
  // or rename the colliding PO first.
  const collision = await prisma.salesContractPo.findUnique({
    where: { contractId_orderNo: { contractId: newContractId, orderNo: po.orderNo } },
  });
  if (collision && collision.id !== poId) {
    throw new Error(
      `Target contract already has a PO with Order No ${po.orderNo}. ` +
      `Delete or rename that PO first.`,
    );
  }

  await prisma.salesContractPo.update({ where: { id: poId }, data: { contractId: newContractId } });
  await audit({
    entityType: "document",
    entityId: poId,
    action: "hm.po.reassigned",
    actor,
    data: { from: prev, to: newContractId, orderNo: po.orderNo },
  });
}

function safeArr(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map((s) => String(s)) : [];
  } catch {
    return [];
  }
}
