import { NextResponse } from "next/server";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { prisma } from "@/lib/db";

/** Live status + event log for one container search (polled by the UI). */
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  if (!userHasPermission(user, PERMISSIONS.CONTAINER_SEARCH)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const row = await prisma.containerSearch.findUnique({
    where: { id: params.id },
    include: { events: { orderBy: { createdAt: "asc" }, take: 50 } },
  });
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({
    id: row.id,
    status: row.status,
    step: row.step,
    containerNo: row.containerNo,
    expectedLocation: row.expectedLocation,
    shipmentRef: row.shipmentRef,
    error: row.error,
    hasPdf: Boolean(row.pdfPath),
    pdfPages: row.pdfPages,
    result: {
      containerNo: row.portalContainerNo,
      positionLocation: row.positionLocation,
      slot: row.slot,
      block: row.block,
      yard: row.yard,
      category: row.category,
      type: row.containerType,
      destination: row.destination,
      mlo: row.mlo,
      shippingAgent: row.shippingAgent,
      isoCode: row.isoCode,
      containerSize: row.containerSize,
      containerHeight: row.containerHeight,
    },
    events: row.events.map((e) => ({ step: e.step, status: e.status, message: e.message, at: e.createdAt.toISOString() })),
  });
}
