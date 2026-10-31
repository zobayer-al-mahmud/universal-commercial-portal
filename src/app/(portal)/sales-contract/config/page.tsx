import { PageHeader } from "@/components/ui";
import { prisma } from "@/lib/db";
import {
  saveFolderMappingAction,
  saveBuyerCodeAction,
} from "@/app/actions/sales-contract-config";
import { listFolderMappings, listBuyerCodes } from "@/server/sales-contract/config-intake";

export const dynamic = "force-dynamic";

export default async function HmConfigPage() {
  const [folders, buyerCodes, contracts] = await Promise.all([
    listFolderMappings(),
    listBuyerCodes(),
    prisma.salesContract.findMany({ select: { contractNo: true }, where: { contractNo: { not: "" } }, distinct: ["contractNo"] }),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="H&M Sales Contract – configuration"
        subtitle="Folder-to-merchandiser mappings and per-(contract, folder) buyer-code mappings. These values feed the auto-filled columns on the Summary Excel; blank mappings surface the PO for review instead of inventing a value."
      />

      <section className="card space-y-3">
        <h2 className="font-semibold text-sm">Folder mappings</h2>
        <p className="text-xs text-slate-500">
          One row per source folder (A, B, C …). The <strong>sequence</strong> column sets the folder order inside each Sales Contract on the Summary Excel; the <strong>Column E date</strong> applies to every row from this folder across every contract; the <strong>Source path</strong> is the absolute local folder the &quot;Scan folder&quot; button reads (e.g. <code>D:\order\A</code>). Each row saves as one unit.
        </p>
        {folders.map((f) => (
          <form key={f.folderLetter} action={saveFolderMappingAction} className="grid gap-2 rounded-md border border-slate-200 p-3 sm:grid-cols-6">
            <input type="hidden" name="folderLetter" value={f.folderLetter} />
            <label className="text-xs">
              <span className="mb-1 inline-block text-slate-500">Folder</span>
              <input value={f.folderLetter} readOnly className="input w-full font-mono text-xs" />
            </label>
            <label className="text-xs">
              <span className="mb-1 inline-block text-slate-500">Seq</span>
              <input name="sequence" defaultValue={f.sequence} className="input w-full text-xs" />
            </label>
            <label className="text-xs">
              <span className="mb-1 inline-block text-slate-500">Column E date</span>
              <input name="commercialDate" defaultValue={f.commercialDate} placeholder="01 Nov, 2026" className="input w-full text-xs" />
            </label>
            <label className="text-xs sm:col-span-3">
              <span className="mb-1 inline-block text-slate-500">Source folder path (local, server-visible)</span>
              <input name="sourceFolderPath" defaultValue={f.sourceFolderPath} placeholder={`D:\\order\\${f.folderLetter}`} className="input w-full font-mono text-xs" />
            </label>
            <label className="text-xs sm:col-span-5">
              <span className="mb-1 inline-block text-slate-500">Merchandisers (one per line)</span>
              <textarea name="merchandisers" defaultValue={f.merchandisers.join("\n")} rows={3} className="input w-full text-xs" />
            </label>
            <div className="flex items-end justify-end">
              <button className="btn-primary text-xs">Save row</button>
            </div>
          </form>
        ))}
        <form action={saveFolderMappingAction} className="grid gap-2 rounded-md border border-dashed border-slate-300 bg-slate-50 p-3 sm:grid-cols-6">
          <label className="text-xs"><span className="mb-1 inline-block text-slate-500">New folder</span><input name="folderLetter" required maxLength={2} className="input w-full text-xs" /></label>
          <label className="text-xs"><span className="mb-1 inline-block text-slate-500">Seq</span><input name="sequence" defaultValue={folders.length} className="input w-full text-xs" /></label>
          <label className="text-xs"><span className="mb-1 inline-block text-slate-500">Column E date</span><input name="commercialDate" className="input w-full text-xs" /></label>
          <label className="text-xs sm:col-span-3"><span className="mb-1 inline-block text-slate-500">Source folder path</span><input name="sourceFolderPath" className="input w-full font-mono text-xs" placeholder="D:\order\A" /></label>
          <label className="text-xs sm:col-span-5"><span className="mb-1 inline-block text-slate-500">Merchandisers</span><textarea name="merchandisers" rows={2} className="input w-full text-xs" /></label>
          <div className="flex items-end justify-end"><button className="btn-primary text-xs">+ Add folder</button></div>
        </form>
      </section>

      <section className="card space-y-3">
        <h2 className="font-semibold text-sm">Buyer codes</h2>
        <p className="text-xs text-slate-500">One mapping per (Sales Contract number, folder). Example: contract 97 + folder A → <code>AGL 349 A</code>. The writer refuses to invent a code – a missing mapping is reported for review.</p>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-slate-50">
              <tr>
                <th className="th">Contract #</th>
                <th className="th">Folder</th>
                <th className="th">Buyer code</th>
                <th className="th"></th>
              </tr>
            </thead>
            <tbody>
              {buyerCodes.map((bc) => (
                <tr key={`${bc.contractNo}-${bc.folderLetter}`}>
                  <td className="td font-mono">{bc.contractNo}</td>
                  <td className="td font-mono">{bc.folderLetter}</td>
                  <td className="td">
                    <form action={saveBuyerCodeAction} className="flex items-center gap-1">
                      <input type="hidden" name="contractNo" value={bc.contractNo} />
                      <input type="hidden" name="folderLetter" value={bc.folderLetter} />
                      <input name="buyerCode" defaultValue={bc.buyerCode} className="input w-40 text-xs" />
                      <button className="btn-ghost text-xs">Save</button>
                    </form>
                  </td>
                  <td className="td text-xs text-slate-400">{bc.active ? "active" : "disabled"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <form action={saveBuyerCodeAction} className="flex flex-wrap items-end gap-2 border-t pt-3">
          <label className="text-xs">Contract #<br /><input name="contractNo" required list="hm-known-contract-nos" className="input w-20 text-xs" /></label>
          <datalist id="hm-known-contract-nos">
            {contracts.map((c) => <option key={c.contractNo} value={c.contractNo} />)}
          </datalist>
          <label className="text-xs">Folder<br /><input name="folderLetter" required maxLength={2} className="input w-14 text-xs" /></label>
          <label className="text-xs">Buyer code<br /><input name="buyerCode" required className="input w-40 text-xs" placeholder="AGL 349 A" /></label>
          <button className="btn-primary text-xs">+ Add / update buyer code</button>
        </form>
      </section>
    </div>
  );
}
