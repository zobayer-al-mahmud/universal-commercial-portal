import { NextResponse } from "next/server";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { env } from "@/lib/env";
import { isExpKind } from "@/server/exp-automation/types";
import { createExpJobFromBuffer } from "@/server/exp-automation/batch";

/** Upload one EXP workbook (multipart: `file` + `kind`) → create a job + rows. */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  if (!userHasPermission(user, PERMISSIONS.EXP_RUN)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected a multipart form upload." }, { status: 400 });
  }

  const kind = String(form.get("kind") || "");
  if (!isExpKind(kind)) return NextResponse.json({ error: "Unknown workflow kind." }, { status: 400 });

  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "Choose an .xlsx file." }, { status: 400 });
  if (!/\.xlsx$/i.test(file.name)) return NextResponse.json({ error: "Only .xlsx files are accepted." }, { status: 400 });
  if (file.size > env.EXP_MAX_FILE_MB * 1024 * 1024) {
    return NextResponse.json({ error: `File is too large (limit ${env.EXP_MAX_FILE_MB} MB).` }, { status: 400 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const res = await createExpJobFromBuffer({ buffer, kind, sourceName: file.name, actor: user.email });
  if ("error" in res) return NextResponse.json({ error: res.error }, { status: 400 });
  return NextResponse.json(res);
}
