import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { audit } from "@/lib/audit";
import { writePackingListXlsx } from "@/server/booking-correction/excel";

/**
 * Download the batch's current packing-list rows as an .xlsx (the live DB values,
 * including any grid edits) — the round-trip / re-import file. Same 7-column
 * layout as the uploaded PackingLists.xlsx.
 */
export async function GET(_req: Request, { params }: { params: { batchId: string } }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  if (!userHasPermission(user, PERMISSIONS.BOOKING_EXPORT)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const batch = await prisma.bookingBatch.findUnique({ where: { id: params.batchId } });
  if (!batch) return NextResponse.json({ error: "Batch not found" }, { status: 404 });
  if (batch.sourceType !== "excel") return NextResponse.json({ error: "This batch was not created from Excel." }, { status: 400 });

  const docs = await prisma.bookingDocument.findMany({ where: { batchId: params.batchId }, orderBy: { serial: "asc" } });
  const rows = docs.map((d) => ({
    poNumber: d.poNumber,
    sku: d.countryCode,
    shipper: d.shipper,
    frCode: d.frCode,
    quantity: d.extractedQuantity,
    cartons: d.extractedCartons,
    grossWeight: d.extractedGrossWeight,
  }));

  const buf = await writePackingListXlsx(rows);
  await audit({ entityType: "job", entityId: params.batchId, action: "booking.download.excel", actor: user.email, data: { rows: rows.length } });
  return new NextResponse(buf, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="PackingLists-${params.batchId.slice(0, 8)}.xlsx"`,
      "Content-Length": String(buf.byteLength),
    },
  });
}
