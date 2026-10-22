import { readFile } from "fs/promises";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { audit } from "@/lib/audit";
import { buildZip, type ZipEntry } from "@/server/booking-correction/zip";

export async function GET(_req: Request, { params }: { params: { runId: string } }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  if (!userHasPermission(user, PERMISSIONS.PDF_COMBINE)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const outputs = await prisma.pdfCombineOutput.findMany({
    where: { runId: params.runId, status: "COMPLETED" },
    orderBy: { rowNo: "asc" },
  });
  if (outputs.length === 0) return NextResponse.json({ error: "No combined PDFs in this run" }, { status: 404 });

  const entries: ZipEntry[] = [];
  for (const o of outputs) {
    if (!o.outputPath) continue;
    try {
      entries.push({ name: o.outputName, data: await readFile(o.outputPath) });
    } catch {
      // A missing file is skipped rather than failing the whole archive.
    }
  }
  const zip = buildZip(entries);
  await audit({ entityType: "document", entityId: params.runId, action: "pdf-combiner.download.zip", actor: user.email, data: { files: entries.length } });
  return new NextResponse(zip, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="PDF_Combiner_${params.runId.slice(0, 8)}.zip"`,
      "Content-Length": String(zip.byteLength),
    },
  });
}
