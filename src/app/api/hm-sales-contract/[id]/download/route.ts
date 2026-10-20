import { readFile } from "fs/promises";
import { join } from "path";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { audit } from "@/lib/audit";
import { writeSalesContractWorkbook } from "@/server/hm-sales-contract";
import { buildOverridesForContract, loadContractSets } from "@/server/hm-sales-contract/intake";

/**
 * Download the generated A..U workbook for a Sales Contract.
 *
 * Writes to a NEW file under `${STORAGE_ROOT}/hm-sales-contract/${id}/exports/`
 * (the user's template is never modified — the writer copyFile's it first).
 */
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  if (!userHasPermission(user, PERMISSIONS.JOB_CREATE)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const contract = await prisma.hmSalesContract.findUnique({ where: { id: params.id } });
  if (!contract) return NextResponse.json({ error: "Contract not found." }, { status: 404 });
  const templatePath = env.HM_SALES_CONTRACT_TEMPLATE_PATH;
  if (!templatePath) {
    return NextResponse.json({
      error: "HM_SALES_CONTRACT_TEMPLATE_PATH not configured — set it in .env to the path of the user's Sales Contract workbook.",
    }, { status: 400 });
  }

  const sets = await loadContractSets(contract.id);
  if (sets.length === 0) return NextResponse.json({ error: "No PO sets uploaded yet." }, { status: 400 });

  const outDir = join(env.STORAGE_ROOT, "hm-sales-contract", contract.id, "exports");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
  const safeRef = (contract.marchentContNo || contract.commercialContNo || contract.id.slice(0, 8)).replace(/[^\w.-]+/g, "_");
  const outputPath = join(outDir, `SalesContract_${safeRef}_${stamp}.xlsx`);

  const overrides = await buildOverridesForContract(contract.id);
  const result = await writeSalesContractWorkbook({
    templatePath,
    outputPath,
    header: {
      marchentContNo: contract.marchentContNo || undefined,
      date: contract.contractDate || undefined,
      buyerCode: contract.buyerCode || undefined,
      commercialContNo: contract.commercialContNo || undefined,
      dateCommercial: contract.commercialDate || undefined,
      merchandiserName: contract.merchandiserName || undefined,
      packSet: contract.packSet || undefined,
      remarksDefault: contract.remarksDefault || undefined,
    },
    sets: sets as never,
    overrides,
  });

  await prisma.hmSalesContract.update({ where: { id: contract.id }, data: { status: "exported" } });
  await audit({ entityType: "contract", entityId: contract.id, action: "hm.contract.exported", actor: user.email, data: { rows: result.appendedRows, outputPath } });

  const data = await readFile(outputPath);
  const filename = `SalesContract_${safeRef}_${stamp}.xlsx`;
  return new NextResponse(data, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(data.byteLength),
    },
  });
}
