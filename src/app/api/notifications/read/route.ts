import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { markRead, markAllRead } from "@/server/notifications/notify";

export const dynamic = "force-dynamic";

/**
 * Mark a notification read, or all of them. Always scoped to the session user's
 * own rows — a user can never mark another user's notifications read.
 * Body: { id } for one, or { all: true } for every unread.
 */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  let body: { id?: string; all?: boolean };
  try { body = await req.json(); } catch { body = {}; }
  if (body.all) {
    const { updated } = await markAllRead(user.id);
    return NextResponse.json({ ok: true, updated });
  }
  if (body.id) {
    const { ok } = await markRead(user.id, String(body.id));
    return NextResponse.json({ ok });
  }
  return NextResponse.json({ error: "Provide { id } or { all: true }." }, { status: 400 });
}
