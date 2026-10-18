import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

// Readiness probe — verifies the database dependency (SRS §5.11).
export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({ status: "ready", db: "ok" });
  } catch (e) {
    return NextResponse.json(
      { status: "not_ready", db: "down", error: e instanceof Error ? e.message : "unknown" },
      { status: 503 },
    );
  }
}
