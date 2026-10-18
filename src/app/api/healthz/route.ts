import { NextResponse } from "next/server";

// Liveness probe (SRS §5.11).
export async function GET() {
  return NextResponse.json({ status: "ok", service: "aucp", time: new Date().toISOString() });
}
