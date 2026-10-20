import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { PageHeader, StatusBadge, Stat } from "@/components/ui";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { retrySalesItemAction, reprocessSalesBatchAction } from "@/app/actions/sales-contract-batch";

export const dynamic = "force-dynamic";

const STATE_TONE: Record<string, string> = {
  DRAFTED: "bg-green-100 text-green-800",
  NEEDS_REVIEW: "bg-amber-100 text-amber-800",
  BLOCKED: "bg-amber-100 text-amber-800",
  DUPLICATE: "bg-slate-100 text-slate-600",
  FAILED: "bg-rose-100 text-rose-800",
};
function tone(state: string) {
  return STATE_TONE[state] ?? "bg-sky-100 text-sky-800";
}

const DECISION_TONE: Record<string, string> = {
  EXISTING_CONTRACT: "bg-green-100 text-green-800",
  NEW_CONTRACT: "bg-sky-100 text-sky-800",
  DUPLICATE: "bg-slate-100 text-slate-600",
  AMENDMENT: "bg-indigo-100 text-indigo-700",
  NEEDS_REVIEW: "bg-amber-100 text-amber-800",
};

const RETRYABLE = ["NEEDS_REVIEW", "BLOCKED", "FAILED", "DUPLICATE"];

export default async function SalesContractBatchPage({ params }: { params: { batchId: string } }) {
  const batch = await prisma.salesContractBatch.findUnique({ where: { id: params.batchId } });
  if (!batch) notFound();
  const items = await prisma.salesContractBatchItem.findMany({ where: { batchId: batch.id }, orderBy: { serial: "asc" } });

  const user = await getSessionUser();
  const canRetry = userHasPermission(user, PERMISSIONS.JOB_RETRY);

  return (
    <div>
      <PageHeader
        title={`Sales Contract batch ${batch.id.slice(0, 8)}`}
        subtitle={`Bulk PO upload · ${batch.totalItems} file(s)${batch.blockRef ? ` · block ${batch.blockRef}` : ""}`}
        actions={<StatusBadge status={batch.status} />}
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-5">
        <Stat label="Files" value={batch.totalItems} />
        <Stat label="Drafted" value={batch.draftedItems} tone="text-green-700" />
        <Stat label="Needs review" value={batch.reviewItems} tone="text-amber-700" />
        <Stat label="Blocked (new)" value={batch.blockedItems} tone="text-amber-700" />
        <Stat label="Failed" value={batch.failedItems} tone="text-rose-700" />
      </div>

      <div className="mb-6 flex flex-wrap items-center gap-2">
        {canRetry ? (
          <form action={reprocessSalesBatchAction}>
            <input type="hidden" name="batchId" value={batch.id} />
            <button className="btn-ghost text-xs">↻ Reprocess non-drafted</button>
          </form>
        ) : null}
        <Link href="/modules/sales-contract" className="btn-ghost text-xs">← Back to module</Link>
        <Link href="/review" className="btn-ghost text-xs">Review queue →</Link>
      </div>

      {/* Unified processing table — one row per PO/document (§3.3, §8). */}
      <section className="card mb-8 overflow-x-auto">
        <div className="border-b border-slate-100 px-4 py-3 text-sm font-semibold text-slate-700">Processing results</div>
        <table className="w-full whitespace-nowrap text-xs">
          <thead className="bg-slate-50">
            <tr>
              <th className="th">SL</th>
              <th className="th">Source PDF</th>
              <th className="th">OrderNo(s)</th>
              <th className="th">PO rows</th>
              <th className="th">Target contract / Buyer Code</th>
              <th className="th">Decision</th>
              <th className="th">State</th>
              <th className="th">Write</th>
              <th className="th">Notes</th>
              <th className="th">When</th>
              <th className="th">Action</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it) => (
              <tr key={it.id} className="border-t border-slate-50 align-top">
                <td className="td">{it.serial}</td>
                <td className="td max-w-[180px] truncate" title={it.originalName}>{it.originalName}</td>
                <td className="td font-mono">{it.orderNumbers || "—"}</td>
                <td className="td">{it.poRowCount || (it.textChars < 40 ? "NOT EXTRACTED" : "0")}</td>
                <td className="td font-mono text-[11px]">
                  {it.targetContractRef || "—"}
                  {it.buyerCode ? <span className="text-slate-400"> · {it.buyerCode}</span> : null}
                  {it.proposed ? <span className="ml-1 badge bg-sky-100 text-sky-700">proposed</span> : null}
                </td>
                <td className="td">{it.decision ? <span className={`badge ${DECISION_TONE[it.decision] ?? "bg-slate-100 text-slate-600"}`}>{it.decision}</span> : "—"}</td>
                <td className="td"><span className={`badge ${tone(it.state)}`}>{it.state}</span></td>
                <td className="td">{it.blockWrite ? <span className="text-rose-700">blocked</span> : <span className="text-green-700">allowed</span>}</td>
                <td className="td max-w-[280px] whitespace-normal text-slate-600">{it.reasons || it.error || "—"}</td>
                <td className="td text-slate-400">{it.processedAt ? it.processedAt.toISOString().slice(5, 16).replace("T", " ") : "—"}</td>
                <td className="td">
                  {canRetry && RETRYABLE.includes(it.state) ? (
                    <form action={retrySalesItemAction}>
                      <input type="hidden" name="itemId" value={it.id} />
                      <input type="hidden" name="batchId" value={batch.id} />
                      <button className="text-ananta hover:underline">↻ Retry</button>
                    </form>
                  ) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <p className="text-xs text-slate-400">
        Each PDF is processed independently (a failure in one never blocks the rest). Values are extracted from the document,
        never invented; missing data is shown as <span className="font-medium">NOT EXTRACTED</span> or routed to
        <span className="font-medium"> NEEDS REVIEW</span>. A verified existing contract is reused rather than duplicated; a new
        contract is created only under an authorised numbering / Buyer-Code rule, otherwise it is blocked for approval.
      </p>
    </div>
  );
}
