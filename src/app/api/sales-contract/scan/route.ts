import { NextRequest, NextResponse } from "next/server";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { previewScan, commitScannedOrders } from "@/server/sales-contract/scan-folder";

/**
 * One endpoint, two modes:
 *   { action: "preview" } — dry-run, returns the Detected Orders table.
 *   { action: "commit",  orderNos: ["643159-8756", ...] } — imports the given orders.
 */
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (!userHasPermission(user, PERMISSIONS.JOB_CREATE)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: {
    action?: "preview" | "commit";
    contractId?: string;
    folderLetter?: string;
    parentPath?: string;
    orderNos?: string[];
  };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 }); }

  const action = body.action ?? "preview";
  const contractId = String(body.contractId ?? "").trim();
  const folderLetter = String(body.folderLetter ?? "").trim().toUpperCase();
  const parentPath = body.parentPath ? String(body.parentPath).trim() : undefined;
  if (!contractId || !folderLetter) {
    return NextResponse.json({ error: "contractId and folderLetter required." }, { status: 400 });
  }

  try {
    if (action === "preview") {
      const preview = await previewScan({ contractId, folderLetter, parentPath, actor: user.email });
      return NextResponse.json({ ok: true, preview });
    }
    if (action === "commit") {
      const result = await commitScannedOrders({
        contractId,
        folderLetter,
        parentPath,
        orderNos: Array.isArray(body.orderNos) ? body.orderNos.map(String) : undefined,
        actor: user.email,
      });
      return NextResponse.json({ ok: true, result });
    }
    return NextResponse.json({ error: `Unknown action '${action}'.` }, { status: 400 });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Scan failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
