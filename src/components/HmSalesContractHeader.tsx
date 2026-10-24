"use client";

import { useFormStatus } from "react-dom";
import { updateHmHeaderAction } from "@/app/actions/hm-sales-contract";

interface HeaderValues {
  marchentContNo: string;
  contractDate: string;
  buyerCode: string;
  commercialContNo: string;
  commercialDate: string;
  merchandiserName: string;
  packSet: string;
  remarksDefault: string;
}

/**
 * Sales Contract-level header editor. These values stay blank by default
 * (BR-HM-01..05) and populate columns A/B/C/D/E/P/Q/S on every exported row.
 * No value is auto-filled from any PDF.
 */
export function HmSalesContractHeader({ id, values }: { id: string; values: HeaderValues }) {
  return (
    <form action={updateHmHeaderAction} className="card space-y-3 p-5">
      <h3 className="text-sm font-semibold text-slate-800">Sales Contract header</h3>
      <input type="hidden" name="id" value={id} />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="A Marchent Cont.No." name="marchentContNo" defaultValue={values.marchentContNo} placeholder="AGL/H&M/99-A/2026" />
        <Field label="B Date" name="contractDate" defaultValue={values.contractDate} placeholder="dd.mm.yyyy" />
        <Field label="C Buyer Code" name="buyerCode" defaultValue={values.buyerCode} placeholder="AGL 349 A" />
        <Field label="D commercial Cont.No." name="commercialContNo" defaultValue={values.commercialContNo} placeholder="AGL/H&M/99/2026" />
        <Field label="E Date" name="commercialDate" defaultValue={values.commercialDate} placeholder="dd.mm.yyyy" />
        <Field label="Q Merchandiser Name" name="merchandiserName" defaultValue={values.merchandiserName} />
        <Field label="S pack/set" name="packSet" defaultValue={values.packSet} placeholder="optional" />
        <Field label="P REMARKS (default)" name="remarksDefault" defaultValue={values.remarksDefault} />
      </div>
      <SaveButton />
      <p className="text-xs text-slate-400">
        These fields come from the header and are not read from the PDFs. Leave any field blank if it does not apply.
      </p>
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
