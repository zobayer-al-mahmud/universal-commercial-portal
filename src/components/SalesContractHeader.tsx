"use client";

import { useFormStatus } from "react-dom";
import { updateSalesContractHeaderAction } from "@/app/actions/sales-contract";

interface HeaderValues {
  marchentContNo: string;
  contractDate: string;
  buyerCode: string;
  commercialContNo: string;
  commercialDate: string;
  merchandiserName: string;
  packSet: string;
  remarksDefault: string;
  contractNo: string;
}

/**
 * Sales Contract-level header editor. The two fields the 2026-10-26 spec made
 * contract-level are:
 *   - contractNo (numeric; e.g. "97") – drives the Column A ref and the per-
 *     (contractNo, folderLetter) buyer-code lookup.
 *   - contractDate – Column B date, shared across every row of this contract.
 * The other fields remain editable per-contract overrides.
 */
export function SalesContractHeader({ id, values }: { id: string; values: HeaderValues }) {
  return (
    <form action={updateSalesContractHeaderAction} className="card space-y-3 p-5">
      <h3 className="text-sm font-semibold text-slate-800">Sales Contract header</h3>
      <input type="hidden" name="id" value={id} />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Contract # (numeric)" name="contractNo" defaultValue={values.contractNo} placeholder="97" />
        <Field label="Contract Date" name="contractDate" defaultValue={values.contractDate} placeholder="23 Oct, 2026" />
        <Field label="Pack / Set" name="packSet" defaultValue={values.packSet} placeholder="1" />
        <Field label="Remarks (default)" name="remarksDefault" defaultValue={values.remarksDefault} />
        {/* Hidden passthroughs so unused legacy fields are not wiped on save. */}
        <input type="hidden" name="marchentContNo" value={values.marchentContNo} />
        <input type="hidden" name="commercialContNo" value={values.commercialContNo} />
        <input type="hidden" name="buyerCode" value={values.buyerCode} />
        <input type="hidden" name="commercialDate" value={values.commercialDate} />
        <input type="hidden" name="merchandiserName" value={values.merchandiserName} />
      </div>
      <SaveButton />
    </form>
  );
}

function Field({ label, name, defaultValue, placeholder }: { label: string; name: string; defaultValue: string; placeholder?: string }) {
  return (
    <label className="block text-xs">
      <span className="mb-1 inline-block text-slate-500">{label}</span>
      <input name={name} defaultValue={defaultValue} placeholder={placeholder} className="input text-xs" />
    </label>
  );
}

function SaveButton() {
  const { pending } = useFormStatus();
  return <button className="btn-primary text-xs" disabled={pending}>{pending ? "Saving…" : "Save header"}</button>;
}
