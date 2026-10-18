import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { audit } from "@/lib/audit";
import { buildScheduleWorkbook } from "@/server/export/schedule-workbook";

export async function GET(_req: Request, { params }: { params: { jobId: string } }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  if (!userHasPermission(user, PERMISSIONS.JOB_READ))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const lines = await prisma.shipmentScheduleLine.findMany({
    where: { jobId: params.jobId },
    orderBy: { createdAt: "asc" },
  });
  if (lines.length === 0) return NextResponse.json({ error: "No schedule lines for this job" }, { status: 404 });

  const buf = await buildScheduleWorkbook(lines);
  await audit({ entityType: "job", entityId: params.jobId, action: "export.schedule.xlsx", actor: user.email });

  const weekNo = lines[0].weekNo;
  return new NextResponse(buf, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="Week-${weekNo}-schedule-${params.jobId.slice(0, 8)}.xlsx"`,
      "Content-Length": String(buf.byteLength),
    },
  });
}
