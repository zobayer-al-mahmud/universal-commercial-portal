import { NextResponse } from "next/server";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { prisma } from "@/lib/db";

/** CSV report of every row in an EXP job (row no, identifiers, status, result). */
export async function GET(_req: Request, { params }: { params: { jobId: string } }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  if (!userHasPermission(user, PERMISSIONS.EXP_RUN)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const job = await prisma.expJob.findUnique({ where: { id: params.jobId } });
  if (!job) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const rows = await prisma.expJobRow.findMany({ where: { jobId: job.id }, orderBy: { rowNo: "asc" } });

  const esc = (v: unknown) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = ["Row", "ADSCODE", "EXP Serial", "EXP Year", "EXP No", "Invoice No", "Save As", "Status", "Filled/Mismatched fields", "Error"];
  const lines = [header.map(esc).join(",")];
  for (const r of rows) {
    let mismatched = "";
    try { mismatched = (JSON.parse(r.mismatchedFields) as { portalLabel: string }[]).map((m) => m.portalLabel).join("; "); } catch { /* ignore */ }
    lines.push([r.rowNo, r.adscode, r.expSerial, r.expYear, r.expNo, r.invoiceNo, r.saveAs, r.status, mismatched, r.error].map(esc).join(","));
  }
  const csv = lines.join("\n");
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="EXP_${job.kind}_${job.id.slice(0, 8)}_report.csv"`,
      "Cache-Control": "private, no-store",
    },
  });
}
