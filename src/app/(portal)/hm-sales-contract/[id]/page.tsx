import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { PageHeader } from "@/components/ui";
import { HmSalesContractHeader } from "@/components/HmSalesContractHeader";
import { HmSalesContractUpload } from "@/components/HmSalesContractUpload";
import { HmSalesContractPreview, type HmPreviewPo } from "@/components/HmSalesContractPreview";

export const dynamic = "force-dynamic";

export default async function HmSalesContractDetail({ params }: { params: { id: string } }) {
  const contract = await prisma.hmSalesContract.findUnique({ where: { id: params.id } });
  if (!contract) notFound();

  const pos = await prisma.hmSalesContractPo.findMany({
    where: { contractId: contract.id },
    orderBy: { createdAt: "asc" },
    include: { pdfs: true, edits: { orderBy: { editedAt: "asc" } } },
  });

  const previewPos: HmPreviewPo[] = pos.map((p) => {
    const rows = JSON.parse(p.rowsJson || "[]");
    const recon = JSON.parse(p.reconJson || "{}") as { ok?: boolean; checks?: { ok: boolean; name: string; expected: number; actual: number }[] };
    // Reduce the edit log into the latest-per-column override per market row.
    const overrides: Record<string, Record<string, string | number | null>> = {};
    for (const e of p.edits) {
      const o = JSON.parse(e.overridesJson || "{}") as Record<string, string | number | null>;
      overrides[e.marketCode] = { ...(overrides[e.marketCode] ?? {}), ...o };
    }
    const reconMessage = recon.ok ? "" : (recon.checks ?? []).filter((c) => !c.ok).map((c) => `${c.name}: expected ${c.expected}, got ${c.actual}`).join("; ");
    return {
      id: p.id,
      orderNo: p.orderNo,
      state: p.state,
      blockWrite: p.blockWrite,
      reasons: p.reasons,
      reconOk: !!recon.ok,
      reconMessage,
      rows,
      overrides,
    };
  });

  const totalRows = previewPos.reduce((a, p) => a + p.rows.length, 0);
  const readyRows = previewPos.filter((p) => p.state === "READY").reduce((a, p) => a + p.rows.length, 0);
  const blockedPos = previewPos.filter((p) => p.blockWrite).length;

  const canDownload = env.HM_SALES_CONTRACT_TEMPLATE_PATH && readyRows > 0;

  return (
    <div>
      <PageHeader
        title={`H&M Sales Contract ${contract.id.slice(0, 8)}`}
        subtitle={`${pos.length} PO set(s) · ${readyRows} row(s) ready to export${blockedPos ? ` · ${blockedPos} BLOCKED` : ""}`}
        actions={
          <Link
            href={canDownload ? `/api/hm-sales-contract/${contract.id}/download` : "#"}
            className={canDownload ? "btn-primary text-xs" : "btn-ghost text-xs cursor-not-allowed opacity-60"}
            aria-disabled={!canDownload}
          >
            ⬇ Download .xlsx
          </Link>
        }
      />

      {!env.HM_SALES_CONTRACT_TEMPLATE_PATH ? (
        <div className="mb-5 card border border-amber-200 bg-amber-50 p-4 text-xs text-amber-800">
          Set <code>HM_SALES_CONTRACT_TEMPLATE_PATH</code> in <code>.env</code> to the user&apos;s live Sales Contract workbook before downloading. The writer never overwrites the template.
        </div>
      ) : null}

      <div className="mb-6">
        <HmSalesContractHeader
          id={contract.id}
          values={{
            marchentContNo: contract.marchentContNo,
            contractDate: contract.contractDate,
            buyerCode: contract.buyerCode,
            commercialContNo: contract.commercialContNo,
            commercialDate: contract.commercialDate,
            merchandiserName: contract.merchandiserName,
            packSet: contract.packSet,
            remarksDefault: contract.remarksDefault,
          }}
        />
      </div>

      <div className="mb-6">
        <HmSalesContractUpload contractId={contract.id} />
      </div>

      <div className="mb-6 grid gap-2 sm:grid-cols-3">
        <SummaryStat label="PO sets" value={pos.length} />
        <SummaryStat label="Rows ready to export" value={readyRows} tone="text-green-700" />
        <SummaryStat label="Blocked / failed" value={pos.filter((p) => p.state !== "READY").length} tone="text-amber-700" />
      </div>

      <h3 className="mb-3 text-sm font-semibold text-slate-700">PO sets ({totalRows} total row{totalRows !== 1 ? "s" : ""})</h3>
      {previewPos.length === 0 ? (
        <div className="card p-6 text-center text-sm text-slate-400">
          No POs uploaded yet. Use the uploader above to add one.
        </div>
      ) : (
        previewPos.map((p) => <HmSalesContractPreview key={p.id} contractId={contract.id} po={p} />)
      )}
    </div>
  );
}

function SummaryStat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="card p-3">
      <div className="text-[10px] font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`mt-1 text-xl font-semibold ${tone ?? "text-slate-800"}`}>{value}</div>
    </div>
  );
}
