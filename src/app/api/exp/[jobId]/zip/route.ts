import { readFile } from "fs/promises";
import { NextResponse } from "next/server";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { prisma } from "@/lib/db";
import { buildZip, type ZipEntry } from "@/server/booking-correction/zip";

/** Download every captured EXP PDF in a job as one ZIP (named by Save_As, de-duped). */
export async function GET(_req: Request, { params }: { params: { jobId: string } }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  if (!userHasPermission(user, PERMISSIONS.EXP_RUN)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const job = await prisma.expJob.findUnique({ where: { id: params.jobId } });
  if (!job) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const rows = await prisma.expJobRow.findMany({ where: { jobId: job.id, status: "downloaded", pdfPath: { not: null } }, orderBy: { rowNo: "asc" } });
  if (rows.length === 0) return NextResponse.json({ error: "No downloaded PDFs in this job yet." }, { status: 404 });

  const entries: ZipEntry[] = [];
  const used = new Set<string>();
  for (const r of rows) {
    if (!r.pdfPath) continue;
    let data: Buffer;
    try { data = await readFile(r.pdfPath); } catch { continue; }
    let base = (r.saveAs || r.expSerial || `row-${r.rowNo}`).replace(/[^\w.-]+/g, "_").replace(/\.pdf$/i, "");
    let name = `${base}.pdf`;
    let n = 2;
    while (used.has(name.toLowerCase())) name = `${base}-${n++}.pdf`;
    used.add(name.toLowerCase());
    entries.push({ name, data });
  }
  if (entries.length === 0) return NextResponse.json({ error: "Stored PDFs are missing." }, { status: 404 });

  const zip = buildZip(entries);
  return new NextResponse(zip as unknown as BodyInit, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="EXP_Download_${job.id.slice(0, 8)}.zip"`,
      "Content-Length": String(zip.length),
      "Cache-Control": "private, no-store",
    },
  });
}
