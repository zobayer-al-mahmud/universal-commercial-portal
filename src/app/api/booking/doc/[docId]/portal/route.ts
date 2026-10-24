import { readFile } from "fs/promises";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { audit } from "@/lib/audit";
import { validatePortalPdf } from "@/server/integrations/damco-live";

/**
 * Serve the genuine Damco portal PDF stored for this document.
 *
 *   /api/booking/doc/<id>/portal           → inline (iframe preview-friendly)
 *   /api/booking/doc/<id>/portal?download=1 → attachment (forces Save As)
 *
 * The server-side file must pass structural PDF validation before being
 * served — a missing / truncated / HTML-wrapper file returns 404 instead of
 * sending bad bytes to the browser.
 */
export async function GET(req: Request, { params }: { params: { docId: string } }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  if (!userHasPermission(user, PERMISSIONS.BOOKING_EXPORT)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const doc = await prisma.bookingDocument.findUnique({ where: { id: params.docId } });
  if (!doc || !doc.portalPdfPath) return NextResponse.json({ error: "No portal-captured PDF for this document" }, { status: 404 });
  let buf: Buffer;
  try { buf = await readFile(doc.portalPdfPath); } catch { return NextResponse.json({ error: "Portal PDF file is missing from storage" }, { status: 404 }); }
  const v = validatePortalPdf(buf);
  if (!v.ok) return NextResponse.json({ error: `Stored portal PDF is not valid: ${v.reason}` }, { status: 404 });

  const url = new URL(req.url);
  const forceDownload = url.searchParams.get("download") === "1";
  const disposition = forceDownload ? "attachment" : "inline";

  await audit({ entityType: "document", entityId: doc.id, action: forceDownload ? "booking.download.portal" : "booking.preview.portal", actor: user.email });
  const safe = `${doc.poNumber || "booking"}-${doc.bookingRef || doc.serial}`.replace(/[^\w.-]+/g, "-");
  return new NextResponse(buf, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `${disposition}; filename="damco-${safe}.pdf"`,
      "Content-Length": String(buf.byteLength),
      "Cache-Control": "private, no-store",
    },
  });
}
