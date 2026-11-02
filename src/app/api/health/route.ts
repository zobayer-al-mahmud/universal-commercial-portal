import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

/**
 * Liveness/readiness probe for load balancers, Docker healthchecks and systemd.
 * Unauthenticated by design (reveals only liveness + DB reachability, no data or
 * secrets). 200 = healthy, 503 = DB unreachable.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const started = Date.now();
  let db: "ok" | "error" = "ok";
  try {
    await prisma.$queryRawUnsafe("SELECT 1");
  } catch {
    db = "error";
  }
  const ok = db === "ok";
  return NextResponse.json(
    {
      status: ok ? "ok" : "degraded",
      db,
      uptimeSec: Math.round(process.uptime()),
      ts: new Date().toISOString(),
      latencyMs: Date.now() - started,
    },
    { status: ok ? 200 : 503 },
  );
}
