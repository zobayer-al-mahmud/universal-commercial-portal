import { NextResponse } from "next/server";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS, type PermissionKey } from "@/lib/permissions";
import type { AutomationScope } from "@/server/automation/cancellation";

/**
 * One Stop endpoint for every UCP automation module. The frontend Stop button
 * POSTs `{ scope, id }`; this resolves the scope to the right permission + the
 * module's own stop function (dynamically imported so modules stay decoupled),
 * which flips the shared cancellation flag, closes any live browser, marks the
 * interrupted row Stopped and parks the job durably so it cannot silently
 * restart. Already-completed rows, downloaded files and saved data are untouched.
 */

type Stopper = (id: string, actor: string) => Promise<{ ok: boolean; message: string }>;

const SCOPES: Record<AutomationScope, { permission: PermissionKey; load: () => Promise<Stopper> }> = {
  exp: {
    permission: PERMISSIONS.EXP_RUN,
    load: async () => (await import("@/server/exp-automation/batch")).requestStopExpJob,
  },
  container: {
    permission: PERMISSIONS.CONTAINER_SEARCH,
    load: async () => (await import("@/server/container/batch")).requestStopContainerBatch,
  },
  booking: {
    permission: PERMISSIONS.JOB_CREATE,
    load: async () => (await import("@/server/booking-correction/batch")).requestStopBookingBatch,
  },
  "pdf-rename": {
    permission: PERMISSIONS.JOB_CREATE,
    load: async () => (await import("@/server/pdf-rename/job-run")).requestStopPdfRenameJob,
  },
};

export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });

  let body: { scope?: string; id?: string };
  try {
    body = (await req.json()) as { scope?: string; id?: string };
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  const scope = String(body.scope ?? "") as AutomationScope;
  const id = String(body.id ?? "").trim();
  const entry = SCOPES[scope];
  if (!entry || !id) return NextResponse.json({ error: "Unknown automation scope or missing id." }, { status: 400 });
  if (!userHasPermission(user, entry.permission)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  try {
    const stop = await entry.load();
    const r = await stop(id, user.email);
    return r.ok ? NextResponse.json({ ok: true, message: r.message }) : NextResponse.json({ error: r.message }, { status: 404 });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Stop failed." }, { status: 500 });
  }
}
