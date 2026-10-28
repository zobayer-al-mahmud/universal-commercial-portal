import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { processSalesContractPoSet } from "@/server/sales-contract/intake";

/** One-shot admin endpoint: re-parses every PO's PDFs so parser fixes
 *  (salesMode / noOfPieces, etc.) flow into the stored JSON. */
export const dynamic = "force-dynamic";

export async function POST(): Promise<NextResponse> {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (!userHasPermission(user, PERMISSIONS.JOB_CREATE)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const pos = await prisma.salesContractPo.findMany({ select: { id: true, orderNo: true } });
  let ok = 0;
  let failed = 0;
  const errors: { orderNo: string; message: string }[] = [];
  for (const po of pos) {
    try {
      await processSalesContractPoSet(po.id, { actor: user.email });
      ok++;
    } catch (e) {
      failed++;
      errors.push({ orderNo: po.orderNo, message: e instanceof Error ? e.message : String(e) });
    }
  }
  return NextResponse.json({ ok: true, total: pos.length, reprocessed: ok, failed, errors });
}
