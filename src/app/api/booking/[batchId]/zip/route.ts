import { readFile } from "fs/promises";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { audit } from "@/lib/audit";
import { buildZip, type ZipEntry } from "@/server/booking-correction/zip";

/** Batch ZIP: ONLY completed (verified CONFIRMED) booking PDFs (§12). */
export async function GET(_req: Request, { params }: { params: { batchId: string } }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  if (!userHasPermission(user, PERMISSIONS.BOOKING_EXPORT)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const batch = await prisma.bookingBatch.findUnique({ where: { id: params.batchId } });
  if (!batch) return NextResponse.json({ error: "Batch not found" }, { status: 404 });

  const docs = await prisma.bookingDocument.findMany({ where: { batchId: params.batchId, state: "COMPLETED" }, orderBy: { serial: "asc" } });
  const entries: ZipEntry[] = [];
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
  if (entries.length === 0) return NextResponse.json({ error: "No completed booking PDFs to export in this batch" }, { status: 404 });

  const zip = buildZip(entries);
  await audit({ entityType: "job", entityId: params.batchId, action: "booking.download.zip", actor: user.email, data: { files: entries.length } });
  return new NextResponse(zip, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="booking-batch-${params.batchId.slice(0, 8)}.zip"`,
      "Content-Length": String(zip.byteLength),
    },
  });
}
