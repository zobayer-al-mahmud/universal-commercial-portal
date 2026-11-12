import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { unreadCountForUser } from "@/server/notifications/notify";

export const dynamic = "force-dynamic";

/** Cheap unread-count endpoint for the bell badge poll (index-backed count). */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  const unread = await unreadCountForUser(user.id);
  return NextResponse.json({ unread }, { headers: { "Cache-Control": "no-store" } });
}
