import { readFile } from "fs/promises";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { audit } from "@/lib/audit";
import { buildZip, type ZipEntry } from "@/server/booking-correction/zip";

/** Download every VERIFIED container PDF in a batch as one ZIP (one file per matched container). */
export async function GET(_req: Request, { params }: { params: { batchId: string } }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  if (!userHasPermission(user, PERMISSIONS.CONTAINER_SEARCH)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const batch = await prisma.containerBatch.findUnique({ where: { id: params.batchId } });
  if (!batch) return NextResponse.json({ error: "Batch not found" }, { status: 404 });

  const rows = await prisma.containerSearch.findMany({
    where: { batchId: batch.id, status: "completed", pdfPath: { not: null } },
    orderBy: { createdAt: "asc" },
  });

  const entries: ZipEntry[] = [];
  const usedNames = new Set<string>();
  for (const r of rows) {
    if (!r.pdfPath) continue;
    try {
      const data = await readFile(r.pdfPath);
      let name = `container-${(r.portalContainerNo || r.containerNo).replace(/[^\w.-]+/g, "_")}.pdf`;
      // Guard against duplicate names (same container searched twice in a batch).
      if (usedNames.has(name)) name = name.replace(/\.pdf$/, `-${r.id.slice(0, 6)}.pdf`);
      usedNames.add(name);
      entries.push({ name, data });
    } catch { /* stored file gone — skip, never fabricate */ }
  }

  if (entries.length === 0) {
    return NextResponse.json({ error: "No verified container PDFs in this batch yet." }, { status: 404 });
  }

  const zip = buildZip(entries);
  await audit({ entityType: "container", entityId: batch.id, action: "container.batch.zip", actor: user.email, data: { files: entries.length } });
  return new NextResponse(zip, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="containers-${batch.id.slice(0, 8)}.zip"`,
      "Content-Length": String(zip.byteLength),
      "Cache-Control": "private, no-store",
    },
  });
}
