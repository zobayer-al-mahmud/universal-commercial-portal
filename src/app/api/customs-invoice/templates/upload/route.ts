import { NextResponse } from "next/server";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { env } from "@/lib/env";
import { audit } from "@/lib/audit";
import { saveUploadedTemplate } from "@/server/customs-invoice/templates";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface UploadResult {
  file: string;
  ok: boolean;
  countryCode?: string;
  variant?: string;
  error?: string;
}

/**
 * POST /api/customs-invoice/templates/upload
 *
 * Body: multipart/form-data with one or more `files` entries. Each must be an
 * .xlsx whose filename matches the resolver's naming pattern
 *   `<invoiceNo> <countryCode>[(variant)].xlsx`
 * so the country/sub-code lookup can place it. Files land under
 * STORAGE_ROOT/customs-invoice-templates/.
 */
export async function POST(req: Request): Promise<Response> {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  if (!userHasPermission(user, PERMISSIONS.JOB_CREATE)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch (e) {
    return NextResponse.json(
      { error: `Invalid form data: ${e instanceof Error ? e.message : "unknown"}` },
      { status: 400 },
    );
  }

  const entries = form.getAll("files");
  if (entries.length === 0) return NextResponse.json({ error: "No files supplied." }, { status: 400 });

  const maxBytes = env.CUSTOMS_INVOICE_MAX_FILE_MB * 1024 * 1024;
  const results: UploadResult[] = [];
  let saved = 0;

  for (const e of entries) {
    if (!(e instanceof File)) continue;
    const name = e.name;
    if (e.size === 0) {
      results.push({ file: name, ok: false, error: "Empty file." });
      continue;
    }
    if (e.size > maxBytes) {
      results.push({ file: name, ok: false, error: `File is ${(e.size / 1024 / 1024).toFixed(1)} MB; limit is ${env.CUSTOMS_INVOICE_MAX_FILE_MB} MB.` });
      continue;
    }
    try {
      const buf = Buffer.from(await e.arrayBuffer());
      const r = await saveUploadedTemplate(name, buf);
      if (!r.ok || !r.template) {
        results.push({ file: name, ok: false, error: r.error ?? "Save failed." });
        continue;
      }
      results.push({ file: name, ok: true, countryCode: r.template.countryCode, variant: r.template.variant });
      saved++;
    } catch (err) {
      results.push({ file: name, ok: false, error: err instanceof Error ? err.message : "upload failed" });
    }
  }

  await audit({
    entityType: "customs-invoice",
    entityId: "template",
    action: "customs-invoice.template.uploaded",
    actor: user.email,
    data: { saved, totalReceived: entries.length, files: results.map((r) => ({ file: r.file, ok: r.ok, code: r.countryCode })) },
  });

  return NextResponse.json({ saved, totalReceived: entries.length, results });
}
