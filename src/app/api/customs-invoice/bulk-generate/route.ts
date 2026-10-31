import { NextResponse } from "next/server";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { audit } from "@/lib/audit";
import {
  generateBulkInvoices,
  parseBulkInvoiceXlsx,
  type BulkRowResult,
} from "@/server/customs-invoice/bulk-import";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/customs-invoice/bulk-generate
 *
 * Body: multipart/form-data with:
 *   - xlsx: the uploaded Excel (one row per Order No)
 *   - mode: "zip" (default) returns a ZIP of generated invoices;
 *           "json" returns only the per-row log so the UI can preview before
 *           downloading. Omit for ZIP.
 */
export async function POST(req: Request): Promise<Response> {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  if (!userHasPermission(user, PERMISSIONS.JOB_CREATE)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch (e) {
    return NextResponse.json(
      { error: `Invalid form data: ${e instanceof Error ? e.message : "unknown"}` },
      { status: 400 },
    );
  }

  const file = form.get("xlsx");
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: "No .xlsx file supplied." }, { status: 400 });
  }
  const mode = String(form.get("mode") ?? "zip").toLowerCase();

  const buffer = Buffer.from(await file.arrayBuffer());
  const parsed = await parseBulkInvoiceXlsx(buffer);
  if (parsed.rows.length === 0) {
    const reason = parsed.rejected[0]?.reason ?? "No order rows found in the Excel.";
    return NextResponse.json({ error: reason }, { status: 400 });
  }

  const r = await generateBulkInvoices(parsed.rows, { actor: user.email });

  await audit({
    entityType: "customs-invoice",
    entityId: "bulk",
    action: "customs-invoice.bulk-generated",
    actor: user.email,
    data: { summary: r.summary, source: file.name },
  });

  if (mode === "json") {
    return NextResponse.json({ summary: r.summary, results: compactResults(r.results) });
  }

  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "").replace(/-/g, "");
  const filename = `CustomsInvoices_bulk_${stamp}.zip`;
  return new NextResponse(new Uint8Array(r.zipBuffer), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(r.zipBuffer.byteLength),
      "X-Bulk-Generated": String(r.summary.generated),
      "X-Bulk-Templated": String(r.summary.templated),
      "X-Bulk-Fresh-Fallback": String(r.summary.freshFallback),
      "X-Bulk-Errors": String(r.summary.errors),
    },
  });
}

function compactResults(rs: BulkRowResult[]) {
  return rs.map((r) => ({
    orderNo: r.orderNo,
    countryCode: r.countryCode,
    templateUsed: r.templateUsed ? r.templateUsed.split(/[\\/]/).pop() : null,
    mode: r.mode,
    error: r.error ?? null,
  }));
}
