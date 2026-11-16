import { NextResponse } from "next/server";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { prisma } from "@/lib/db";
import { getRun, getRunReport } from "@/server/ud-automation/runs";

/**
 * Live progress / history of one BGMEA portal run (fetch or write-back) for a UD
 * record. Polled by the UI while a run is in flight. `?factory=` must match the
 * record's factory (cross-factory guard). `?report=1` adds the stored report
 * (dropdowns, reference lists, per-row write results). Never contains secrets.
 */
export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: { id: string; runId: string } }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  if (!userHasPermission(user, PERMISSIONS.UD_RUN)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const url = new URL(req.url);
  const factory = url.searchParams.get("factory") ?? "";
  const record = await prisma.udRecord.findUnique({ where: { id: params.id }, select: { factoryId: true } });
  if (!record || record.factoryId !== factory) return NextResponse.json({ error: "Not found." }, { status: 404 });

  const run = await getRun(params.id, params.runId);
  if (!run) return NextResponse.json({ run: null }, { status: 200 });
  const report = url.searchParams.get("report") === "1" ? await getRunReport(params.id, params.runId) : undefined;
  return NextResponse.json({ run, report }, { headers: { "Cache-Control": "no-store" } });
}
