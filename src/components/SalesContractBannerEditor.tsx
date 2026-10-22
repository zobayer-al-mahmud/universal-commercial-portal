"use client";

/**
 * The ONLY editable header for a Sales Contract — mirrors the two banner lines
 * that appear at the top of the exported .xlsx:
 *   "Block Contract Ref:  : <marchentContNo>"
 *   "Revise: <reviseNo>"
 * Both are typed manually by the user; nothing is auto-filled from a PDF.
 * Blank → the matching banner line is omitted from the workbook.
 */
import { useTransition } from "react";
import { updateSalesContractBannerAction } from "@/app/actions/sales-contract-banner";

export interface SalesContractBannerValues {
  marchentContNo: string;
  reviseNo: string;
}

export function SalesContractBannerEditor({ id, values }: { id: string; values: SalesContractBannerValues }) {
  const [pending, start] = useTransition();
  const submit = (formData: FormData) => {
    start(async () => {
      await updateSalesContractBannerAction(formData);
    });
  };

  return (
    <form action={submit} className="card p-4">
      <div className="mb-3 text-sm font-semibold text-slate-800">Sales Contract banner (editable; typed manually, appears at the top of the Excel)</div>
      <input type="hidden" name="id" value={id} />
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label">Block Contract Ref</label>
          <input name="marchentContNo" className="input" defaultValue={values.marchentContNo} placeholder="AGL/H&M/99/2026" />
          <p className="mt-1 text-[11px] text-slate-400">Exported as the first banner line: "Block Contract Ref:  : …"</p>
        </div>
        <div>
          <label className="label">Revise</label>
          <input name="reviseNo" className="input" defaultValue={values.reviseNo} placeholder="21" />
          <p className="mt-1 text-[11px] text-slate-400">Exported as the second banner line: "Revise: …"</p>
        </div>
      </div>
      <button className="btn-primary mt-3 text-xs" disabled={pending}>{pending ? "Saving…" : "Save banner"}</button>
    </form>
  );
}
