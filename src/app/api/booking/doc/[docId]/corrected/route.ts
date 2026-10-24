import { readFile } from "fs/promises";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { audit } from "@/lib/audit";

export async function GET(_req: Request, { params }: { params: { docId: string } }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  if (!userHasPermission(user, PERMISSIONS.BOOKING_EXPORT)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const doc = await prisma.bookingDocument.findUnique({ where: { id: params.docId } });
  if (!doc || !doc.correctedPdfPath) return NextResponse.json({ error: "No corrected PDF for this document" }, { status: 404 });
  let buf: Buffer;
  try { buf = await readFile(doc.correctedPdfPath); } catch { return NextResponse.json({ error: "Corrected PDF file is missing from storage" }, { status: 404 }); }
  await audit({ entityType: "document", entityId: doc.id, action: "booking.download.corrected", actor: user.email });
  const safe = `${doc.poNumber || "booking"}-${doc.bookingRef || doc.serial}`.replace(/[^\w.-]+/g, "-");
  return new NextResponse(buf, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="booking-corrected-${safe}.pdf"`,
      "Content-Length": String(buf.byteLength),
    },
  });
}
