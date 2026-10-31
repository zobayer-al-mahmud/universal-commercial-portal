import { readFile } from "fs/promises";
import { join } from "path";
import { NextResponse } from "next/server";
import JSZip from "jszip";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { audit } from "@/lib/audit";
import { writeSalesContractWorkbook } from "@/server/sales-contract";
import { buildOverridesForContract, loadContractSets } from "@/server/sales-contract/intake";

/**
 * Bulk download: return a ZIP with one .xlsx per selected Sales Contract.
 * Each file is generated with the same writer the single-contract download
 * uses, so each resolves to its own prototype-matching workbook.
 *
 * Body: { ids: string[] } — SalesContract ids.
 */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  if (!userHasPermission(user, PERMISSIONS.JOB_CREATE))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = (await req.json().catch(() => ({}))) as { ids?: string[] };
  const ids = (body.ids ?? []).map((s) => String(s)).filter(Boolean).slice(0, 200);
  if (ids.length === 0)
    return NextResponse.json({ error: "No contracts selected." }, { status: 400 });

  const contracts = await prisma.salesContract.findMany({ where: { id: { in: ids } } });
  if (contracts.length === 0)
    return NextResponse.json({ error: "No matching contracts." }, { status: 404 });

  const zip = new JSZip();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
  const seen = new Map<string, number>();
  for (const contract of contracts) {
    const sets = await loadContractSets(contract.id);
    if (sets.length === 0) continue; // skip empty contracts rather than fail the whole ZIP
    const outDir = join(env.STORAGE_ROOT, "sales-contract", contract.id, "exports");
    const safeRef = (contract.marchentContNo || contract.commercialContNo || contract.id.slice(0, 8))
      .replace(/[^\w.-]+/g, "_");
    const outputPath = join(outDir, `SalesContract_${safeRef}_${stamp}.xlsx`);
    const overrides = await buildOverridesForContract(contract.id);
    const result = await writeSalesContractWorkbook({
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
        reviseNo: contract.reviseNo || undefined,
      },
      sets: sets as never,
      overrides,
    });
    await prisma.salesContract.update({ where: { id: contract.id }, data: { status: "exported" } });
    await audit({
      entityType: "contract",
      entityId: contract.id,
      action: "hm.contract.exported",
      actor: user.email,
      data: { rows: result.appendedRows, outputPath, bulk: true },
    });
    const data = await readFile(outputPath);
    let name = `SalesContract_${safeRef}.xlsx`;
    const n = seen.get(name) ?? 0;
    if (n > 0) name = name.replace(/\.xlsx$/, `_${n + 1}.xlsx`);
    seen.set(name, n + 1);
    zip.file(name, data);
  }

  const bytes = await zip.generateAsync({ type: "nodebuffer" });
  const filename = `SalesContracts_${new Date().toISOString().slice(0, 10)}.zip`;
  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(bytes.byteLength),
    },
  });
}
