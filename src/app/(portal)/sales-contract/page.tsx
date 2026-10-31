import Link from "next/link";
import { prisma } from "@/lib/db";
import { PageHeader, Empty } from "@/components/ui";
import { createSalesContractAction } from "@/app/actions/sales-contract";
import { listFolderMappings } from "@/server/sales-contract/config-intake";
import { SalesContractScanner } from "@/components/SalesContractScanner";
import { SalesContractListTable, type SalesContractListRow } from "@/components/SalesContractListTable";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

async function createAndRedirect() {
  "use server";
  const res = await createSalesContractAction();
  if (res.error || !res.id) throw new Error(res.error ?? "Failed to create contract");
  redirect(`/sales-contract/${res.id}`);
}

export default async function SalesContractListPage() {
  const [contracts, folderMappings] = await Promise.all([
    prisma.salesContract.findMany({ orderBy: { createdAt: "desc" }, take: 50, include: { pos: true } }),
    listFolderMappings(),
  ]);
  const current = contracts.find((c) => c.isCurrent) ?? null;
  const configuredFolders = folderMappings
    .filter((m) => m.active && m.sourceFolderPath)
    .map((m) => ({ folderLetter: m.folderLetter, sourceFolderPath: m.sourceFolderPath, merchandisers: m.merchandisers }));

  const contractLabel = (c: { contractNo: string; marchentContNo: string }) => {
    const mc = (c.marchentContNo || "").trim();
    if (mc) return mc;
    const cn = (c.contractNo || "").trim();
    if (!cn) return "(unnamed)";
    // If the user typed the whole ref in the Contract # field, show it as-is.
    return /AGL/i.test(cn) ? cn : `AGL/H&M/${cn}`;
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Sales Contract Creation"
        subtitle="Scan a source folder and the extracted orders are added to the current Sales Contract. The consolidated Summary Excel includes every contract in ascending contract-number order."
        actions={
          <div className="flex items-center gap-2">
            <Link href="/sales-contract/config" className="btn-ghost text-xs">Config</Link>
            <a href="/api/sales-contract/summary" className="btn-ghost text-xs" download>Download Summary Excel</a>
            <form action={createAndRedirect}>
              <button className="btn-primary text-xs">+ New Sales Contract</button>
            </form>
          </div>
        }
      />

      <div className="card text-xs">
        <div className="font-semibold mb-1">Current Sales Contract (default for new uploads)</div>
        {current ? (
          <div className="text-slate-700">
            <span className="font-mono">{contractLabel(current)}</span>
          </div>
        ) : (
          <div className="text-amber-700">No contract marked current — pick one in the table below.</div>
        )}
      </div>

      {/* In-page scanner: feeds extracted orders into the CURRENT contract.
          Hidden until a current contract exists (nothing to feed into otherwise). */}
      {current ? (
        <SalesContractScanner
          contractId={current.id}
          contractNo={current.contractNo}
          contractDate={current.contractDate}
          marchentContNo={current.marchentContNo}
          folders={configuredFolders}
        />
      ) : null}

      {contracts.length === 0 ? (
        <Empty>No H&M Sales Contracts yet. Click &quot;+ New Sales Contract&quot; to start one.</Empty>
      ) : (
        <SalesContractListTable
          rows={contracts.map<SalesContractListRow>((c) => ({
            id: c.id,
            label: contractLabel(c),
            isCurrent: c.isCurrent,
            posCount: c.pos.length,
            ready: c.pos.filter((p) => p.state === "READY").length,
            blocked: c.pos.filter((p) => p.state === "BLOCKED").length,
            failed: c.pos.filter((p) => p.state === "FAILED").length,
            status: c.status,
            createdAt: c.createdAt.toISOString().slice(0, 16).replace("T", " "),
          }))}
        />
      )}
    </div>
  );
}
