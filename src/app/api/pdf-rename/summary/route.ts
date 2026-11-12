import { NextResponse } from "next/server";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { audit } from "@/lib/audit";
import { buildSummaryWorkbook, isSummaryReport, REPORT_LABEL, type SummaryRow } from "@/server/pdf-rename/excel-summary";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Generate an Excel summary of a bulk PDF-rename run, in the shape of one of the
 * three reference templates (PO Extraction / Bill Of Export Data / FCR Extraction).
 *
 * The browser POSTs the scanned rows it already holds (one per processed PDF); the
 * server renders the .xlsx with exceljs and streams it back. It writes nothing to
 * disk and invents no values — only the fields the client extracted are included,
 * every other template column is blank, and failed rows are marked Success=false.
 *
 * Body (JSON): { report: "po"|"bill-of-export"|"fcr", rows: SummaryRow[] }
 */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  if (!userHasPermission(user, PERMISSIONS.JOB_READ)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let body: { report?: string; rows?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const report = String(body.report ?? "");
  if (!isSummaryReport(report)) return NextResponse.json({ error: "Unknown report type." }, { status: 400 });
  if (!Array.isArray(body.rows)) return NextResponse.json({ error: "No rows provided." }, { status: 400 });
  if (body.rows.length > 20000) return NextResponse.json({ error: "Too many rows for one summary (max 20000)." }, { status: 413 });

  // Coerce each incoming row to the builder's shape; never trust client types.
  const rows: SummaryRow[] = body.rows.map((r) => {
    const o = (r ?? {}) as Record<string, unknown>;
    const s = (v: unknown): string | null => (v == null ? null : String(v).slice(0, 500));
    const n = (v: unknown): number | null => (typeof v === "number" && isFinite(v) ? v : null);
    return {
      file: s(o.file) ?? "",
      invoiceNumber: s(o.invoiceNumber),
      fcrNumber: s(o.fcrNumber),
      containerNumber: s(o.containerNumber),
      expNumber: s(o.expNumber),
      confidence: n(o.confidence),
      success: Boolean(o.success),
      message: s(o.message),
    };
  });

  try {
    const buffer = await buildSummaryWorkbook(report, rows);
    await audit({ entityType: "document", entityId: "pdf-rename", action: "rename.summary.export", actor: user.email, data: { report, rows: rows.length } });
    const stamp = new Date().toISOString().slice(0, 10);
    const fileName = `${REPORT_LABEL[report]} - ${stamp}.xlsx`;
    return new NextResponse(buffer, {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Content-Length": String(buffer.length),
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not build the summary." }, { status: 500 });
  }
}
