import { NextResponse } from "next/server";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { prisma } from "@/lib/db";
import { parseSalesContractXlsx, importRowsIntoContract } from "@/server/hm-sales-contract/import-xlsx";

/**
 * Bulk import PO rows from an .xlsx into an existing Sales Contract. Parses
 * the first worksheet, finds the header row by locating "Order No.", maps
 * columns by name (case-insensitive), and upserts one HmSalesContractPo per
 * unique Order No. Duplicates (same contract + same Order No.) are SKIPPED
 * — never create a second row for the same PO.
 *
 * multipart/form-data fields:
 *   - file: .xlsx (max HM_SALES_CONTRACT_MAX_FILE_MB, same cap as PDFs)
 */
const MAX_BYTES = 50 * 1024 * 1024; // 50 MB hard ceiling; the env cap applies above.

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  if (!userHasPermission(user, PERMISSIONS.JOB_CREATE)) return NextResponse.json({ error: "Forbidden." }, { status: 403 });

  const contract = await prisma.hmSalesContract.findUnique({ where: { id: params.id }, select: { id: true } });
  if (!contract) return NextResponse.json({ error: "Sales Contract not found." }, { status: 404 });

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: "No file uploaded." }, { status: 400 });
  }
  if (!/\.xlsx$/i.test(file.name)) {
    return NextResponse.json({ error: "Only .xlsx files are supported." }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: `File exceeds ${MAX_BYTES / 1024 / 1024} MB.` }, { status: 400 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const { rows, rejectedRows: parseErrors } = await parseSalesContractXlsx(buffer);
  if (rows.length === 0 && parseErrors.length) {
    return NextResponse.json({ error: parseErrors[0].reason }, { status: 400 });
  }
  if (rows.length === 0) {
    return NextResponse.json({ error: "No data rows found below the header." }, { status: 400 });
  }

  const result = await importRowsIntoContract(params.id, rows, { actor: user.email });
  return NextResponse.json({ ok: true, result });
}
