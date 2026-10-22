import { NextResponse } from "next/server";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { createHmContract, updateHmContractHeader } from "@/server/hm-sales-contract/intake";

/**
 * Create a new Sales Contract with just a Merchant Contract No. (column A).
 * Called by the "+ Create" button in the pick-or-create section — leaves every
 * other BR-HM-01..05-blocked field blank; the user fills them later.
 */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  if (!userHasPermission(user, PERMISSIONS.JOB_CREATE)) return NextResponse.json({ error: "Forbidden." }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const marchentContNo = String(body.marchentContNo ?? "").trim();
  if (!marchentContNo) return NextResponse.json({ error: "Please type a Sales Contract No." }, { status: 400 });

  const id = await createHmContract({ actor: user.email });
  await updateHmContractHeader(id, { marchentContNo }, { actor: user.email });
  return NextResponse.json({ id, marchentContNo });
}
