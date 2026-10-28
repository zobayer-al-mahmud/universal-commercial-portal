/**
 * Pull the PDF attachments out of each .msg in a given folder.
 *
 * No external MSG library — the .msg is an OLE/CFB container but each PDF
 * attachment inside it is stored as a contiguous byte range that starts with
 * `%PDF-` and ends with `%%EOF`. We binary-scan for those boundaries and
 * de-dup by sha256 so repeated attachments (quoted replies) don't blow up.
 *
 * The PDFs are classified by sniffing recognisable text (`Purchase Order –
 * Online`, `Size Per Colour Breakdown`, `Total Country Breakdown`) from the
 * first 20 KB — the H&M supplier PDFs always carry these labels on page 1.
 * Nothing is invented: an unrecognised PDF is dumped under `unknown/` so the
 * caller can inspect it rather than silently misclassify.
 *
 * Usage:
 *   npx tsx scripts/sales-contract/extract-msg-pdfs.ts D:/order/A D:/order/A/_extracted
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, basename } from "node:path";
// @ts-ignore
import pdfParse from "pdf-parse";

const PDF_HEAD = Buffer.from("%PDF-", "latin1");
const PDF_EOF  = Buffer.from("%%EOF", "latin1");

interface ExtractedPdf {
  sha256: string;
  bytes: Buffer;
  text: string;
  kind: "PurchaseOrder" | "SizePerColourBreakdown" | "TotalCountryBreakdown" | "unknown";
  orderNo?: string;
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function findAll(hay: Buffer, needle: Buffer): number[] {
  const out: number[] = [];
  let i = 0;
  while (true) {
    const n = hay.indexOf(needle, i);
    if (n < 0) break;
    out.push(n);
    i = n + 1;
  }
  return out;
}

function extractPdfBuffers(msgBytes: Buffer): Buffer[] {
  const starts = findAll(msgBytes, PDF_HEAD);
  const buffers: Buffer[] = [];
  const seen = new Set<string>();
  for (const start of starts) {
    const eofIdx = msgBytes.indexOf(PDF_EOF, start);
    if (eofIdx < 0) continue;
    // Allow up to 1024 bytes past %%EOF for trailing LF / xref offset.
    const end = Math.min(eofIdx + PDF_EOF.length + 1024, msgBytes.length);
    const slice = msgBytes.subarray(start, end);
    const h = sha256(slice);
    if (seen.has(h)) continue;
    seen.add(h);
    buffers.push(slice);
  }
  return buffers;
}

async function classify(buf: Buffer): Promise<ExtractedPdf> {
  const h = sha256(buf);
  try {
    const parsed = await pdfParse(buf);
    const text = parsed.text ?? "";
    const head = text.slice(0, 20_000);
    let kind: ExtractedPdf["kind"] = "unknown";
    // Real H&M supplier PDFs use these page-1 titles:
    //   "Purchase Order – Online"
    //   "Size / Colour Breakdown – Online"      (slashes + en-dash)
    //   "Total Country Breakdown – Online"
    // (The .msg attachment filename pattern is `*_SizePerColourBreakdown_*.pdf`
    //  but the title text uses slashes — classify on the title.)
    const hasPO = /Purchase Order/i.test(head);
    const hasInv = /Invoice Average Price/i.test(head);
    const hasSize = /Size\s*\/\s*Colour Breakdown/i.test(head) || /Size\s*Per\s*Colour\s*Breakdown/i.test(head);
    const hasCountry = /Total\s*Country\s*Breakdown/i.test(head);
    if (hasPO && hasInv) kind = "PurchaseOrder";
    else if (hasSize) kind = "SizePerColourBreakdown";
    else if (hasCountry) kind = "TotalCountryBreakdown";
    else if (hasPO) kind = "PurchaseOrder"; // page-1 title only (short PO)
    const orderNoMatch = head.match(/\b(\d{6})-(\d{3,5})\b/);
    const orderNo = orderNoMatch ? `${orderNoMatch[1]}-${orderNoMatch[2]}` : undefined;
    return { sha256: h, bytes: buf, text, kind, orderNo };
  } catch (e) {
    return { sha256: h, bytes: buf, text: "", kind: "unknown" };
  }
}

async function main() {
  const srcDir = process.argv[2];
  const outDir = process.argv[3];
  if (!srcDir || !outDir) {
    console.error("usage: tsx scripts/sales-contract/extract-msg-pdfs.ts <msgDir> <outDir>");
    process.exit(2);
  }
  if (!existsSync(srcDir)) {
    console.error("src dir missing:", srcDir);
    process.exit(2);
  }
  mkdirSync(outDir, { recursive: true });

  const msgFiles = readdirSync(srcDir).filter((n) => n.toLowerCase().endsWith(".msg"));
  console.log(`[extract] ${srcDir} → ${msgFiles.length} .msg files`);

  const perMsg: { msg: string; pdfs: ExtractedPdf[] }[] = [];
  for (const name of msgFiles) {
    const full = join(srcDir, name);
    const bytes = readFileSync(full);
    const bufs = extractPdfBuffers(bytes);
    const pdfs: ExtractedPdf[] = [];
    for (const b of bufs) pdfs.push(await classify(b));
    perMsg.push({ msg: name, pdfs });
    console.log(`  ${name}: ${pdfs.length} pdf(s) → ${pdfs.map((p) => `${p.kind}${p.orderNo ? "/" + p.orderNo : ""}`).join(", ")}`);
  }

  // Group by orderNo, write each PO's three PDFs into a folder of its own.
  // When the same .msg carries more than one PO (joined names like
  // "645679_645670"), rely on each PDF's own orderNo rather than the filename.
  const byOrder = new Map<string, ExtractedPdf[]>();
  for (const m of perMsg) {
    for (const p of m.pdfs) {
      const key = p.orderNo ?? `__unknown_${p.sha256.slice(0, 8)}`;
      const bucket = byOrder.get(key) ?? [];
      // Dedup by (kind, sha) across the message set — repeated attachments
      // (quoted replies) resolve to one entry per kind.
      if (!bucket.some((b) => b.sha256 === p.sha256)) bucket.push(p);
      byOrder.set(key, bucket);
    }
  }

  const manifest: { order: string; dir: string; files: { kind: string; file: string; sha: string }[] }[] = [];
  for (const [order, pdfs] of byOrder) {
    const dir = join(outDir, order);
    mkdirSync(dir, { recursive: true });
    const files: { kind: string; file: string; sha: string }[] = [];
    // Keep ONE per kind (first; dedup already drops exact-sha duplicates).
    const seenKind = new Set<string>();
    for (const p of pdfs) {
      if (seenKind.has(p.kind)) continue;
      seenKind.add(p.kind);
      const file = `${p.kind}.pdf`;
      writeFileSync(join(dir, file), p.bytes);
      files.push({ kind: p.kind, file, sha: p.sha256.slice(0, 10) });
    }
    manifest.push({ order, dir, files });
  }

  console.log("");
  console.log(`[extract] wrote PDFs for ${manifest.length} order(s):`);
  for (const m of manifest) {
    const kinds = m.files.map((f) => f.kind).sort().join(" + ");
    const complete = ["PurchaseOrder", "SizePerColourBreakdown", "TotalCountryBreakdown"].every((k) => m.files.find((f) => f.kind === k));
    console.log(`  ${m.order} → ${m.dir}  [${kinds}]${complete ? " ✓" : " ⚠ incomplete"}`);
  }
  writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
