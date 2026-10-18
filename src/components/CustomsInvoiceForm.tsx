"use client";

import Link from "next/link";
import { useFormState, useFormStatus } from "react-dom";
import { customsInvoiceAction, type CustomsInvoiceActionState } from "@/app/actions/customs-invoice";

const SAMPLE_ITEMS = `Women Woven Trouser|62046200|100|5.50
Women Woven Trouser|62046200|50|5.50`;

function Field({ name, label, def }: { name: string; label: string; def: string }) {
  return (
    <div>
      <label className="label">{label}</label>
      <input name={name} className="input" defaultValue={def} />
    </div>
  );
}

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button className="btn-primary" disabled={pending}>
      {pending ? "Building…" : "Build invoice"}
    </button>
  );
}

export function CustomsInvoiceForm() {
  const [state, action] = useFormState<CustomsInvoiceActionState, FormData>(customsInvoiceAction, {});
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <form action={action} className="card space-y-3 p-5">
        <div className="grid grid-cols-2 gap-3">
          <Field name="invoiceNumber" label="Invoice number" def="45901" />
          <Field name="marketCode" label="Market code" def="NH" />
          <Field name="invoiceDate" label="Invoice date" def="28.12.2025" />
          <Field name="contractNo" label="Contract No." def="AGL/H&M/99/2026" />
          <Field name="contractDate" label="Contract date" def="09.06.2026" />
          <Field name="hmOrderNo" label="H&M order no." def="700300/8757" />
          <Field name="expNo" label="Exp no." def="31999" />
          <Field name="expDate" label="Exp date" def="28.12.2025" />
          <Field name="portOfLoading" label="Port of loading" def="CHITTAGONG" />
          <Field name="portOfDelivery" label="Port of delivery" def="Singapore" />
          <Field name="countryOfOrigin" label="Country of origin" def="Bangladesh" />
          <Field name="countryOfFinalDestination" label="Final destination" def="MALAYSIA" />
        </div>
        <div>
          <label className="label">Line items (description|HS code|qty|unit price)</label>
          <textarea name="lineItems" className="input h-24 font-mono text-[11px]" defaultValue={SAMPLE_ITEMS} />
        </div>
        <Submit />
      </form>

      <div className="card p-5">
        <h3 className="mb-3 text-sm font-semibold text-slate-700">Invoice result</h3>
        {state.error ? <p className="text-sm text-rose-600">{state.error}</p> : null}
        {!state.result && !state.error ? (
          <p className="text-sm text-slate-400">
            Build a customs invoice. The per-market cargo-delivery consignee is resolved from
            reference data; an unknown market raises a review note. Workbook export is a gated step.
          </p>
        ) : null}
        {state.result ? (
          <div className="space-y-2 text-sm">
            <div className="flex items-center gap-2">
              <span className="font-medium">Job:</span>
              <Link href={`/jobs/${state.result.jobId}`} className="font-mono text-ananta hover:underline">
                {state.result.jobId.slice(0, 10)}
              </Link>
              <span className="badge bg-slate-100 text-slate-700">{state.result.status}</span>
              <span className="badge bg-sky-100 text-sky-700">{state.result.invoiceKey}</span>
              {state.result.duplicate ? <span className="badge bg-slate-200">duplicate</span> : null}
            </div>
            <ul className="ml-4 list-disc text-sm text-slate-600">
              <li>Total quantity: {state.result.totalQty.toLocaleString()}</li>
              <li>Total value: {state.result.totalValue.toLocaleString()}</li>
              <li>Review tickets: {state.result.reviewTicketCount}</li>
            </ul>
            <Link href={`/jobs/${state.result.jobId}`} className="btn-ghost mt-2 text-xs">View invoice document</Link>
          </div>
        ) : null}
      </div>
    </div>
  );
}
