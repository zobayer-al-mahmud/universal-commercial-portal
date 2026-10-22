import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { uploadPdfsToCutoff } from "@/server/shipment-schedule/intake";

/**
 * Upload one or more booking-confirmation PDFs to a specific cut-off of a
 * shipment schedule. multipart/form-data fields:
 *   - cutoffId: string (required)
 *   - files: File[] (one or many; field name "files")
 *
 * Each PDF becomes one ShipmentScheduleRow in that cut-off. The OrderNo (from
 * the filename) is cross-matched against the H&M Sales Contract POs; matched
 * rows have the Sales-Contract fields hydrated (Buyer Code, Cont.No., Date,
 * STYLE, FOB, COMPOSITION, PCS). Un-matched rows are still created so the
 * reviewer sees them with `matched=false` + a reason.
 */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  if (!userHasPermission(user, PERMISSIONS.JOB_CREATE)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const form = await req.formData();
  const cutoffId = String(form.get("cutoffId") ?? "").trim();
  if (!cutoffId) return NextResponse.json({ error: "cutoffId is required." }, { status: 400 });

  const files: { name: string; buffer: Buffer }[] = [];
  for (const entry of form.getAll("files")) {
    if (!(entry instanceof File) || entry.size === 0 || entry.name === "") continue;
    if (!entry.name.toLowerCase().endsWith(".pdf")) continue;
    files.push({ name: entry.name, buffer: Buffer.from(await entry.arrayBuffer()) });
  }
  if (files.length === 0) return NextResponse.json({ error: "No PDFs supplied." }, { status: 400 });

  try {
    const results = await uploadPdfsToCutoff({ scheduleId: params.id, cutoffId, files, actor: user.email });
    revalidatePath(`/shipment-schedule/${params.id}`);
    return NextResponse.json({ results });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Upload failed." }, { status: 400 });
  }
}
