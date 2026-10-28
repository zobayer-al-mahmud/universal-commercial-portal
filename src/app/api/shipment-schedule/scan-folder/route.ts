import { NextResponse } from "next/server";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { scanBookingFolder } from "@/server/shipment-schedule/scan-booking-folder";

export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  if (!userHasPermission(user, PERMISSIONS.JOB_CREATE)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const body = await req.json().catch(() => ({})) as { folderPath?: string };
  const folderPath = (body.folderPath || "").trim();
  if (!folderPath) return NextResponse.json({ error: "Folder path required." }, { status: 400 });
  try {
    const result = await scanBookingFolder({ folderPath, actor: user.email });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Scan failed." },
      { status: 400 },
    );
  }
}
