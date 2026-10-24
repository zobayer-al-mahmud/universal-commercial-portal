import { NextResponse } from "next/server";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { env } from "@/lib/env";
import { saveActiveMaster, validateMaster } from "@/server/pdf-combiner/master-store";

/**
 * Re-import a master Excel and replace the active version after validation.
 * The upload must contain the CLABING HERE-F sheet with the expected columns;
 * otherwise it is rejected and the current active master is left untouched.
 */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  if (!userHasPermission(user, PERMISSIONS.PDF_COMBINE)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const form = await req.formData();
  const file = form.get("master");
  if (!(file instanceof File) || file.name === "" || file.size === 0) {
    return NextResponse.json({ error: "Choose an .xlsx master file to import." }, { status: 400 });
  }
  if (!/\.xlsx$/i.test(file.name)) return NextResponse.json({ error: "The master must be an .xlsx file." }, { status: 400 });
  const maxBytes = env.PDF_COMBINER_MAX_MASTER_MB * 1024 * 1024;
  if (file.size > maxBytes) return NextResponse.json({ error: `File exceeds ${env.PDF_COMBINER_MAX_MASTER_MB} MB.` }, { status: 400 });

  const data = Buffer.from(await file.arrayBuffer());
  const v = await validateMaster(data);
  if (!v.ok) return NextResponse.json({ error: `Rejected: ${v.error}` }, { status: 422 });

  try {
    const saved = await saveActiveMaster(data, { fileName: file.name, actor: user.email, action: "pdf-combiner.master.reimported", note: "re-import" });
    return NextResponse.json({
      ok: true,
      fileName: saved.master.fileName,
      version: saved.master.version,
      eligible: saved.eligible,
      totalRows: v.result.rows.length,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Import failed." }, { status: 500 });
  }
}
