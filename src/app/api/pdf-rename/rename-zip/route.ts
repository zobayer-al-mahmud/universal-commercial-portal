import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { env } from "@/lib/env";
import { audit } from "@/lib/audit";
import { buildZip, type ZipEntry } from "@/server/booking-correction/zip";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Fallback for browsers WITHOUT the File System Access API: the client uploads
 * the selected PDFs plus a map of original→final (invoice-based) names, and we
 * return a ZIP of the renamed COPIES for the user to download. Nothing on the
 * server (or the user's disk) is modified in place; the original bytes are only
 * repackaged under their new names. Duplicate final names are de-collided with a
 * numeric suffix so no file is silently overwritten inside the archive.
 *
 * multipart/form-data: `files` (the PDFs) + `names` (JSON { "<original>": "<final>.pdf" }).
 */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return new Response(JSON.stringify({ error: "Unauthenticated" }), { status: 401 });
  if (!userHasPermission(user, PERMISSIONS.RENAME_APPLY)) return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 });

  const form = await req.formData();
  const files = form.getAll("files").filter((f): f is File => f instanceof File);
  let names: Record<string, string> = {};
  try { names = JSON.parse(String(form.get("names") ?? "{}")) as Record<string, string>; } catch { names = {}; }
  if (files.length === 0) return new Response(JSON.stringify({ error: "No files uploaded." }), { status: 400 });

  const maxBytes = env.PDF_RENAME_MAX_FILE_MB * 1024 * 1024;
  const used = new Set<string>();
  const dedupe = (name: string): string => {
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : ".pdf";
    let candidate = name;
    let n = 2;
    while (used.has(candidate.toLowerCase())) candidate = `${stem}-${n++}${ext}`;
    used.add(candidate.toLowerCase());
    return candidate;
  };

  const entries: ZipEntry[] = [];
  for (const f of files) {
    if (f.size > maxBytes) continue; // skip oversized; client already warned
    const bytes = Buffer.from(await f.arrayBuffer());
    const chosen = (names[f.name] || f.name).replace(/[\\/]/g, "_").trim() || f.name;
    entries.push({ name: dedupe(chosen.toLowerCase().endsWith(".pdf") ? chosen : `${chosen}.pdf`), data: bytes });
  }
  if (entries.length === 0) return new Response(JSON.stringify({ error: "No files within the size limit." }), { status: 400 });

  const zip = buildZip(entries);
  await audit({ entityType: "document", entityId: "local-folder", action: "rename.local.zip", actor: user.email, data: { files: entries.length } });
  const body = new Uint8Array(zip);
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="UCP Renamed.zip"`,
      "Content-Length": String(body.byteLength),
    },
  });
}
