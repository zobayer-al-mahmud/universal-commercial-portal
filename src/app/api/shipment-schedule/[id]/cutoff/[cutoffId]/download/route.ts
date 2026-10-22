import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { buildCutoffWorkbook, type XlsxRow } from "@/server/shipment-schedule/write-xlsx";

/**
 * Download a single cut-off's shipment schedule as .xlsx. One sheet per cut-off,
 * laid out like the sample workbook (orange title row + green 15-column header
 * + per-row data; Value is a live PCS*FOB formula).
 */
export async function GET(_req: Request, { params }: { params: { id: string; cutoffId: string } }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });

  const [schedule, cutoff] = await Promise.all([
    prisma.shipmentSchedule.findUnique({ where: { id: params.id } }),
    prisma.shipmentScheduleCutoff.findUnique({ where: { id: params.cutoffId } }),
  ]);
  if (!schedule) return NextResponse.json({ error: "Shipment schedule not found." }, { status: 404 });
  if (!cutoff || cutoff.scheduleId !== params.id) {
    return NextResponse.json({ error: "Cut-off does not belong to this schedule." }, { status: 404 });
  }

  const rows = await prisma.shipmentScheduleRow.findMany({
    where: { scheduleId: params.id, cutoffId: params.cutoffId },
    orderBy: { createdAt: "asc" },
  });

  const xlsxRows: XlsxRow[] = rows.map((r) => ({
    buyerCode: r.buyerCode,
    contractNo: r.contractNo,
    contractDate: r.contractDate,
    orderNo: r.orderNo,
    pcs: r.pcs,
    style: r.style,
    fob: r.fob,
    composition: r.composition,
    cat: r.cat,
    hts: r.hts,
    invoiceNo: r.invoiceNo,
    marketSubCode: r.marketSubCode,
    marketCode: r.marketCode,
    transportMode: r.transportMode,
  }));

  const buf = await buildCutoffWorkbook(xlsxRows, {
    weekTitle: schedule.weekTitle,
    cutoffLabel: cutoff.label,
    cutoffDate: cutoff.date,
  });

  const safe = (s: string) => s.replace(/[^\w.-]+/g, "_");
  const filename = `${safe(schedule.weekTitle || "ShipmentSchedule")}__${safe(cutoff.label)}.xlsx`;

  return new NextResponse(buf, {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(buf.length),
    },
  });
}
