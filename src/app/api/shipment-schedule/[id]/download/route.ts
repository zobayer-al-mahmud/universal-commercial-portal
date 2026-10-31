import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { buildWeekWorkbook, type XlsxRow, type XlsxWeekSection } from "@/server/shipment-schedule/write-xlsx";

/**
 * Download the entire week as a single .xlsx — all cut-offs stacked on one
 * sheet with the top title line showing e.g.
 *   "Week 27  1st cut off 29.06.2026 - 2nd cut off 03.07.2026"
 * Matches the user's 2026-10-28 request.
 */
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });

  const schedule = await prisma.shipmentSchedule.findUnique({
    where: { id: params.id },
    include: {
      cutoffs: {
        orderBy: { sortOrder: "asc" },
        include: { rows: { orderBy: { createdAt: "asc" } } },
      },
    },
  });
  if (!schedule) return NextResponse.json({ error: "Shipment schedule not found." }, { status: 404 });

  const sections: XlsxWeekSection[] = schedule.cutoffs.map((c) => ({
    cutoffLabel: c.label,
    cutoffDate: c.date,
    rows: c.rows.map<XlsxRow>((r) => ({
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
    })),
  }));

  const buf = await buildWeekWorkbook({ weekNo: schedule.weekNo, sections });

  const parts: string[] = [];
  if (schedule.weekNo != null) parts.push(`Week ${schedule.weekNo}`);
  for (const s of sections) {
    if (s.cutoffDate) parts.push(`${s.cutoffLabel} ${s.cutoffDate}`);
  }
  const safe = (s: string) => s.replace(/[^\w.-]+/g, "_");
  const filename = `${safe(parts.join(" ") || "ShipmentSchedule")}.xlsx`;

  return new NextResponse(buf, {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(buf.length),
    },
  });
}
