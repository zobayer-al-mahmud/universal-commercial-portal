import { NextResponse } from "next/server";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { uploadHmBatch, type BatchFile } from "@/server/hm-sales-contract/batch-upload";
import type { HmPdfKind } from "@/server/hm-sales-contract";

/**
 * Upload up to 3 PDFs for a selected Sales Contract and process them end-to-end
 * (extract → group by Order No. → merge into existing PO row OR create new →
 * conflict-detect against previous values). Runs on a regular API route (NOT a
 * server action) so file uploads bypass the 1 MB default server-action body
 * limit — real H&M PDFs often exceed that in a batch.
 *
 * multipart/form-data fields:
 *   - contractId:              required (HmSalesContract.id)
 *   - PurchaseOrder:           File (optional, max 1)
 *   - SizePerColourBreakdown:  File (optional, max 1)
 *   - TotalCountryBreakdown:   File (optional, max 1)
 */
const KINDS: HmPdfKind[] = ["PurchaseOrder", "SizePerColourBreakdown", "TotalCountryBreakdown"];

export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  if (!userHasPermission(user, PERMISSIONS.JOB_CREATE)) return NextResponse.json({ error: "Forbidden." }, { status: 403 });

  const form = await req.formData();
  const contractId = String(form.get("contractId") ?? "").trim();
  if (!contractId) return NextResponse.json({ error: "Please select a target Sales Contract." }, { status: 400 });

  const files: BatchFile[] = [];
  for (const kind of KINDS) {
    const entry = form.get(kind);
    if (!(entry instanceof File) || entry.size === 0 || entry.name === "") continue;
    files.push({ name: entry.name, buffer: Buffer.from(await entry.arrayBuffer()), kind });
  }
  if (files.length === 0) {
    return NextResponse.json({ error: "No PDFs supplied — upload at least one of the three PDF slots." }, { status: 400 });
  }

  try {
    const result = await uploadHmBatch(contractId, files, { actor: user.email });
    return NextResponse.json({ ok: true, result, contractId });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Batch upload failed." }, { status: 400 });
  }
}
