import { readFile, readdir } from "fs/promises";
import path from "path";
import { NextResponse } from "next/server";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";
import { resolveFolder } from "@/server/pdf-rename/folder-rename";
import { buildZip, type ZipEntry } from "@/server/booking-correction/zip";

/**
 * Bundle a folder's renamed copies (the output sub-folder) into one .zip.
 * Read-only; only the already-renamed PDFs are included.
 */
export async function GET(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  if (!userHasPermission(user, PERMISSIONS.JOB_READ)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (!env.PDF_RENAME_ROOT) return NextResponse.json({ error: "PDF_RENAME_ROOT not configured" }, { status: 400 });

  const folder = new URL(req.url).searchParams.get("folder") ?? "";
  let outputDir: string;
  try {
    outputDir = path.join(resolveFolder(env.PDF_RENAME_ROOT, folder), env.PDF_RENAME_OUTPUT_SUBDIR);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Bad folder" }, { status: 400 });
  }

  let names: string[] = [];
  try {
    const entries = await readdir(outputDir, { withFileTypes: true });
    names = entries.filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".pdf")).map((e) => e.name);
  } catch {
    return NextResponse.json({ error: "No renamed files yet for this folder." }, { status: 404 });
  }
  if (names.length === 0) return NextResponse.json({ error: "No renamed files yet for this folder." }, { status: 404 });

  const entries: ZipEntry[] = [];
  for (const name of names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))) {
    try {
      entries.push({ name, data: await readFile(path.join(outputDir, name)) });
    } catch {
      /* skip unreadable */
    }
  }

  const zip = buildZip(entries);
  await audit({ entityType: "document", entityId: folder, action: "rename.folder.zip", actor: user.email, data: { files: entries.length } });
  const safe = folder.replace(/[^\w.-]+/g, "-");
  return new NextResponse(new Uint8Array(zip), {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Length": String(zip.length),
      "Content-Disposition": `attachment; filename="${safe}-renamed.zip"`,
      "Cache-Control": "private, no-store",
    },
  });
}
