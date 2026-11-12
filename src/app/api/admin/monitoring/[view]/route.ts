import { NextResponse } from "next/server";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getOverviewSnapshot } from "@/server/monitoring";
import { getUserMonitoring } from "@/server/monitoring/users";
import { getUnifiedLogs, type LogLevel } from "@/server/monitoring/logs";
import { getErrors } from "@/server/monitoring/errors";
import { getRunningJobs } from "@/server/automation/running-jobs";

/**
 * Super Admin Control Center data API. Every view is gated on SYSTEM_MONITOR on
 * the BACKEND (not just hidden in the UI). Read-only; returns live, real data.
 * Polled by the dashboard for near-real-time refresh.
 */

export const dynamic = "force-dynamic";

function parseDate(v: string | null): Date | undefined {
  if (!v) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export async function GET(req: Request, { params }: { params: { view: string } }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  if (!userHasPermission(user, PERMISSIONS.SYSTEM_MONITOR)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const url = new URL(req.url);
  const qp = url.searchParams;

  try {
    switch (params.view) {
      case "overview":
        return NextResponse.json(await getOverviewSnapshot());
      case "users":
        return NextResponse.json(await getUserMonitoring());
      case "processes":
        return NextResponse.json({ jobs: await getRunningJobs(120) });
      case "logs":
        return NextResponse.json({
          logs: await getUnifiedLogs({
            source: qp.get("source") || undefined,
            level: (qp.get("level") as LogLevel) || undefined,
            search: qp.get("search") || undefined,
            since: parseDate(qp.get("since")),
            until: parseDate(qp.get("until")),
            limit: qp.get("limit") ? Number(qp.get("limit")) : undefined,
          }),
        });
      case "errors":
        return NextResponse.json({
          errors: await getErrors({
            level: qp.get("level") || undefined,
            source: qp.get("source") || undefined,
            search: qp.get("search") || undefined,
            includeResolved: qp.get("includeResolved") === "1",
            since: parseDate(qp.get("since")),
            until: parseDate(qp.get("until")),
            limit: qp.get("limit") ? Number(qp.get("limit")) : undefined,
          }),
        });
      default:
        return NextResponse.json({ error: "Unknown view" }, { status: 404 });
    }
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Monitoring query failed" }, { status: 500 });
  }
}
