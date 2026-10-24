import { readFile } from "fs/promises";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { audit } from "@/lib/audit";
import { buildZip, type ZipEntry } from "@/server/booking-correction/zip";

/**
 * Batch ZIP:
 *   - default (no `include` or `include=completed`): ONLY completed (verified
 *     CONFIRMED) UCP success PDFs — same as the previous §12 behaviour.
 *   - `include=all`: a per-document folder containing the original uploaded
 *     PDF, the Damco portal PDF (if captured), and the latest edited PDF (if
 *     any). An unverified booking's success PDF is NEVER included.
 */
export async function GET(req: Request, { params }: { params: { batchId: string } }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  if (!userHasPermission(user, PERMISSIONS.BOOKING_EXPORT)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const batch = await prisma.bookingBatch.findUnique({ where: { id: params.batchId } });
  if (!batch) return NextResponse.json({ error: "Batch not found" }, { status: 404 });

  const include = new URL(req.url).searchParams.get("include") || "completed";
  const entries: ZipEntry[] = [];

  if (include === "all") {
    const docs = await prisma.bookingDocument.findMany({ where: { batchId: params.batchId }, orderBy: { serial: "asc" } });
    for (const d of docs) {
      const folder = `${String(d.serial).padStart(3, "0")}__${(d.poNumber || "po")}-${d.countryCode || "xx"}`.replace(/[^\w.-]+/g, "-");
      try {
        const data = await readFile(d.storagePath);
        entries.push({ name: `${folder}/original__${d.originalName}`.replace(/[^\w./-]+/g, "-"), data });
      } catch { /* original gone — skip but keep others */ }
      if (d.portalPdfPath) {
        try {
          const data = await readFile(d.portalPdfPath);
          entries.push({ name: `${folder}/damco__${d.bookingRef || d.serial}.pdf`.replace(/[^\w./-]+/g, "-"), data });
        } catch { /* skip */ }
      }
      if (d.correctedPdfPath) {
        try {
          const data = await readFile(d.correctedPdfPath);
          entries.push({ name: `${folder}/edited__${d.bookingRef || d.serial}.pdf`.replace(/[^\w./-]+/g, "-"), data });
        } catch { /* skip */ }
      }
      if (d.state === "COMPLETED" && d.generatedPdfPath) {
        try {
          const data = await readFile(d.generatedPdfPath);
          entries.push({ name: `${folder}/ucp-success__${d.bookingRef || d.serial}.pdf`.replace(/[^\w./-]+/g, "-"), data });
        } catch { /* skip */ }
      }
    }
  } else {
    const docs = await prisma.bookingDocument.findMany({ where: { batchId: params.batchId, state: "COMPLETED" }, orderBy: { serial: "asc" } });
    for (const d of docs) {
      if (!d.generatedPdfPath) continue;
      try {
        const data = await readFile(d.generatedPdfPath);
        const name = `booking-${(d.poNumber || "po")}-${(d.countryCode || "xx")}-${d.bookingRef || d.serial}.pdf`.replace(/[^\w.-]+/g, "-");
        entries.push({ name, data });
      } catch {
        /* skip missing file — never include an unverified/invalid file */
      }
    }
  }

  if (entries.length === 0) return NextResponse.json({ error: "No files to export in this batch" }, { status: 404 });

  const zip = buildZip(entries);
  await audit({ entityType: "job", entityId: params.batchId, action: "booking.download.zip", actor: user.email, data: { files: entries.length, include } });
  return new NextResponse(zip, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="booking-batch-${params.batchId.slice(0, 8)}${include === "all" ? "-all" : ""}.zip"`,
      "Content-Length": String(zip.byteLength),
    },
  });
}
