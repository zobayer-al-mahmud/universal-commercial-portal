import { NextResponse } from "next/server";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { env } from "@/lib/env";
import { parseContainerXlsx, beginContainerBatch } from "@/server/container/batch";

/** Import container numbers from an uploaded .xlsx and start a bulk batch. */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  if (!userHasPermission(user, PERMISSIONS.CONTAINER_SEARCH)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File) || file.size === 0) return NextResponse.json({ error: "Upload an .xlsx file of container numbers." }, { status: 400 });
  if (!/\.xlsx$/i.test(file.name)) return NextResponse.json({ error: "Only .xlsx files are supported." }, { status: 400 });
  if (file.size > env.CONTAINER_MAX_FILE_MB * 1024 * 1024) return NextResponse.json({ error: `File exceeds ${env.CONTAINER_MAX_FILE_MB} MB.` }, { status: 400 });

  let parsed;
  try {
    parsed = await parseContainerXlsx(Buffer.from(await file.arrayBuffer()));
  } catch (e) {
    return NextResponse.json({ error: `Could not read the workbook: ${e instanceof Error ? e.message : "parse failed"}` }, { status: 400 });
  }

  const force = form?.get("force") === "1";
  const res = await beginContainerBatch({ containers: parsed, actor: user.email, force });
  if ("error" in res) return NextResponse.json({ error: res.error }, { status: 400 });
  return NextResponse.json(res);
}
