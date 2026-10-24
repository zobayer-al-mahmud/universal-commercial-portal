import { readFile } from "fs/promises";
import path from "path";
import { NextResponse } from "next/server";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";
import { resolveFolder } from "@/server/pdf-rename/folder-rename";

/**
 * Serve one PDF from the rename root — either an original (kind=original) or a
 * renamed copy from the output sub-folder (kind=renamed). Read-only, path-safe
 * (folder validated against the root; file name must be a bare name). Preview is
 * inline; `?download=1` forces a Save-As attachment.
 */
export async function GET(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  if (!userHasPermission(user, PERMISSIONS.JOB_READ)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (!env.PDF_RENAME_ROOT) return NextResponse.json({ error: "PDF_RENAME_ROOT not configured" }, { status: 400 });

  const url = new URL(req.url);
  const folder = url.searchParams.get("folder") ?? "";
  const name = url.searchParams.get("name") ?? "";
  const kind = url.searchParams.get("kind") === "renamed" ? "renamed" : "original";
  const download = url.searchParams.get("download") === "1";

  if (!name || /[\\/]/.test(name) || name.includes("..") || !name.toLowerCase().endsWith(".pdf")) {
    return NextResponse.json({ error: "Invalid file name" }, { status: 400 });
  }

  let abs: string;
  try {
    const folderAbs = resolveFolder(env.PDF_RENAME_ROOT, folder);
    abs = kind === "renamed" ? path.join(folderAbs, env.PDF_RENAME_OUTPUT_SUBDIR, name) : path.join(folderAbs, name);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Bad folder" }, { status: 400 });
  }

  let data: Buffer;
  try {
    data = await readFile(abs);
  } catch {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }

  await audit({ entityType: "document", entityId: folder, action: "rename.folder.file", actor: user.email, data: { name, kind, download } });

  return new NextResponse(new Uint8Array(data), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Length": String(data.length),
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${name}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
