/**
 * Scan a source folder (either a directory of .msg Outlook files OR a parent
 * directory of per-order subfolders) and return a PREVIEW of what would be
 * imported. The actual import is a separate step (`commitScannedOrders`)
 * so the UI can show "Detected Orders" + status before anything is written.
 *
 * Nothing invents data: a .msg (or subfolder) that yields fewer than the three
 * required PDF kinds is reported as "Missing file" with the kinds it DID find.
 *
 * Two layouts are auto-detected:
 *   1. Directory contains `.msg` files           → each .msg groups its 3 PDFs by Order No.
 *   2. Directory contains per-order subfolders   → each subfolder's loose PDFs are classified.
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, basename } from "node:path";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { uploadSalesContractPdfSet, type SalesContractUploadFile } from "./intake";
import type { SalesContractPdfKind } from "./types";
// @ts-ignore
import pdfParse from "pdf-parse/lib/pdf-parse.js";

const PDF_HEAD = Buffer.from("%PDF-", "latin1");
const PDF_EOF  = Buffer.from("%%EOF", "latin1");
const REQUIRED_KINDS: SalesContractPdfKind[] = ["PurchaseOrder", "SizePerColourBreakdown", "TotalCountryBreakdown"];

export interface DetectedFile {
  name: string;
  sizeBytes: number;
  /** Which .msg or subfolder it came from, for the "FOLDER" column. */
  from: string;
}

export interface DetectedOrder {
  orderNo: string | null;             // "643159-8756" or null if nothing extracted
  sourceGroup: string;                // basename of the .msg or subfolder
  files: Partial<Record<SalesContractPdfKind, DetectedFile>>;
  status: "complete" | "missing" | "duplicate" | "error";
  reason: string;
  totalBytes: number;
}

export interface ScanPreview {
  parentPath: string;
  layout: "msg" | "subfolders" | "mixed" | "flat-pdfs";
  foldersFound: number;               // # of .msg files OR subfolders at the top level
  completeSets: number;
  missingSets: number;
  duplicateSets: number;
  pdfsFound: number;
  orders: DetectedOrder[];
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function* findAllOffsets(hay: Buffer, needle: Buffer): Generator<number> {
  let i = 0;
  while (true) {
    const n = hay.indexOf(needle, i);
    if (n < 0) return;
    yield n;
    i = n + 1;
  }
}

function extractEmbeddedPdfBuffers(msgBytes: Buffer): Buffer[] {
  const seen = new Set<string>();
  const out: Buffer[] = [];
  for (const start of findAllOffsets(msgBytes, PDF_HEAD)) {
    const eofIdx = msgBytes.indexOf(PDF_EOF, start);
    if (eofIdx < 0) continue;
    const end = Math.min(eofIdx + PDF_EOF.length + 1024, msgBytes.length);
    const slice = msgBytes.subarray(start, end);
    const h = sha256(slice);
    if (seen.has(h)) continue;
    seen.add(h);
    out.push(slice);
  }
  return out;
}

interface ClassifiedPdf {
  bytes: Buffer;
  sha256: string;
  sizeBytes: number;
  kind: SalesContractPdfKind | "unknown";
  orderNo: string | null;
  originalName: string;
  from: string;
}

async function classify(buf: Buffer, originalName: string, from: string): Promise<ClassifiedPdf> {
  const h = sha256(buf);
  let kind: ClassifiedPdf["kind"] = "unknown";
  let orderNo: string | null = null;
  try {
    const parsed = await pdfParse(buf);
    const text: string = parsed.text ?? "";
    const head = text.slice(0, 20_000);
    const hasPO = /Purchase Order/i.test(head);
    const hasInv = /Invoice Average Price/i.test(head);
    const hasSize = /Size\s*\/\s*Colour Breakdown/i.test(head) || /Size\s*Per\s*Colour\s*Breakdown/i.test(head);
    const hasCountry = /Total\s*Country\s*Breakdown/i.test(head);
    if (hasPO && hasInv) kind = "PurchaseOrder";
    else if (hasSize) kind = "SizePerColourBreakdown";
    else if (hasCountry) kind = "TotalCountryBreakdown";
    else if (hasPO) kind = "PurchaseOrder";
    const m = head.match(/\b(\d{6})-(\d{3,5})\b/);
    if (m) orderNo = `${m[1]}-${m[2]}`;
  } catch {
    // leave as unknown
  }
  return { bytes: buf, sha256: h, sizeBytes: buf.length, kind, orderNo, originalName, from };
}

/**
 * Walk a top-level entry (either a `.msg` file or a subfolder) and return the
 * classified PDFs it exposes. Used by both preview and commit.
 */
async function pdfsFromEntry(fullPath: string, dirEntry: { isFile: () => boolean; isDirectory: () => boolean; name: string }): Promise<ClassifiedPdf[]> {
  const out: ClassifiedPdf[] = [];
  if (dirEntry.isFile() && dirEntry.name.toLowerCase().endsWith(".msg")) {
    const bytes = await readFile(fullPath);
    for (const b of extractEmbeddedPdfBuffers(bytes)) {
      out.push(await classify(b, dirEntry.name, dirEntry.name));
    }
    return out;
  }
  if (dirEntry.isDirectory()) {
    // Subfolder: pick up every loose .pdf plus every .msg inside.
    const inner = await readdir(fullPath, { withFileTypes: true });
    for (const child of inner) {
      const childPath = join(fullPath, child.name);
      if (child.isFile() && child.name.toLowerCase().endsWith(".pdf")) {
        try {
          const bytes = await readFile(childPath);
          out.push(await classify(bytes, child.name, dirEntry.name));
        } catch {
          // ignore unreadable child
        }
      } else if (child.isFile() && child.name.toLowerCase().endsWith(".msg")) {
        const bytes = await readFile(childPath);
        for (const b of extractEmbeddedPdfBuffers(bytes)) {
          out.push(await classify(b, child.name, dirEntry.name));
        }
      }
    }
    return out;
  }
  return out;
}

async function readTopEntries(dir: string): Promise<{ msgs: { name: string }[]; subdirs: { name: string }[] }> {
  const entries = await readdir(dir, { withFileTypes: true });
  const msgs: { name: string }[] = [];
  const subdirs: { name: string }[] = [];
  for (const e of entries) {
    if (e.isDirectory()) subdirs.push({ name: e.name });
    else if (e.isFile() && e.name.toLowerCase().endsWith(".msg")) msgs.push({ name: e.name });
  }
  msgs.sort((a, b) => a.name.localeCompare(b.name));
  subdirs.sort((a, b) => a.name.localeCompare(b.name));
  return { msgs, subdirs };
}

export interface ScanInput {
  contractId: string;
  folderLetter: string;
  /** Optional override of SalesContractFolderMapping.sourceFolderPath. */
  parentPath?: string;
  actor?: string;
}

async function resolveParentPath(input: ScanInput): Promise<string> {
  if (input.parentPath && input.parentPath.trim().length > 0) return input.parentPath.trim();
  const mapping = await prisma.salesContractFolderMapping.findUnique({ where: { folderLetter: input.folderLetter } });
  if (!mapping) throw new Error(`Folder '${input.folderLetter}' is not configured. Go to /sales-contract/config.`);
  if (!mapping.sourceFolderPath) throw new Error(`Folder '${input.folderLetter}' has no source path configured.`);
  return mapping.sourceFolderPath;
}

/** Dry-run: show the user what WOULD be imported. */
export async function previewScan(input: ScanInput): Promise<ScanPreview> {
  const parentPath = await resolveParentPath(input);
  const dirStat = await stat(parentPath).catch((e: unknown) => {
    throw new Error(`Cannot read ${parentPath}: ${e instanceof Error ? e.message : String(e)}`);
  });
  if (!dirStat.isDirectory()) throw new Error(`${parentPath} is not a directory`);

  const { msgs, subdirs } = await readTopEntries(parentPath);
  const layout: ScanPreview["layout"] =
    msgs.length > 0 && subdirs.length > 0 ? "mixed"
    : msgs.length > 0 ? "msg"
    : subdirs.length > 0 ? "subfolders"
    : "flat-pdfs";

  const entries: { name: string; isFile: () => boolean; isDirectory: () => boolean }[] = [
    ...msgs.map((m) => ({ name: m.name, isFile: () => true, isDirectory: () => false })),
    ...subdirs.map((d) => ({ name: d.name, isFile: () => false, isDirectory: () => true })),
  ];

  // Group discovered PDFs by (sourceGroup, orderNo-fallback). The user mockup
  // wants ONE row per order; when a single .msg carries multiple orders they
  // become separate rows (handled below after flattening).
  const grouped = new Map<string, DetectedOrder>();
  let pdfsFound = 0;

  for (const entry of entries) {
    const sourceGroup = entry.name;
    const pdfs = await pdfsFromEntry(join(parentPath, entry.name), entry);
    pdfsFound += pdfs.length;
    const relevant = pdfs.filter((p) => p.orderNo && p.kind !== "unknown");
    const orderNos = Array.from(new Set(relevant.map((p) => p.orderNo as string)));
    const bucketKeys = orderNos.length > 0 ? orderNos : [`${sourceGroup}::no-order`];
    for (const orderNo of bucketKeys) {
      const key = `${sourceGroup}::${orderNo}`;
      const existing = grouped.get(key);
      const bucket: DetectedOrder = existing ?? {
        orderNo: orderNos.length > 0 ? orderNo : null,
        sourceGroup,
        files: {},
        status: "missing",
        reason: "",
        totalBytes: 0,
      };
      for (const p of pdfs) {
        if (p.kind === "unknown") continue;
        if (bucketKeys.length > 1 && p.orderNo !== orderNo) continue; // multi-PO .msg: filter by order
        if (bucket.files[p.kind]) continue; // first wins
        bucket.files[p.kind] = { name: p.originalName, sizeBytes: p.sizeBytes, from: p.from };
        bucket.totalBytes += p.sizeBytes;
      }
      grouped.set(key, bucket);
    }
  }

  // Compute status + dedup against existing SalesContractPo rows for this contract.
  const existingOrderNos = new Set(
    (await prisma.salesContractPo.findMany({
      where: { contractId: input.contractId, orderNo: { in: Array.from(grouped.values()).map((o) => o.orderNo).filter(Boolean) as string[] } },
      select: { orderNo: true },
    })).map((p) => p.orderNo),
  );

  const orders: DetectedOrder[] = [];
  for (const o of grouped.values()) {
    const missing = REQUIRED_KINDS.filter((k) => !o.files[k]);
    if (!o.orderNo) {
      o.status = "error";
      o.reason = "Order No could not be extracted from any PDF in this group.";
    } else if (existingOrderNos.has(o.orderNo)) {
      o.status = "duplicate";
      o.reason = "Already imported — will be skipped.";
    } else if (missing.length === 0) {
      o.status = "complete";
      o.reason = "";
    } else {
      o.status = "missing";
      o.reason = `Missing ${missing.join(", ")}`;
    }
    orders.push(o);
  }

  // Sort: complete first, then missing, then duplicate, then error.
  const rank = { complete: 0, missing: 1, duplicate: 2, error: 3 } as const;
  orders.sort((a, b) => rank[a.status] - rank[b.status] || (a.orderNo ?? "").localeCompare(b.orderNo ?? ""));

  return {
    parentPath,
    layout,
    foldersFound: entries.length,
    pdfsFound,
    completeSets: orders.filter((o) => o.status === "complete").length,
    missingSets: orders.filter((o) => o.status === "missing").length,
    duplicateSets: orders.filter((o) => o.status === "duplicate").length,
    orders,
  };
}

/** Commit: run uploadSalesContractPdfSet for every complete order. */
export interface CommitResult {
  imported: { orderNo: string; poId: string }[];
  skipped: { orderNo: string; reason: string }[];
}

export async function commitScannedOrders(input: ScanInput & { orderNos?: string[] }): Promise<CommitResult> {
  const parentPath = await resolveParentPath(input);
  const { msgs, subdirs } = await readTopEntries(parentPath);
  const entries: { name: string; isFile: () => boolean; isDirectory: () => boolean }[] = [
    ...msgs.map((m) => ({ name: m.name, isFile: () => true, isDirectory: () => false })),
    ...subdirs.map((d) => ({ name: d.name, isFile: () => false, isDirectory: () => true })),
  ];
  const actor = input.actor ?? "system";
  const filter = input.orderNos ? new Set(input.orderNos) : null;

  // Rebuild grouping (same logic as preview).
  const grouped = new Map<string, { orderNo: string; files: Partial<Record<SalesContractPdfKind, { buffer: Buffer; name: string }>> }>();
  for (const entry of entries) {
    const pdfs = await pdfsFromEntry(join(parentPath, entry.name), entry);
    const relevant = pdfs.filter((p) => p.orderNo && p.kind !== "unknown");
    const orderNos = Array.from(new Set(relevant.map((p) => p.orderNo as string)));
    for (const orderNo of orderNos) {
      if (filter && !filter.has(orderNo)) continue;
      const key = orderNo;
      const bucket = grouped.get(key) ?? { orderNo, files: {} };
      for (const p of pdfs) {
        if (p.kind === "unknown" || p.orderNo !== orderNo) continue;
        if (bucket.files[p.kind]) continue;
        bucket.files[p.kind] = { buffer: p.bytes, name: p.originalName };
      }
      grouped.set(key, bucket);
    }
  }

  const result: CommitResult = { imported: [], skipped: [] };
  for (const b of grouped.values()) {
    const missing = REQUIRED_KINDS.filter((k) => !b.files[k]);
    if (missing.length > 0) { result.skipped.push({ orderNo: b.orderNo, reason: `missing ${missing.join(",")}` }); continue; }
    const existing = await prisma.salesContractPo.findUnique({ where: { contractId_orderNo: { contractId: input.contractId, orderNo: b.orderNo } } });
    if (existing) { result.skipped.push({ orderNo: b.orderNo, reason: "already imported" }); continue; }
    // The uploader validates filename extension — our PDFs may have come
    // from a .msg container; rename them to `<orderNo>_<kind>.pdf` so the
    // extension check passes. The buffer is already a real PDF.
    const files: SalesContractUploadFile[] = REQUIRED_KINDS.map((k) => {
      const f = b.files[k]!;
      const originalIsPdf = /\.pdf$/i.test(f.name);
      const name = originalIsPdf ? f.name : `${b.orderNo}_${k}.pdf`;
      return { name, buffer: f.buffer, kind: k };
    });
    try {
      const { poId } = await uploadSalesContractPdfSet(input.contractId, files, { actor, folderLetter: input.folderLetter });
      result.imported.push({ orderNo: b.orderNo, poId });
    } catch (e) {
      result.skipped.push({ orderNo: b.orderNo, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  await audit({
    entityType: "contract", entityId: input.contractId,
    action: "sales-contract.folder.commit", actor,
    data: { folderLetter: input.folderLetter, parentPath, imported: result.imported.length, skipped: result.skipped.length },
  });
  return result;
}

// Backwards-compatibility wrapper: the old `scanConfiguredFolder` did
// preview + commit in one step. The new scan button calls preview + commit
// separately; keep this helper for the one-click action that still exists.
export async function scanConfiguredFolder(input: ScanInput): Promise<{ preview: ScanPreview; commit: CommitResult }> {
  const preview = await previewScan(input);
  const complete = preview.orders.filter((o) => o.status === "complete" && o.orderNo).map((o) => o.orderNo as string);
  const commit = await commitScannedOrders({ ...input, orderNos: complete });
  return { preview, commit };
}

export { basename as _basename };
