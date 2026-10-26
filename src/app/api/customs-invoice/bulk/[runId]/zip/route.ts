import { readFile } from "fs/promises";
import { NextResponse } from "next/server";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { audit } from "@/lib/audit";
import { bulkZipPath } from "@/server/customs-invoice/bulk";

/** Download the ZIP produced by a bulk invoice-generation run. */
export async function GET(_req: Request, { params }: { params: { runId: string } }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  if (!userHasPermission(user, PERMISSIONS.JOB_READ)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  // runId is a UUID; reject anything else so it can't be used to traverse paths.
  if (!/^[0-9a-f-]{36}$/i.test(params.runId)) return NextResponse.json({ error: "Invalid run id." }, { status: 400 });

  let data: Buffer;
  try {
    data = await readFile(bulkZipPath(params.runId));
  } catch {
    return NextResponse.json({ error: "This bulk run's ZIP is no longer available." }, { status: 404 });
  }

  await audit({ entityType: "customs-invoice", entityId: params.runId, action: "customs-invoice.bulk-zip.downloaded", actor: user.email });
  return new NextResponse(new Uint8Array(data), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="CustomsInvoices_${params.runId.slice(0, 8)}.zip"`,
      "Content-Length": String(data.byteLength),
      "Cache-Control": "private, no-store",
    },
  });
}
