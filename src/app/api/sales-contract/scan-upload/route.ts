import { NextRequest, NextResponse } from "next/server";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import {
  previewScanFromUploads,
  commitScannedFromUploads,
  type UploadedBuffer,
} from "@/server/sales-contract/scan-folder";

/**
 * Browser folder-picker upload (user rule 2026-11-03):
 *   action=preview → multipart with many files, returns the Detected Orders.
 *   action=commit  → same shape, writes the complete sets to the DB.
 *
 * The user picks a folder on their PC via `<input type="file" webkitdirectory>`;
 * each selected file is streamed up here and scanned in memory, so the server
 * never needs to see the user's filesystem.
 */
export const dynamic = "force-dynamic";

// 2 GiB uploads should fit a day's folder of H&M .msg files; next.js default
// (1 MB json body limit) only applies to JSON — multipart has no explicit cap
// beyond the server's own request-size, which we leave to the host.
export const maxDuration = 300;

export async function POST(req: NextRequest): Promise<NextResponse> {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (!userHasPermission(user, PERMISSIONS.JOB_CREATE)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let form: FormData;
  try { form = await req.formData(); }
  catch { return NextResponse.json({ error: "Expected multipart/form-data." }, { status: 400 }); }

  const action = String(form.get("action") || "preview") as "preview" | "commit";
  const contractId = String(form.get("contractId") || "").trim();
  const folderLetter = String(form.get("folderLetter") || "").trim().toUpperCase();
  if (!contractId || !folderLetter) {
    return NextResponse.json({ error: "contractId and folderLetter required." }, { status: 400 });
  }

  const orderNosRaw = form.get("orderNos");
  const orderNos = typeof orderNosRaw === "string" && orderNosRaw
    ? (JSON.parse(orderNosRaw) as string[])
    : undefined;

  // Collect every file entry (field name `files`) + its browser-reported
  // relative path (field name `paths`, same index). webkitdirectory reports
  // `webkitRelativePath` which we send alongside each file.
  const fileEntries = form.getAll("files");
  const pathEntries = form.getAll("paths");
  const uploads: UploadedBuffer[] = [];
  for (let i = 0; i < fileEntries.length; i++) {
    const f = fileEntries[i];
    if (!(f instanceof File)) continue;
    const name = f.name;
    // Skip anything that's clearly not a scannable artifact.
    if (!/\.(msg|pdf)$/i.test(name)) continue;
    const buf = Buffer.from(await f.arrayBuffer());
    const relRaw = pathEntries[i];
    const relativePath = typeof relRaw === "string" && relRaw ? relRaw : name;
    uploads.push({ name, relativePath, bytes: buf });
  }
  if (uploads.length === 0) {
    return NextResponse.json({ error: "No .msg or .pdf files were received." }, { status: 400 });
  }

  try {
    if (action === "preview") {
      const preview = await previewScanFromUploads(uploads);
      return NextResponse.json({ ok: true, preview });
    }
    if (action === "commit") {
      const result = await commitScannedFromUploads({
        contractId,
        folderLetter,
        orderNos,
        actor: user.email,
        files: uploads,
      });
      return NextResponse.json({ ok: true, result });
    }
    return NextResponse.json({ error: `Unknown action '${action}'.` }, { status: 400 });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Scan failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
