import { NextResponse } from "next/server";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { readExpAuthLock, EXP_AUTH_LOCK_MESSAGE } from "@/server/exp-automation/auth-lock";

/**
 * Global Bangladesh Bank EXP sign-in lock state, polled by the EXP module so the
 * popup/banner appears the moment a wrong password stops automation. Carries no
 * secret (username only, for display) and the operator-facing message.
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  if (!userHasPermission(user, PERMISSIONS.EXP_RUN)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const lock = await readExpAuthLock();
  return NextResponse.json({ ...lock, message: EXP_AUTH_LOCK_MESSAGE }, { headers: { "Cache-Control": "no-store" } });
}
