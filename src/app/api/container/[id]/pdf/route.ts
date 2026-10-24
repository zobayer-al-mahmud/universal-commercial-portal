import { readFile } from "fs/promises";
import { NextResponse } from "next/server";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";

/** Preview (inline) or download (?download=1) a captured container result PDF. */
export async function GET(req: Request, { params }: { params: { id: string } }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  if (!userHasPermission(user, PERMISSIONS.CONTAINER_SEARCH)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const row = await prisma.containerSearch.findUnique({ where: { id: params.id } });
  if (!row || !row.pdfPath) return NextResponse.json({ error: "No PDF for this search." }, { status: 404 });

  let data: Buffer;
  try {
    data = await readFile(row.pdfPath);
  } catch {
    return NextResponse.json({ error: "The stored PDF is no longer available on disk." }, { status: 410 });
  }

  const asDownload = new URL(req.url).searchParams.get("download") === "1";
  const filename = `container-${(row.portalContainerNo || row.containerNo).replace(/[^\w.-]+/g, "_")}.pdf`;
  if (asDownload) {
    await audit({ entityType: "container", entityId: row.id, action: "container.pdf.downloaded", actor: user.email, data: { containerNo: row.containerNo } });
  }
  return new NextResponse(data, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `${asDownload ? "attachment" : "inline"}; filename="${filename}"`,
      "Content-Length": String(data.byteLength),
      "Cache-Control": "private, no-store",
    },
  });
}
