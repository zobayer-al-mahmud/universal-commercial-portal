import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { listForUser } from "@/server/notifications/notify";

export const dynamic = "force-dynamic";

/**
 * The signed-in user's recent notifications + unread count (role-based visibility
 * is already baked in: a user only ever receives rows addressed to them, and this
 * query is scoped to their own userId). Used by the bell on open and on poll.
 */
export async function GET(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  const url = new URL(req.url);
  const limit = Number(url.searchParams.get("limit") ?? "30");
  const { items, unread } = await listForUser(user.id, { limit: Number.isFinite(limit) ? limit : 30 });
  return NextResponse.json({ items, unread }, { headers: { "Cache-Control": "no-store" } });
}
