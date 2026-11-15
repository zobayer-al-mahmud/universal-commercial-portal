import { NextResponse } from "next/server";
import { createHash } from "crypto";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { env } from "@/lib/env";
import { isKnownFactory } from "@/server/ud-automation/factories";
import { importCatalog } from "@/server/ud-automation/intake";

/**
 * Import a BGMEA UD-list export (Tracking No / UD Date / Membership ID) into one
 * factory's catalog. Accepts a .txt / .csv / .tsv file. The import is scoped to the
 * `factoryId` in the form: rows for other factories are reported, not imported, so
 * catalog data stays factory-isolated. Duplicates and malformed rows are reported.
 */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  if (!userHasPermission(user, PERMISSIONS.UD_RUN)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected a multipart form upload." }, { status: 400 });
  }

  const factoryId = String(form.get("factoryId") || "");
  if (!isKnownFactory(factoryId)) return NextResponse.json({ error: "Unknown factory." }, { status: 400 });

  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "Choose a UD list file (.txt, .csv or .tsv)." }, { status: 400 });
  if (!/\.(txt|csv|tsv)$/i.test(file.name)) return NextResponse.json({ error: "Only .txt, .csv or .tsv files are accepted." }, { status: 400 });
  if (file.size > env.BGMEA_MAX_FILE_MB * 1024 * 1024) {
    return NextResponse.json({ error: `File is too large (limit ${env.BGMEA_MAX_FILE_MB} MB).` }, { status: 400 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  const text = buffer.toString("utf8");

  const report = await importCatalog({ factoryId, text, originalName: file.name, sha256, actor: user.email });
  if ("error" in report) return NextResponse.json({ error: report.error }, { status: 400 });
  return NextResponse.json({ report });
}
