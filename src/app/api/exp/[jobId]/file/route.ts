import { readFile } from "fs/promises";
import { NextResponse } from "next/server";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { prisma } from "@/lib/db";
import { isExpKind } from "@/server/exp-automation/types";
import { buildEditedWorkbook, type ExportRow } from "@/server/exp-automation/exp-export";

/**
 * Download the uploaded workbook for a job.
 *   GET …/file            → the ORIGINAL, immutable .xlsx exactly as uploaded.
 *   GET …/file?edited=1   → an .xlsx rebuilt from the job's CURRENT (edited) rows.
 * Nothing here mutates the original; the edited export is generated on the fly.
 */
const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export async function GET(req: Request, { params }: { params: { jobId: string } }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  if (!userHasPermission(user, PERMISSIONS.EXP_RUN)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const job = await prisma.expJob.findUnique({ where: { id: params.jobId } });
  if (!job) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const edited = new URL(req.url).searchParams.get("edited") === "1";
  const baseName = (job.sourceName || `exp-${job.id.slice(0, 8)}.xlsx`).replace(/[^\w.\- ]+/g, "_").replace(/\.xlsx$/i, "");

  if (edited) {
    if (!isExpKind(job.kind)) return NextResponse.json({ error: "Unknown workflow kind." }, { status: 400 });
    const rows = await prisma.expJobRow.findMany({ where: { jobId: job.id }, orderBy: { rowNo: "asc" } });
    const exportRows: ExportRow[] = rows.map((r) => {
      let values: Record<string, string> = {};
      try { values = (JSON.parse(r.dataJson) as { values?: Record<string, string> }).values ?? {}; } catch { /* ignore */ }
      return { rowNo: r.rowNo, adscode: r.adscode, expSerial: r.expSerial, expYear: r.expYear, expNo: r.expNo, saveAs: r.saveAs, values };
    });
    const buf = await buildEditedWorkbook(job.kind, exportRows);
    return new NextResponse(buf as unknown as BodyInit, {
      headers: {
        "Content-Type": XLSX_TYPE,
        "Content-Disposition": `attachment; filename="${baseName}-edited.xlsx"`,
        "Content-Length": String(buf.length),
        "Cache-Control": "private, no-store",
      },
    });
  }

  if (!job.storedPath) return NextResponse.json({ error: "The original workbook was not stored for this job." }, { status: 404 });
  let data: Buffer;
  try { data = await readFile(job.storedPath); } catch { return NextResponse.json({ error: "The stored workbook is missing on disk." }, { status: 404 }); }
  return new NextResponse(data as unknown as BodyInit, {
    headers: {
      "Content-Type": XLSX_TYPE,
      "Content-Disposition": `attachment; filename="${baseName}.xlsx"`,
      "Content-Length": String(data.length),
      "Cache-Control": "private, no-store",
    },
  });
}
