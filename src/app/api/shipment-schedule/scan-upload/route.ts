import { NextResponse } from "next/server";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { scanBookingUploads, type BookingPdfInput } from "@/server/shipment-schedule/scan-booking-folder";

/**
 * Companion to `/scan-folder`: accepts PDFs the browser already has in memory
 * (from the user picking a folder with the file picker). Processes them
 * identically — dedup by sha256, match + hydrate the existing row.
 */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  if (!userHasPermission(user, PERMISSIONS.JOB_CREATE)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const form = await req.formData();
  const folderLabel = String(form.get("folderLabel") ?? "").slice(0, 200);
  const files = form.getAll("files").filter((f): f is File => f instanceof File);
  const pdfs: BookingPdfInput[] = [];
  for (const f of files) {
    if (!f.name.toLowerCase().endsWith(".pdf")) continue;
    pdfs.push({ fileName: f.name, buffer: Buffer.from(await f.arrayBuffer()) });
  }
  if (pdfs.length === 0) return NextResponse.json({ error: "No PDFs in the picked folder." }, { status: 400 });

  try {
    const result = await scanBookingUploads({ pdfs, folderLabel, actor: user.email });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Scan failed." },
      { status: 400 },
    );
  }
}
