import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { PageHeader } from "@/components/ui";
import { SalesContractHeader } from "@/components/SalesContractHeader";
import { SalesContractScanner } from "@/components/SalesContractScanner";
import { SalesContractSheetView } from "@/components/SalesContractSheetView";
import { SalesContractPreview, type SalesContractPreviewPo } from "@/components/SalesContractPreview";
import { listFolderMappings } from "@/server/sales-contract/config-intake";
import { reassignPoByOrderNoAction } from "@/app/actions/sales-contract-config";

export const dynamic = "force-dynamic";

export default async function SalesContractDetail({ params }: { params: { id: string } }) {
  const contract = await prisma.salesContract.findUnique({ where: { id: params.id } });
  if (!contract) notFound();

  const [pos, folderMappings, allContracts] = await Promise.all([
    prisma.salesContractPo.findMany({
      where: { contractId: contract.id },
      orderBy: { createdAt: "asc" },
      include: { pdfs: true, edits: { orderBy: { editedAt: "asc" } } },
    }),
    listFolderMappings(),
    prisma.salesContract.findMany({ orderBy: { contractNo: "asc" }, select: { id: true, contractNo: true, marchentContNo: true } }),
  ]);
  const configuredFolders = folderMappings
    .filter((m) => m.active && m.sourceFolderPath)
    .map((m) => ({
      folderLetter: m.folderLetter,
      sourceFolderPath: m.sourceFolderPath,
      merchandisers: m.merchandisers,
    }));

  const previewPos: SalesContractPreviewPo[] = pos.map((p) => {
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

  return (
    <div>
      <PageHeader
        title={`Sales Contract ${contract.contractNo || contract.id.slice(0, 8)}`}
        subtitle={`${pos.length} PO set(s) · ${readyRows} row(s) ready to export${blockedPos ? ` · ${blockedPos} BLOCKED` : ""}`}
        actions={
          <a href={`/api/sales-contract/${contract.id}/sheet`} download className="btn-primary text-xs">
            ⬇ Download .xlsx
          </a>
        }
      />

      <div className="mb-6">
        <SalesContractHeader
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
            contractNo: contract.contractNo,
          }}
        />
      </div>

      <div className="mb-6">
        <SalesContractScanner
          contractId={contract.id}
          contractNo={contract.contractNo}
          contractDate={contract.contractDate}
          marchentContNo={contract.marchentContNo}
          folders={configuredFolders}
          defaultFolderLetter={pos[pos.length - 1]?.folderLetter ?? ""}
        />
      </div>

      <div className="mb-6">
        <SalesContractSheetView contractId={contract.id} />
      </div>

      <div className="mb-6 grid gap-2 sm:grid-cols-3">
        <SummaryStat label="PO sets" value={pos.length} />
        <SummaryStat label="Rows ready to export" value={readyRows} tone="text-green-700" />
        <SummaryStat label="Blocked / failed" value={pos.filter((p) => p.state !== "READY").length} tone="text-amber-700" />
      </div>

      {previewPos.length === 0 ? (
        <div className="card p-6 text-center text-sm text-slate-400">
          No POs uploaded yet. Use the uploader above to add one.
        </div>
      ) : (
        <>
          {/* Move a single PO to another Sales Contract — type the order no,
              pick the target, click Move. The datalist suggests orders on
              this contract so misspellings become obvious. */}
          <form action={reassignPoByOrderNoAction} className="card mb-4 flex flex-wrap items-end gap-2 p-4">
            <input type="hidden" name="fromContractId" value={contract.id} />
            <label className="text-xs">
              <span className="mb-1 inline-block text-slate-500">Move PO (Order No)</span>
              <input
                name="orderNo"
                required
                list="po-orderno-list"
                placeholder="e.g. 643159-8756"
                className="input w-48 font-mono text-xs"
              />
            </label>
            <datalist id="po-orderno-list">
              {pos.map((p) => <option key={p.id} value={p.orderNo} />)}
            </datalist>
            <label className="text-xs">
              <span className="mb-1 inline-block text-slate-500">To Sales Contract</span>
              <select name="newContractId" required defaultValue="" className="input w-64 text-xs">
                <option value="" disabled>— pick target —</option>
                {allContracts.filter((c) => c.id !== contract.id).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.marchentContNo || (c.contractNo ? (/AGL/i.test(c.contractNo) ? c.contractNo : `AGL/H&M/${c.contractNo}`) : "(unnamed)")}
                  </option>
                ))}
              </select>
            </label>
            <button className="btn-primary text-xs">Move</button>
            <p className="w-full pt-1 text-[11px] text-slate-400">
              {pos.length} PO{pos.length === 1 ? "" : "s"} on this contract — totalling {totalRows} row{totalRows === 1 ? "" : "s"}.
            </p>
          </form>

          {(() => {
            // Only render per-PO detail cards for POs that actually need
            // attention — a real match problem, a blocked write, a FAILED
            // state, or a missing-field reason that is NOT just noisy
            // per-market QTY/SIZE recon chatter. Clean READY POs stay quiet.
            const needsAttention = previewPos.filter((p) => {
              if (p.blockWrite) return true;
              if (p.state === "FAILED" || p.state === "BLOCKED") return true;
              const real = (p.reasons || "")
                .split(/\r?\n/)
                .map((l) => l.trim())
                .filter((l) => l.length > 0 && !l.startsWith("QTY_MISMATCH ") && !l.startsWith("SIZE_MISMATCH "));
              return real.length > 0;
            });
            if (needsAttention.length === 0) return null;
            return (
              <>
                <h4 className="mb-2 mt-4 text-xs font-semibold uppercase tracking-wide text-amber-700">
                  POs needing review ({needsAttention.length})
                </h4>
                {needsAttention.map((p) => <SalesContractPreview key={p.id} contractId={contract.id} po={p} />)}
              </>
            );
          })()}
        </>
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
