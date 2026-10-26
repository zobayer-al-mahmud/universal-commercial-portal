import { NextResponse } from "next/server";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { env } from "@/lib/env";
import { parseInvoiceBulkXlsx, generateBulkInvoices } from "@/server/customs-invoice/bulk";

/** Bulk-generate customs invoices from an uploaded .xlsx (persist + build a ZIP). */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  if (!userHasPermission(user, PERMISSIONS.JOB_CREATE)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File) || file.size === 0) return NextResponse.json({ error: "Upload an .xlsx file of invoice rows." }, { status: 400 });
  if (!/\.xlsx$/i.test(file.name)) return NextResponse.json({ error: "Only .xlsx files are supported." }, { status: 400 });
  if (file.size > env.CUSTOMS_INVOICE_MAX_FILE_MB * 1024 * 1024) return NextResponse.json({ error: `File exceeds ${env.CUSTOMS_INVOICE_MAX_FILE_MB} MB.` }, { status: 400 });

  let parsed;
  try {
    parsed = await parseInvoiceBulkXlsx(Buffer.from(await file.arrayBuffer()));
  } catch (e) {
    return NextResponse.json({ error: `Could not read the workbook: ${e instanceof Error ? e.message : "parse failed"}` }, { status: 400 });
  }
  if (parsed.rows.length === 0) {
    return NextResponse.json({ error: parsed.rejected[0]?.reason || "No usable invoice rows found in the workbook." }, { status: 400 });
  }

  const result = await generateBulkInvoices({ rows: parsed.rows, rejected: parsed.rejected, actor: user.email });
  // Don't leak absolute disk paths to the client.
  const { zipPath: _zipPath, ...safe } = result;
  void _zipPath;
  return NextResponse.json({ ok: true, ...safe });
}
