import { NextRequest, NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { generateHmSummary } from "@/server/sales-contract/summary";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

/**
 * Generate (or re-generate) the consolidated H&M Summary Excel across every
 * Sales Contract and return it as a .xlsx download. Preserves any manual
 * Remarks / Without Discount / Discount FOB values from the previously
 * generated workbook when `?template=<absolute path>` is supplied.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (!userHasPermission(user, PERMISSIONS.JOB_READ)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const { searchParams } = new URL(req.url);
  const templatePath = searchParams.get("template") || undefined;
  const contractId = searchParams.get("contractId") || undefined;

  try {
    const result = await generateHmSummary({ templatePath, contractId });
    const buffer = await readFile(result.outputPath);
    await audit({
      entityType: "contract", entityId: contractId ?? "all",
      action: "hm.summary.generated", actor: user.email,
      data: {
        total: result.totalRows,
        inserted: result.insertedRows,
        preserved: result.preservedRows,
        skippedMatches: result.skippedExistingMatches.length,
        ambiguous: result.ambiguousMatches.length,
        skippedPos: result.skippedPos.length,
      },
    });
    return new NextResponse(buffer as unknown as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${basename(result.outputPath)}"`,
        "Cache-Control": "private, no-store",
        "X-Rows": String(result.totalRows),
        "X-Skipped-POs": String(result.skippedPos.length),
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Summary generation failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
