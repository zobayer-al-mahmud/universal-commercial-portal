import { NextResponse } from "next/server";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { audit } from "@/lib/audit";
import { deleteUploadedTemplate } from "@/server/customs-invoice/templates";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/customs-invoice/templates/delete
 *
 * Body: { filename: string } (JSON) OR form field `filename`.
 * Only files inside the managed uploaded-templates folder can be removed —
 * bundled templates from `CUSTOMS_INVOICE_TEMPLATE_DIR` are read-only.
 */
export async function POST(req: Request): Promise<Response> {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  if (!userHasPermission(user, PERMISSIONS.JOB_CREATE)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let filename = "";
  const ctype = req.headers.get("content-type") ?? "";
  if (ctype.includes("application/json")) {
    try {
      const body = (await req.json()) as { filename?: unknown };
      filename = String(body.filename ?? "").trim();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }
  } else {
    try {
      const form = await req.formData();
      filename = String(form.get("filename") ?? "").trim();
    } catch (e) {
      return NextResponse.json({ error: `Invalid form data: ${e instanceof Error ? e.message : "unknown"}` }, { status: 400 });
    }
  }

  if (!filename) return NextResponse.json({ error: "filename is required." }, { status: 400 });

  const r = await deleteUploadedTemplate(filename);
  if (!r.ok) return NextResponse.json({ error: r.error ?? "delete failed" }, { status: 400 });

  await audit({
    entityType: "customs-invoice",
    entityId: "template",
    action: "customs-invoice.template.deleted",
    actor: user.email,
    data: { filename },
  });

  return NextResponse.json({ ok: true, filename });
}
