import { NextResponse } from "next/server";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { uploadHmPdfSet } from "@/server/hm-sales-contract/intake";
import type { HmPdfKind } from "@/server/hm-sales-contract";

/**
 * Upload the three PDFs for ONE purchase order under an existing H&M Sales
 * Contract. multipart/form-data fields:
 *   - PurchaseOrder: File (required)
 *   - SizePerColourBreakdown: File (required)
 *   - TotalCountryBreakdown: File (required)
 *
 * Fewer than three files is accepted but will route the PO set to BLOCKED
 * (match fails) — the server never silently combines data from different POs.
 */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  if (!userHasPermission(user, PERMISSIONS.JOB_CREATE)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const form = await req.formData();
  const KINDS: HmPdfKind[] = ["PurchaseOrder", "SizePerColourBreakdown", "TotalCountryBreakdown"];
  const files: { name: string; buffer: Buffer; kind: HmPdfKind }[] = [];
  for (const kind of KINDS) {
    const entry = form.get(kind);
    if (!(entry instanceof File) || entry.size === 0 || entry.name === "") continue;
    files.push({ name: entry.name, buffer: Buffer.from(await entry.arrayBuffer()), kind });
  }
  if (files.length === 0) return NextResponse.json({ error: "No PDFs supplied." }, { status: 400 });

  try {
    const res = await uploadHmPdfSet(params.id, files, { actor: user.email });
    return NextResponse.json({ poId: res.poId, rejected: res.rejected });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Upload failed." }, { status: 400 });
  }
}
