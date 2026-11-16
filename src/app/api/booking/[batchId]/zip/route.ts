import { readFile } from "fs/promises";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { audit } from "@/lib/audit";
import { buildZip, type ZipEntry } from "@/server/booking-correction/zip";
import { bookingPdfBase, uniqueBookingPdfName, type BookingNameFields } from "@/server/booking-correction/output-name";

/**
 * Batch ZIP. Every file is named by the booking record (PO_Country_FR), de-duped.
 *   - default (`include=completed`): ONLY completed (verified CONFIRMED) UCP
 *     success PDFs — unchanged safety behaviour.
 *   - `include=all`: a per-document folder with the original upload, the Damco
 *     portal PDF, the edited PDF, and (if completed) the UCP success PDF.
 *   - `docIds=a,b,c`: the "download selected" bulk export — ONE best PDF per
 *     selected document (edited → Damco → UCP success → original), named
 *     PO_Country_FR.pdf. An unverified booking's success PDF is never included.
 */
export async function GET(req: Request, { params }: { params: { batchId: string } }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  if (!userHasPermission(user, PERMISSIONS.BOOKING_EXPORT)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const batch = await prisma.bookingBatch.findUnique({ where: { id: params.batchId } });
  if (!batch) return NextResponse.json({ error: "Batch not found" }, { status: 404 });

  const url = new URL(req.url);
  const include = url.searchParams.get("include") || "completed";
  const docIdsParam = url.searchParams.get("docIds");
  const selectedIds = docIdsParam ? docIdsParam.split(",").map((s) => s.trim()).filter(Boolean) : null;
  const entries: ZipEntry[] = [];
  const used = new Set<string>();
  const nameOf = (d: BookingNameFields): BookingNameFields => ({ serial: d.serial, poNumber: d.poNumber, countryCode: d.countryCode, frCode: d.frCode, bookingRef: d.bookingRef });

  if (selectedIds && selectedIds.length) {
    // "Download selected" — one best PDF per chosen document, named PO_Country_FR.
    const docs = await prisma.bookingDocument.findMany({ where: { batchId: params.batchId, id: { in: selectedIds } }, orderBy: { serial: "asc" } });
    for (const d of docs) {
      // Prefer the edited PDF, then the genuine Damco portal PDF, then the UCP
      // success PDF (completed only), then the original upload.
      const pick = d.correctedPdfPath || d.portalPdfPath || (d.state === "COMPLETED" ? d.generatedPdfPath : null) || d.storagePath;
      if (!pick) continue;
      try {
        const data = await readFile(pick);
        entries.push({ name: uniqueBookingPdfName(nameOf(d), used), data });
      } catch { /* file gone — skip */ }
    }
    if (entries.length === 0) return NextResponse.json({ error: "None of the selected documents has a downloadable PDF." }, { status: 404 });
  } else if (include === "all") {
    const docs = await prisma.bookingDocument.findMany({ where: { batchId: params.batchId }, orderBy: { serial: "asc" } });
    for (const d of docs) {
      const folder = `${String(d.serial).padStart(3, "0")}__${bookingPdfBase(nameOf(d))}`.replace(/[^\w.-]+/g, "-");
      try {
        const data = await readFile(d.storagePath);
        entries.push({ name: `${folder}/${uniqueBookingPdfName(nameOf(d), used, "original")}`, data });
      } catch { /* original gone — skip but keep others */ }
      if (d.portalPdfPath) {
        try { entries.push({ name: `${folder}/${uniqueBookingPdfName(nameOf(d), used, "damco")}`, data: await readFile(d.portalPdfPath) }); } catch { /* skip */ }
      }
      if (d.correctedPdfPath) {
        try { entries.push({ name: `${folder}/${uniqueBookingPdfName(nameOf(d), used, "edited")}`, data: await readFile(d.correctedPdfPath) }); } catch { /* skip */ }
      }
      if (d.state === "COMPLETED" && d.generatedPdfPath) {
        try { entries.push({ name: `${folder}/${uniqueBookingPdfName(nameOf(d), used, "ucp-success")}`, data: await readFile(d.generatedPdfPath) }); } catch { /* skip */ }
      }
    }
  } else {
    const docs = await prisma.bookingDocument.findMany({ where: { batchId: params.batchId, state: "COMPLETED" }, orderBy: { serial: "asc" } });
    for (const d of docs) {
      if (!d.generatedPdfPath) continue;
      try {
        const data = await readFile(d.generatedPdfPath);
        entries.push({ name: uniqueBookingPdfName(nameOf(d), used), data });
      } catch {
        /* skip missing file — never include an unverified/invalid file */
      }
    }
  }

  if (entries.length === 0) return NextResponse.json({ error: "No files to export in this batch" }, { status: 404 });

  const zip = buildZip(entries);
  const mode = selectedIds ? "selected" : include;
  await audit({ entityType: "job", entityId: params.batchId, action: "booking.download.zip", actor: user.email, data: { files: entries.length, mode, selected: selectedIds?.length ?? null } });
  return new NextResponse(zip, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="booking-batch-${params.batchId.slice(0, 8)}-${mode}.zip"`,
      "Content-Length": String(zip.byteLength),
    },
  });
}
