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
// @ts-ignore
import MsgReader from "@kenjiuno/msgreader";
import JSZip from "jszip";

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

/**
 * Attachment extracted from an Outlook .msg file. `sourceName` is what the
 * container (zip entry name or .msg attachment name) called this PDF — the
 * orderNo + Creation-date timestamp are usually encoded in it, e.g.
 *   `557887_PurchaseOrder_Supplier_20260127_040721.pdf`
 */
export interface ExtractedPdf {
  bytes: Buffer;
  sourceName: string;
}

/**
 * Pull every PDF out of a .msg file. Supports both wire formats Outlook uses:
 *
 *   1. **MIME / RFC822** .msg — PDFs appear as raw %PDF-…%%EOF byte ranges
 *      somewhere in the file. The legacy raw-byte scan handles these.
 *   2. **CFB / OLE2** .msg (Compound Document, magic `D0 CF 11 E0`) — the
 *      format newer Outlook versions save by default. Attachments live in
 *      CFB streams and the raw %PDF- bytes aren't contiguous, so a byte
 *      scan returns zero PDFs. We use `@kenjiuno/msgreader` to decode the
 *      compound structure, then unzip any `*.zip` attachments to recover
 *      the PDFs inside (H&M emails package the three PDFs per order as a
 *      zip named `<orderNo>_<kind>_Supplier_<yyyymmdd>_<hhmmss>.zip`).
 *
 * Attachments that aren't PDFs or zips (inline images, signatures) are
 * silently ignored. Encrypted or password-protected zips return nothing.
 */
export async function extractEmbeddedPdfBuffers(msgBytes: Buffer): Promise<ExtractedPdf[]> {
  const seen = new Set<string>();
  const out: ExtractedPdf[] = [];

  // Path 1: raw %PDF- byte scan (MIME-format .msg or any binary that
  // happens to carry contiguous PDF bytes).
  for (const start of findAllOffsets(msgBytes, PDF_HEAD)) {
    const eofIdx = msgBytes.indexOf(PDF_EOF, start);
    if (eofIdx < 0) continue;
    const end = Math.min(eofIdx + PDF_EOF.length + 1024, msgBytes.length);
    const slice = Buffer.from(msgBytes.subarray(start, end));
    const h = sha256(slice);
    if (seen.has(h)) continue;
    seen.add(h);
    out.push({ bytes: slice, sourceName: "" });
  }

  // Path 2: CFB-format .msg — detected by the OLE2 magic 0xD0CF11E0A1B11AE1.
  const isCfb =
    msgBytes.length > 8 &&
    msgBytes[0] === 0xd0 &&
    msgBytes[1] === 0xcf &&
    msgBytes[2] === 0x11 &&
    msgBytes[3] === 0xe0 &&
    msgBytes[4] === 0xa1 &&
    msgBytes[5] === 0xb1 &&
    msgBytes[6] === 0x1a &&
    msgBytes[7] === 0xe1;
  if (isCfb) {
    try {
      // msgreader wants an ArrayBuffer, not a Node Buffer.
      const ab = msgBytes.buffer.slice(msgBytes.byteOffset, msgBytes.byteOffset + msgBytes.byteLength);
      const reader = new (MsgReader as any)(ab);
      const info = reader.getFileData();
      const atts: any[] = Array.isArray(info?.attachments) ? info.attachments : [];
      for (const a of atts) {
        const name: string = (a?.fileName || a?.name || "").trim();
        const content = reader.getAttachment(a);
        const bytes: Uint8Array | undefined = content?.content;
        if (!bytes || bytes.length < 10) continue;
        if (/\.pdf$/i.test(name) || isPdfBytes(bytes)) {
          const buf = Buffer.from(bytes);
          const h = sha256(buf);
          if (!seen.has(h)) { seen.add(h); out.push({ bytes: buf, sourceName: name }); }
          continue;
        }
        if (/\.zip$/i.test(name) || isZipBytes(bytes)) {
          try {
            const zip = await JSZip.loadAsync(Buffer.from(bytes));
            for (const [entryName, entry] of Object.entries(zip.files)) {
              if (entry.dir) continue;
              if (!/\.pdf$/i.test(entryName)) continue;
              const pdfBytes = await entry.async("nodebuffer");
              if (!isPdfBytes(pdfBytes)) continue;
              const h = sha256(pdfBytes);
              if (seen.has(h)) continue;
              seen.add(h);
              out.push({ bytes: pdfBytes, sourceName: entryName });
            }
          } catch { /* bad / encrypted zip — skip */ }
        }
      }
    } catch { /* msgreader can't parse — fall back to raw-byte PDFs already collected */ }
  }

  return out;
}

function isPdfBytes(b: Uint8Array): boolean {
  return b.length >= 5 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d;
}
function isZipBytes(b: Uint8Array): boolean {
  // PKZIP local file header "PK\x03\x04"
  return b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
}

interface ClassifiedPdf {
  bytes: Buffer;
  sha256: string;
  sizeBytes: number;
  kind: SalesContractPdfKind | "unknown";
  orderNo: string | null;
  originalName: string;
  from: string;
  /** Creation date hint parsed from the H&M filename pattern
   *  `<orderNo>_<kind>_Supplier_<yyyymmdd>_<hhmmss>.pdf`. Empty when the
   *  filename doesn't follow that pattern. The PO text's "Creation date:"
   *  label (if present) still wins in the parser; this is a fallback for
   *  PDFs that don't carry the label. */
  filenameCreationDate: string;
}

async function classify(buf: Buffer, originalName: string, from: string): Promise<ClassifiedPdf> {
  const h = sha256(buf);
  let kind: ClassifiedPdf["kind"] = "unknown";
  let orderNo: string | null = null;
  let pdfText = "";
  try {
    const parsed = await pdfParse(buf);
    pdfText = parsed.text ?? "";
    const head = pdfText.slice(0, 20_000);
    const hasPO = /Purchase Order/i.test(head);
    const hasInv = /Invoice Average Price/i.test(head);
    const hasSize = /Size\s*\/\s*Colour Breakdown/i.test(head) || /Size\s*Per\s*Colour\s*Breakdown/i.test(head);
    const hasCountry = /Total\s*Country\s*Breakdown/i.test(head);
    if (hasPO && hasInv) kind = "PurchaseOrder";
    else if (hasSize) kind = "SizePerColourBreakdown";
    else if (hasCountry) kind = "TotalCountryBreakdown";
    else if (hasPO) kind = "PurchaseOrder";
  } catch {
    // leave as unknown
  }
  if (kind === "unknown") {
    // Filename-based classifier for H&M's standard naming — needed when the
    // PDF text layer is missing (image-scanned) or pdf-parse chokes.
    const fnKind = classifyByFilename(originalName);
    if (fnKind) kind = fnKind;
  }
  orderNo = extractOrderNoFromAll(pdfText, originalName, from);
  const filenameCreationDate = extractCreationDateFromFilename(originalName);
  return { bytes: buf, sha256: h, sizeBytes: buf.length, kind, orderNo, originalName, from, filenameCreationDate };
}

/**
 * Classify an H&M PDF by its filename. The emails Ananta receives from H&M
 * package the three PDFs with a strict naming:
 *   `<orderNo>_PurchaseOrder_Supplier_<yyyymmdd>_<hhmmss>.pdf`
 *   `<orderNo>_SizePerColourBreakdown_Supplier_<yyyymmdd>_<hhmmss>.pdf`
 *   `<orderNo>_TotalCountryBreakdown_Supplier_<yyyymmdd>_<hhmmss>.pdf`
 */
function classifyByFilename(name: string): SalesContractPdfKind | null {
  const low = name.toLowerCase();
  if (/_purchaseorder[_.]/.test(low)) return "PurchaseOrder";
  if (/_sizepercolourbreakdown[_.]/.test(low)) return "SizePerColourBreakdown";
  if (/_totalcountrybreakdown[_.]/.test(low)) return "TotalCountryBreakdown";
  return null;
}

/**
 * Pull the `yyyymmdd_hhmmss` timestamp out of an H&M attachment / zip-entry
 * filename and format it as `yyyy-mm-dd HH:MM:SS`. Used as a Creation-date
 * fallback when the PO PDF itself has no "Creation date" label (every H&M
 * PO so far has the timestamp in its filename).
 *
 * Returns empty string if the pattern isn't found.
 */
export function extractCreationDateFromFilename(name: string): string {
  const m = name.match(/_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})\b/);
  if (!m) return "";
  return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}`;
}

/**
 * Earliest filename timestamp among the PDFs in a commit bucket, as a Unix
 * ms epoch. Used only to sort buckets at submission time so the audit log
 * reads chronologically — the server-side arbitration doesn't care about
 * ordering (the newest Creation date always wins in the end).
 */
function creationTimestampFromBucket(b: { files: Partial<Record<SalesContractPdfKind, { name: string }>> }): number {
  let best = Number.POSITIVE_INFINITY;
  for (const f of Object.values(b.files)) {
    if (!f?.name) continue;
    const s = extractCreationDateFromFilename(f.name);
    if (!s) continue;
    const d = new Date(s.replace(" ", "T") + "Z").getTime();
    if (Number.isFinite(d) && d < best) best = d;
  }
  return Number.isFinite(best) ? best : 0;
}

/**
 * Resolve the Order No for a PDF by looking in three places in order:
 *   1. The PDF text (any `Order No:` labelled value, or a `NNNNNN-NNNN`
 *      pattern anywhere in the full text — not just the first 20 KB).
 *   2. The original PDF filename (H&M files are typically named like
 *      `600349.pdf` / `600349-7656 AUW118.pdf`).
 *   3. The source group / parent folder name (same convention as the
 *      filename, used when the PDF is image-scanned and has no text layer).
 *
 * Supports:
 *   - 5-7 digit prefix + "-" + 3-6 digit suffix (`600349-7656`)
 *   - Same with a slash separator (`569959/3-2026`)
 *   - A bare 5-7 digit number when nothing better is found (last resort,
 *     so a filename like `600349.pdf` still produces an orderNo).
 */
export function extractOrderNoFromAll(pdfText: string, originalName: string, from: string): string | null {
  if (pdfText) {
    // Prefer a labelled `Order No: <value>` match (robust against the text
    // appearing deep in the PDF).
    const labelled = pdfText.match(/Order\s*No\.?\s*:?\s*([0-9][0-9A-Z\-/]{4,20})/i);
    if (labelled) {
      const picked = pickOrderNoShape(labelled[1]);
      if (picked) return picked;
    }
    const anywhere = pickOrderNoFromFreeText(pdfText);
    if (anywhere) return anywhere;
  }
  const fromName = pickOrderNoFromFreeText(originalName);
  if (fromName) return fromName;
  const fromFolder = pickOrderNoFromFreeText(from);
  if (fromFolder) return fromFolder;
  return null;
}

function pickOrderNoFromFreeText(s: string): string | null {
  if (!s) return null;
  // Prefix-suffix with dash (`600349-7656`, `1234567-89012`).
  const dash = s.match(/\b(\d{5,7})-(\d{3,6})\b/);
  if (dash) return `${dash[1]}-${dash[2]}`;
  // Slash separator (`569959/3-2026` — H&M revision suffix).
  const slash = s.match(/\b(\d{5,7})\/(\d{1,3})-(\d{4})\b/);
  if (slash) return `${slash[1]}/${slash[2]}-${slash[3]}`;
  // Bare 6-digit number — common on filenames (`600349.pdf`).
  const bare = s.match(/\b(\d{6})\b/);
  if (bare) return bare[1];
  return null;
}

function pickOrderNoShape(raw: string): string | null {
  const s = raw.trim();
  const dash = s.match(/^(\d{5,7})-(\d{3,6})$/);
  if (dash) return `${dash[1]}-${dash[2]}`;
  const slash = s.match(/^(\d{5,7})\/(\d{1,3})-(\d{4})$/);
  if (slash) return `${slash[1]}/${slash[2]}-${slash[3]}`;
  const bare = s.match(/^(\d{5,7})$/);
  if (bare) return bare[1];
  return null;
}

/**
 * Walk a top-level entry (either a `.msg` file or a subfolder) and return the
 * classified PDFs it exposes. Used by both preview and commit.
 */
async function pdfsFromEntry(fullPath: string, dirEntry: { isFile: () => boolean; isDirectory: () => boolean; name: string }): Promise<ClassifiedPdf[]> {
  const out: ClassifiedPdf[] = [];
  if (dirEntry.isFile() && dirEntry.name.toLowerCase().endsWith(".msg")) {
    const bytes = await readFile(fullPath);
    // Prefer the inner (zip-entry or attachment) filename as the PDF's own
    // name — H&M emails package files with the orderNo + Creation-date
    // timestamp in the filename (`557887_PurchaseOrder_Supplier_<yyyymmdd>_<hhmmss>.pdf`).
    // Fall back to the .msg filename when no inner name is available (raw
    // byte scan of MIME-format mails).
    for (const p of await extractEmbeddedPdfBuffers(bytes)) {
      out.push(await classify(p.bytes, p.sourceName || dirEntry.name, dirEntry.name));
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
        for (const p of await extractEmbeddedPdfBuffers(bytes)) {
          out.push(await classify(p.bytes, p.sourceName || child.name, dirEntry.name));
        }
      }
    }
    return out;
  }
  return out;
}

async function readTopEntries(dir: string): Promise<{ msgs: { name: string }[]; subdirs: { name: string }[] }> {
  const entries = await readdir(dir, { withFileTypes: true }).catch((e: unknown) => {
    const base = e instanceof Error ? e.message : String(e);
    const isMissing = /ENOENT/i.test(base);
    const hint = isMissing
      ? ` The scan runs on the UCP server, not your PC — fix the "Source folder" path at ` +
        `/sales-contract/config or override it in the "Source folder" box on the scanner page.`
      : "";
    throw new Error(`Cannot list ${dir}: ${base}.${hint}`);
  });
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
    const base = e instanceof Error ? e.message : String(e);
    // The scan runs on the SERVER's filesystem, not the user's PC. In a
    // hosted deployment the configured path (saved during local dev) is
    // very likely missing on the server, so spell this out instead of
    // bubbling the raw ENOENT up.
    const isMissing = /ENOENT/i.test(base);
    const hint = isMissing
      ? ` The scan runs on the UCP server, so this path must exist THERE — not on your own PC. ` +
        `Fix it in /sales-contract/config (set the folder's "Source folder" to a path the server can see, ` +
        `e.g. a mounted network share \\\\server\\share\\...), or type a different path in the "Source folder" ` +
        `box above and scan again.`
      : "";
    throw new Error(`Cannot read ${parentPath}: ${base}.${hint}`);
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

  // Note: no pre-check against existing SalesContractPo rows anymore. Any
  // orderNo that already exists is routed through the Creation-date
  // arbitration at commit time (user rule 2026-11-01):
  //   - newer scan wins → existing row refreshed in its original contract
  //   - same creation date → no-op (idempotent)
  //   - older → scan rejected with warning
  // Marking it "duplicate" at preview time would hide the re-scan from the
  // commit step and the user would see "nothing to import" even when the
  // scan carries a NEWER copy. Leave the status as "complete" / "missing"
  // / "error" based purely on PDF availability, and let the server decide.
  const orders: DetectedOrder[] = [];
  for (const o of grouped.values()) {
    const missing = REQUIRED_KINDS.filter((k) => !o.files[k]);
    if (!o.orderNo) {
      o.status = "error";
      o.reason = "Order No could not be extracted from any PDF in this group.";
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
  /**
   * Orders whose scan was processed but did NOT add a new row — because a
   * copy already existed (same or newer creation date wins over the scanned
   * copy, or the scanned copy was newer and refreshed an existing row in its
   * original contract). Shows the user why no new row appeared.
   */
  updates: { orderNo: string; outcome: "replaced" | "duplicate" | "rejected"; message: string; existingContractId: string | null }[];
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

  // Group by (sourceGroup, orderNo) — one bucket per .msg's version of
  // each order. When the same orderNo appears in multiple .msg files (an
  // updated PO re-sent to the supplier), every version is submitted to the
  // server; the Creation-date arbitration in intake decides which wins
  // (user rule 2026-11-01).
  interface CommitBucket {
    orderNo: string;
    sourceGroup: string;
    files: Partial<Record<SalesContractPdfKind, { buffer: Buffer; name: string }>>;
  }
  const grouped = new Map<string, CommitBucket>();
  for (const entry of entries) {
    const sourceGroup = entry.name;
    const pdfs = await pdfsFromEntry(join(parentPath, entry.name), entry);
    const relevant = pdfs.filter((p) => p.orderNo && p.kind !== "unknown");
    const orderNos = Array.from(new Set(relevant.map((p) => p.orderNo as string)));
    for (const orderNo of orderNos) {
      if (filter && !filter.has(orderNo)) continue;
      const key = `${sourceGroup}::${orderNo}`;
      const bucket = grouped.get(key) ?? { orderNo, sourceGroup, files: {} };
      for (const p of pdfs) {
        if (p.kind === "unknown" || p.orderNo !== orderNo) continue;
        if (bucket.files[p.kind]) continue; // first wins WITHIN one source group
        bucket.files[p.kind] = { buffer: p.bytes, name: p.originalName };
      }
      grouped.set(key, bucket);
    }
  }

  // Submit buckets oldest-filename-timestamp FIRST so the Creation-date
  // arbitration sees them in natural chronological order (oldest → newer
  // → newest). This makes the audit log readable; the final outcome is
  // the same regardless of submission order (newest always wins).
  const buckets = Array.from(grouped.values()).sort((a, b) => {
    const ta = creationTimestampFromBucket(a);
    const tb = creationTimestampFromBucket(b);
    if (ta !== tb) return ta - tb;
    return a.orderNo.localeCompare(b.orderNo);
  });

  const result: CommitResult = { imported: [], updates: [], skipped: [] };
  for (const b of buckets) {
    const missing = REQUIRED_KINDS.filter((k) => !b.files[k]);
    if (missing.length > 0) { result.skipped.push({ orderNo: b.orderNo, reason: `missing ${missing.join(",")}` }); continue; }
    // NOTE: no "already imported" early skip. Intake now handles re-scans by
    // comparing the incoming PO PDF's Creation date against the stored copy:
    // newer wins (updates in place), same is idempotent, older is rejected
    // with a BLOCKED placeholder. See processSalesContractPoSet (user rule
    // 2026-11-01).
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
      const res = await uploadSalesContractPdfSet(input.contractId, files, { actor, folderLetter: input.folderLetter });
      if (res.outcome === "inserted") {
        result.imported.push({ orderNo: b.orderNo, poId: res.poId });
      } else if (res.outcome === "failed") {
        result.skipped.push({ orderNo: b.orderNo, reason: res.message || "extraction failed" });
      } else {
        result.updates.push({
          orderNo: b.orderNo,
          outcome: res.outcome,
          message: res.message,
          existingContractId: res.existingContractId,
        });
      }
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

// ---------------------------------------------------------------------------
// Browser-upload variant (user rule 2026-11-03) — the user picks a folder on
// their own PC via `<input type="file" webkitdirectory>` and the browser
// uploads every file inside. The server never touches the user's filesystem.
// We reuse the exact classifier + grouping + Creation-date arbitration the
// filesystem path uses, just driven by in-memory buffers.
// ---------------------------------------------------------------------------

/** One file carried in a browser upload. `relativePath` is what the browser
 *  reports (e.g. "A/557887.msg"); if missing we fall back to `name`. */
export interface UploadedBuffer {
  name: string;
  relativePath: string;
  bytes: Buffer;
}

/** Walk one uploaded file and return the classified PDFs it exposes. */
async function pdfsFromUpload(file: UploadedBuffer): Promise<ClassifiedPdf[]> {
  const out: ClassifiedPdf[] = [];
  const parent = parentOfPath(file.relativePath);
  if (/\.msg$/i.test(file.name)) {
    for (const p of await extractEmbeddedPdfBuffers(file.bytes)) {
      out.push(await classify(p.bytes, p.sourceName || file.name, file.name));
    }
    return out;
  }
  if (/\.pdf$/i.test(file.name)) {
    out.push(await classify(file.bytes, file.name, parent || file.name));
    return out;
  }
  return out;
}

function parentOfPath(rel: string): string {
  const i = Math.max(rel.lastIndexOf("/"), rel.lastIndexOf("\\"));
  return i < 0 ? "" : rel.slice(0, i);
}

/**
 * Preview a folder picked on the user's PC. Each uploaded `.msg` becomes
 * one "source group" (its own filename); each loose `.pdf` groups under
 * its parent-folder path. The returned shape matches `previewScan` so the
 * Scanner UI can treat both flavours identically.
 */
export async function previewScanFromUploads(
  files: UploadedBuffer[],
): Promise<Omit<ScanPreview, "parentPath"> & { parentPath: string }> {
  const entries = Array.from(new Set(files.map((f) => f.relativePath || f.name)));
  const grouped = new Map<string, DetectedOrder>();
  let pdfsFound = 0;

  for (const file of files) {
    const sourceGroup = /\.msg$/i.test(file.name) ? file.name : (parentOfPath(file.relativePath) || file.name);
    const pdfs = await pdfsFromUpload(file);
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
        if (bucketKeys.length > 1 && p.orderNo !== orderNo) continue;
        if (bucket.files[p.kind]) continue;
        bucket.files[p.kind] = { name: p.originalName, sizeBytes: p.sizeBytes, from: p.from };
        bucket.totalBytes += p.sizeBytes;
      }
      grouped.set(key, bucket);
    }
  }

  const orders: DetectedOrder[] = [];
  for (const o of grouped.values()) {
    const missing = REQUIRED_KINDS.filter((k) => !o.files[k]);
    if (!o.orderNo) {
      o.status = "error";
      o.reason = "Order No could not be extracted from any PDF in this group.";
    } else if (missing.length === 0) {
      o.status = "complete";
      o.reason = "";
    } else {
      o.status = "missing";
      o.reason = `Missing ${missing.join(", ")}`;
    }
    orders.push(o);
  }
  const rank = { complete: 0, missing: 1, duplicate: 2, error: 3 } as const;
  orders.sort((a, b) => rank[a.status] - rank[b.status] || (a.orderNo ?? "").localeCompare(b.orderNo ?? ""));

  const hasMsgs = files.some((f) => /\.msg$/i.test(f.name));
  const hasPdfs = files.some((f) => /\.pdf$/i.test(f.name));
  const layout: ScanPreview["layout"] = hasMsgs && hasPdfs ? "mixed" : hasMsgs ? "msg" : hasPdfs ? "flat-pdfs" : "subfolders";

  return {
    parentPath: "(uploaded from browser)",
    layout,
    foldersFound: entries.length,
    pdfsFound,
    completeSets: orders.filter((o) => o.status === "complete").length,
    missingSets: orders.filter((o) => o.status === "missing").length,
    duplicateSets: orders.filter((o) => o.status === "duplicate").length,
    orders,
  };
}

/**
 * Commit uploaded buffers. Groups by (sourceGroup × orderNo) and submits one
 * upload per bucket; the server-side Creation-date arbitration decides which
 * version wins when the same orderNo appears across multiple source groups.
 */
export async function commitScannedFromUploads(opts: {
  contractId: string;
  folderLetter: string;
  orderNos?: string[];
  actor?: string;
  files: UploadedBuffer[];
}): Promise<CommitResult> {
  const actor = opts.actor ?? "system";
  const filter = opts.orderNos ? new Set(opts.orderNos) : null;

  interface CommitBucket {
    orderNo: string;
    sourceGroup: string;
    files: Partial<Record<SalesContractPdfKind, { buffer: Buffer; name: string }>>;
  }
  const grouped = new Map<string, CommitBucket>();

  for (const file of opts.files) {
    const sourceGroup = /\.msg$/i.test(file.name) ? file.name : (parentOfPath(file.relativePath) || file.name);
    const pdfs = await pdfsFromUpload(file);
    const relevant = pdfs.filter((p) => p.orderNo && p.kind !== "unknown");
    const orderNos = Array.from(new Set(relevant.map((p) => p.orderNo as string)));
    for (const orderNo of orderNos) {
      if (filter && !filter.has(orderNo)) continue;
      const key = `${sourceGroup}::${orderNo}`;
      const bucket = grouped.get(key) ?? { orderNo, sourceGroup, files: {} };
      for (const p of pdfs) {
        if (p.kind === "unknown" || p.orderNo !== orderNo) continue;
        if (bucket.files[p.kind]) continue;
        bucket.files[p.kind] = { buffer: p.bytes, name: p.originalName };
      }
      grouped.set(key, bucket);
    }
  }

  const buckets = Array.from(grouped.values()).sort((a, b) => {
    const ta = creationTimestampFromBucket(a);
    const tb = creationTimestampFromBucket(b);
    if (ta !== tb) return ta - tb;
    return a.orderNo.localeCompare(b.orderNo);
  });

  const result: CommitResult = { imported: [], updates: [], skipped: [] };
  for (const b of buckets) {
    const missing = REQUIRED_KINDS.filter((k) => !b.files[k]);
    if (missing.length > 0) { result.skipped.push({ orderNo: b.orderNo, reason: `missing ${missing.join(",")}` }); continue; }
    const files: SalesContractUploadFile[] = REQUIRED_KINDS.map((k) => {
      const f = b.files[k]!;
      const originalIsPdf = /\.pdf$/i.test(f.name);
      const name = originalIsPdf ? f.name : `${b.orderNo}_${k}.pdf`;
      return { name, buffer: f.buffer, kind: k };
    });
    try {
      const res = await uploadSalesContractPdfSet(opts.contractId, files, { actor, folderLetter: opts.folderLetter });
      if (res.outcome === "inserted") {
        result.imported.push({ orderNo: b.orderNo, poId: res.poId });
      } else if (res.outcome === "failed") {
        result.skipped.push({ orderNo: b.orderNo, reason: res.message || "extraction failed" });
      } else {
        result.updates.push({
          orderNo: b.orderNo,
          outcome: res.outcome,
          message: res.message,
          existingContractId: res.existingContractId,
        });
      }
    } catch (e) {
      result.skipped.push({ orderNo: b.orderNo, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  await audit({
    entityType: "contract", entityId: opts.contractId,
    action: "sales-contract.folder.commit", actor,
    data: {
      folderLetter: opts.folderLetter,
      parentPath: "(uploaded from browser)",
      imported: result.imported.length,
      updates: result.updates.length,
      skipped: result.skipped.length,
    },
  });
  return result;
}

export { basename as _basename };
