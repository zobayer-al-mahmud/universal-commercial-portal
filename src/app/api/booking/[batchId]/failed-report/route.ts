import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { audit } from "@/lib/audit";

const NON_SUCCESS = ["NEEDS_REVIEW", "MISMATCH", "STATUS_MISMATCH", "SEARCH_FAILED", "PORTAL_AUTH_REQUIRED", "DOWNLOAD_FAILED", "FAILED"];

function csvCell(v: unknown): string {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV export of failed / review-required documents (§12). */
export async function GET(_req: Request, { params }: { params: { batchId: string } }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  if (!userHasPermission(user, PERMISSIONS.JOB_READ)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const docs = await prisma.bookingDocument.findMany({ where: { batchId: params.batchId, state: { in: NON_SUCCESS } }, orderBy: { serial: "asc" } });
  const header = ["SL", "File", "PO", "Country", "State", "Match", "Final Status", "Error/Warning"];
  const rows = docs.map((d) => [d.serial, d.originalName, d.poNumber, d.countryCode, d.state, d.matchOutcome, d.finalStatus, d.error || d.warning]);
  const csv = [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n");

  await audit({ entityType: "job", entityId: params.batchId, action: "booking.export.failed-report", actor: user.email, data: { rows: rows.length } });
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="booking-failed-${params.batchId.slice(0, 8)}.csv"`,
    },
  });
}
