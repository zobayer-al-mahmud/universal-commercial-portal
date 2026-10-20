import { readFile } from "fs/promises";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { audit } from "@/lib/audit";

/** Original uploaded PDF — authorised users only; original is never modified. */
export async function GET(_req: Request, { params }: { params: { docId: string } }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  if (!userHasPermission(user, PERMISSIONS.BOOKING_EXPORT)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const doc = await prisma.bookingDocument.findUnique({ where: { id: params.docId } });
  if (!doc) return NextResponse.json({ error: "Document not found" }, { status: 404 });

  let buf: Buffer;
  try {
    buf = await readFile(doc.storagePath);
  } catch {
    return NextResponse.json({ error: "Original file is missing" }, { status: 404 });
  }
  await audit({ entityType: "document", entityId: doc.id, action: "booking.download.original", actor: user.email });
  const safe = doc.originalName.replace(/[^\w.\- ]+/g, "_");
  return new NextResponse(buf, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${safe}"`,
      "Content-Length": String(buf.byteLength),
    },
  });
}
