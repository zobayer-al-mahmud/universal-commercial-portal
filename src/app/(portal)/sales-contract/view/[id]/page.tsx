import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { PageHeader } from "@/components/ui";
import { SalesContractBannerEditor } from "@/components/SalesContractBannerEditor";
import { SalesContractPoEditor, type SalesContractPoRow } from "@/components/SalesContractPoEditor";
import { SalesContractImport } from "@/components/SalesContractImport";

/**
 * Sales Contract master VIEW / EDIT page — mirrors the exported Excel one-to-one.
 * Top: the two banner fields the user types manually (Block Contract Ref, Revise).
 * Below: one editable row per PO with the EIGHT Excel columns.
 *
 * Lives under /sales-contract/view/<id> (the Sales Contract Creation module's
 * URL space, NOT the H&M-specific page). Only data derived from the uploaded
 * PDFs appears here — nothing is auto-filled from unrelated sources.
 */
export const dynamic = "force-dynamic";

interface StoredRow {
  isAnchor: boolean;
  orderNo: string;
  orderQty: number | null;
  styleNo: string;
  fob: number | null;
  itemDes: string;
  tod: string;
  country: string;
  marketCode: string;
  marketQuantity: number;
  pctLabel: string;
  blanks: Record<string, string>;
  issues: string[];
}

export default async function SalesContractViewPage({ params }: { params: { id: string } }) {
  const contract = await prisma.hmSalesContract.findUnique({ where: { id: params.id } });
  if (!contract) notFound();

  const pos = await prisma.hmSalesContractPo.findMany({
    where: { contractId: contract.id },
    orderBy: { createdAt: "asc" },
    include: { edits: { orderBy: { editedAt: "asc" } } },
  });

  // Reduce every PO's edit history into a single overrides map per PO
  // (one row per PO → one bucket per PO), then build the editor's row model.
  const rows: SalesContractPoRow[] = pos.map((p) => {
    const stored = (JSON.parse(p.rowsJson || "[]") as StoredRow[])[0] ?? null;
    const styleNoFromPo = (() => {
      try {
        const poExtract = JSON.parse(p.poJson || "null") as { header?: { productName?: string } } | null;
        return poExtract?.header?.productName ?? "";
      } catch { return ""; }
    })();
    const overrides: Record<string, string | number | null> = {};
    for (const e of p.edits) {
      const o = JSON.parse(e.overridesJson || "{}") as Record<string, string | number | null>;
      Object.assign(overrides, o);
    }
    return {
      poId: p.id,
      orderNo: stored?.orderNo ?? p.orderNo,
      // The exported Style No. column uses the PO's productName — surface the
      // same value here so the editor shows what the Excel will actually hold.
      styleNo: stored?.styleNo || styleNoFromPo,
      itemDes: stored?.itemDes ?? "",
      orderQty: stored?.orderQty ?? null,
      fob: stored?.fob ?? null,
      tod: stored?.tod ?? "",
      marketCode: stored?.marketCode ?? "",
      overrides,
      state: p.state,
      reasons: p.reasons,
      packSet: contract.packSet,
    };
  });

  const ref = contract.marchentContNo || contract.id.slice(0, 10);
  const readyCount = rows.filter((r) => r.state === "READY").length;
  const canDownload = readyCount > 0;

  return (
    <div>
      <PageHeader
        title={`Sales Contract — ${ref}`}
        subtitle={`${pos.length} PO · ${readyCount} ready to export`}
        actions={
          <div className="flex gap-2">
            <Link href="/modules/sales-contract" className="btn-ghost text-xs">← Back</Link>
            <a
              href={canDownload ? `/api/hm-sales-contract/${contract.id}/download` : "#"}
              className={canDownload ? "btn-primary text-xs" : "btn-ghost text-xs cursor-not-allowed opacity-60"}
              aria-disabled={!canDownload}
            >
              ⬇ Download .xlsx
            </a>
          </div>
        }
      />

      <div className="mb-6">
        <SalesContractBannerEditor
          id={contract.id}
          values={{
            marchentContNo: contract.marchentContNo,
            reviseNo: contract.reviseNo,
          }}
        />
      </div>

      <h3 className="mb-3 text-sm font-semibold text-slate-800">PO rows ({rows.length} total — each cell editable)</h3>
      {rows.length === 0 ? (
        <div className="card p-6 text-center text-sm text-slate-400">
          No POs uploaded yet. Go back to the Sales Contract Creation module and upload a 3-PDF set — or use the bulk import below.
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map((r) => <SalesContractPoEditor key={r.poId} contractId={contract.id} po={r} />)}
        </div>
      )}

      <div className="mt-6">
        <SalesContractImport contractId={contract.id} />
      </div>
    </div>
  );
}
