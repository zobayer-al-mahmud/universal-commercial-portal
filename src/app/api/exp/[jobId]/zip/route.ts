import { readFile } from "fs/promises";
import { NextResponse } from "next/server";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { prisma } from "@/lib/db";
import { buildZip, type ZipEntry } from "@/server/booking-correction/zip";
import { uniqueExpPdfName } from "@/server/exp-automation/output-name";

/**
 * Download captured EXP PDFs in a job as one ZIP, named by EXP fields (de-duped).
 * Covers EVERY row that has a stored PDF — Download captures, plus the read-only
 * form PDFs captured for Correction/Duplicate — not just the Download kind. Pass
 * `?rowIds=a,b,c` to bundle only a selected subset (bulk "download selected PDFs").
 */
export async function GET(req: Request, { params }: { params: { jobId: string } }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  if (!userHasPermission(user, PERMISSIONS.EXP_RUN)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const job = await prisma.expJob.findUnique({ where: { id: params.jobId } });
  if (!job) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const rowIdsParam = new URL(req.url).searchParams.get("rowIds");
  const selected = rowIdsParam ? rowIdsParam.split(",").map((s) => s.trim()).filter(Boolean) : null;

  const rows = await prisma.expJobRow.findMany({
    where: {
      jobId: job.id,
      pdfPath: { not: null },
      ...(selected && selected.length ? { id: { in: selected } } : {}),
    },
    orderBy: { rowNo: "asc" },
  });
  if (rows.length === 0) return NextResponse.json({ error: selected ? "None of the selected rows has a PDF." : "No captured PDFs in this job yet." }, { status: 404 });

  const entries: ZipEntry[] = [];
  const used = new Set<string>();
  for (const r of rows) {
    if (!r.pdfPath) continue;
    let data: Buffer;
    try { data = await readFile(r.pdfPath); } catch { continue; }
    const name = uniqueExpPdfName(
      { rowNo: r.rowNo, expNo: r.expNo, adscode: r.adscode, expSerial: r.expSerial, expYear: r.expYear, invoiceNo: r.invoiceNo, saveAs: r.saveAs },
      used,
    );
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
