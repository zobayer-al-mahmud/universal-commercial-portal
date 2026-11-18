import { NextRequest, NextResponse } from "next/server";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import {
  ingestBookingPdfsForInvoices,
  type BookingIngestFileInput,
} from "@/server/customs-invoice/booking-ingest";

/**
 * Bulk booking-PDF upload for the Customs Invoice flow (user rule 2026-11-12).
 * Accepts N files under the `files` multipart key. Each is parsed and used
 * to refresh the matching ShipmentScheduleRow(s); the per-invoice open-time
 * auto-sync then picks the new PDF fields up.
 *
 * Never creates schedules, cut-offs, or shipment rows — if nothing matches,
 * the file is reported as skipped so the user can run the PO scan first.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (!userHasPermission(user, PERMISSIONS.JOB_CREATE)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart/form-data" }, { status: 400 });
  }

  const entries = form.getAll("files");
  const inputs: BookingIngestFileInput[] = [];
  for (const entry of entries) {
    if (!(entry instanceof File)) continue;
    if (!/\.pdf$/i.test(entry.name)) continue;
    const buf = Buffer.from(await entry.arrayBuffer());
    inputs.push({ filename: entry.name, buffer: buf });
  }
  if (inputs.length === 0) {
    return NextResponse.json({ error: "No PDF files in request (field name must be 'files')" }, { status: 400 });
  }

  try {
    const result = await ingestBookingPdfsForInvoices(inputs, { actor: user.email });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Booking-PDF ingest failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
