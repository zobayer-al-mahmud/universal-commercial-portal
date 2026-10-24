import Link from "next/link";
import { prisma } from "@/lib/db";
import { PageHeader, Empty } from "@/components/ui";
import { createHmSalesContractAction } from "@/app/actions/hm-sales-contract";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

async function createAndRedirect() {
  "use server";
  const res = await createHmSalesContractAction();
  if (res.error || !res.id) throw new Error(res.error ?? "Failed to create contract");
  redirect(`/hm-sales-contract/${res.id}`);
}

export default async function HmSalesContractListPage() {
  const contracts = await prisma.hmSalesContract.findMany({ orderBy: { createdAt: "desc" }, take: 50, include: { pos: true } });

  return (
    <div>
      <PageHeader
        title="H&M Sales Contracts (three-PDF-set workflow)"
        subtitle="Upload three H&M PDFs per PO and download a ready-to-use workbook for each contract."
        actions={
          <form action={createAndRedirect}>
            <button className="btn-primary text-xs">+ New Sales Contract</button>
          </form>
        }
      />
      {contracts.length === 0 ? (
        <Empty>No H&M Sales Contracts yet. Click &quot;+ New Sales Contract&quot; to start one.</Empty>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-slate-50">
              <tr>
                <th className="th">Contract</th>
                <th className="th">POs</th>
                <th className="th">Ready / Blocked / Failed</th>
                <th className="th">Status</th>
                <th className="th">Created</th>
                <th className="th"></th>
              </tr>
            </thead>
            <tbody>
              {contracts.map((c) => {
                const ready = c.pos.filter((p) => p.state === "READY").length;
                const blocked = c.pos.filter((p) => p.state === "BLOCKED").length;
                const failed = c.pos.filter((p) => p.state === "FAILED").length;
                return (
                  <tr key={c.id} className="border-t border-slate-50">
                    <td className="td font-mono">
                      <Link href={`/hm-sales-contract/${c.id}`} className="text-ananta hover:underline">{c.id.slice(0, 10)}</Link>
                      {c.marchentContNo ? <span className="ml-2 text-slate-500">{c.marchentContNo}</span> : null}
                    </td>
                    <td className="td">{c.pos.length}</td>
                    <td className="td">
                      <span className="text-green-700">{ready}</span> / <span className="text-amber-700">{blocked}</span> / <span className="text-rose-700">{failed}</span>
                    </td>
                    <td className="td"><span className="badge bg-slate-100 text-slate-600">{c.status}</span></td>
                    <td className="td text-slate-400">{c.createdAt.toISOString().slice(0, 16).replace("T", " ")}</td>
                    <td className="td"><Link href={`/hm-sales-contract/${c.id}`} className="text-ananta hover:underline">Open →</Link></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
