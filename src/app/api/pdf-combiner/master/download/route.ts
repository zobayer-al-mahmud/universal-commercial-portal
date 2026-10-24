import { NextResponse } from "next/server";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { audit } from "@/lib/audit";
import { ensureActiveMaster, readActiveMasterBytes } from "@/server/pdf-combiner/master-store";

/** Download the current UCP-managed active master Excel. */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  if (!userHasPermission(user, PERMISSIONS.PDF_COMBINE)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  try {
    const master = await ensureActiveMaster(user.email);
    const data = await readActiveMasterBytes(user.email);
    await audit({ entityType: "document", entityId: "active", action: "pdf-combiner.master.downloaded", actor: user.email, data: { fileName: master.fileName, version: master.version } });
    const filename = master.fileName.replace(/[^\w. ()-]+/g, "_") || "master.xlsx";
    return new NextResponse(data, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": String(data.byteLength),
        "Cache-Control": "private, no-store",
      },
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unable to read the active master." }, { status: 400 });
  }
}
