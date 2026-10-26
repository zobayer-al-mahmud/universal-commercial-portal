import { NextResponse } from "next/server";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { prisma } from "@/lib/db";
import { parseScheduleXlsx, previewScheduleImport, commitScheduleImport } from "@/server/shipment-schedule/import-xlsx";

/**
 * Import Shipment Schedule rows from an .xlsx.
 *   mode=preview (default): parse + classify, return a preview (NO writes).
 *   mode=commit: parse + insert the "new" rows under the chosen cut-off.
 * The file is re-parsed + re-validated on commit so the client cannot inject
 * rows that were not in the workbook.
 */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  if (!userHasPermission(user, PERMISSIONS.JOB_CREATE)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const schedule = await prisma.shipmentSchedule.findUnique({ where: { id: params.id } });
  if (!schedule) return NextResponse.json({ error: "Shipment schedule not found." }, { status: 404 });

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File) || file.size === 0) return NextResponse.json({ error: "Upload an .xlsx file." }, { status: 400 });
  if (!/\.xlsx$/i.test(file.name)) return NextResponse.json({ error: "Only .xlsx files are supported." }, { status: 400 });

  let parsed;
  try {
    parsed = await parseScheduleXlsx(Buffer.from(await file.arrayBuffer()));
  } catch (e) {
    return NextResponse.json({ error: `Could not read the workbook: ${e instanceof Error ? e.message : "parse failed"}` }, { status: 400 });
  }
  if (parsed.rows.length === 0) {
    return NextResponse.json({ error: parsed.rejected[0]?.reason || "No data rows found in the workbook." }, { status: 400 });
  }

  const mode = String(form?.get("mode") ?? "preview");
  if (mode === "commit") {
    const cutoffId = form?.get("cutoffId") ? String(form.get("cutoffId")) : undefined;
    const result = await commitScheduleImport(params.id, parsed.rows, { cutoffId, actor: user.email });
    return NextResponse.json({ ok: true, ...result });
  }

  const preview = await previewScheduleImport(params.id, parsed.rows);
  return NextResponse.json({ ok: true, preview });
}
