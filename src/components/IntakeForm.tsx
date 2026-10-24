"use client";

import Link from "next/link";
import { useFormState, useFormStatus } from "react-dom";
import { intakeAction, type IntakeActionState } from "@/app/actions/sales-contract";

const SAMPLE_PO = `PO Number: 644637-8756
Style Name: Slim Denim S4
Article: 7654321
Category: Trousers
Customer Group: Women
Construction: Woven
Season: 2-2026
Order Date: 09 Jun, 2026
Terms of Delivery: FCA
Transport By: Sea
Currency: USD

OW (OL-MX) 1000 10.50 09 Jun, 2026
CL (PM-CL) 1500 10.50 09 Jun, 2026`;

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button className="btn-primary" disabled={pending}>
      {pending ? "Processing…" : "Run intake"}
    </button>
  );
}

export function IntakeForm() {
  const [state, action] = useFormState<IntakeActionState, FormData>(intakeAction, {});
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <form action={action} className="card space-y-4 p-5">
        <div>
          <label className="label">Order Package subject *</label>
          <input
            name="subject"
            className="input"
            placeholder="Order Package 644637-8756 Slim Denim S4"
            defaultValue="Order Package 644637-8756 Slim Denim S4"
            required
          />
        </div>
        <div>
          <label className="label">Attachment filenames (comma / newline separated)</label>
          <textarea
            name="attachments"
            className="input h-20 font-mono text-xs"
            defaultValue={
              "644637_PurchaseOrder_Supplier_x.pdf\n644637_SizePerColourBreakdown_Supplier_x.pdf\n644637_TotalCountryBreakdown_Supplier_x.pdf"
            }
          />
          <p className="mt-1 text-xs text-slate-400">Attach the three expected PDFs for this order package.</p>
        </div>
        <div>
          <label className="label">Block contract ref</label>
          <input name="blockContractRef" className="input" defaultValue="AGL/H&M/99/2026" />
        </div>
        <div>
          <label className="label">Purchase Order text (pdftotext layout)</label>
          <textarea name="poText" className="input h-56 font-mono text-xs" defaultValue={SAMPLE_PO} />
        </div>
        <Submit />
      </form>

      <div className="card p-5">
        <h3 className="mb-3 text-sm font-semibold text-slate-700">Result</h3>
        {state.error ? <p className="text-sm text-rose-600">{state.error}</p> : null}
        {!state.result && !state.error ? (
          <p className="text-sm text-slate-400">
            Submit an Order Package to run the deterministic extraction → normalisation → validation →
            reconciliation pipeline. Live UCP submission stays disabled (mock adapter).
          </p>
        ) : null}
        {state.result ? (
          <div className="space-y-3 text-sm">
            <div className="flex items-center gap-2">
              <span className="font-medium">Job:</span>
              <Link href={`/jobs/${state.result.jobId}`} className="font-mono text-ananta hover:underline">
                {state.result.jobId.slice(0, 10)}
              </Link>
              <span className="badge bg-slate-100 text-slate-700">{state.result.status}</span>
              {state.result.duplicate ? <span className="badge bg-slate-200">duplicate</span> : null}
            </div>
            <div><span className="font-medium">Order numbers:</span> {state.result.orderNumbers.join(", ") || "none"}</div>
            <div><span className="font-medium">Contract rows drafted:</span> {state.result.contractRowCount}</div>
            <div><span className="font-medium">Review tickets:</span> {state.result.reviewTicketCount}</div>
            <div>
              <div className="font-medium">UCP adapter:</div>
              <ul className="ml-4 list-disc text-xs text-slate-600">
                {state.result.ucpMessages.map((m, i) => (
                  <li key={i}>{m}</li>
                ))}
              </ul>
            </div>
            <div className="flex gap-3 pt-2">
              <Link href={`/jobs/${state.result.jobId}`} className="btn-ghost text-xs">View job</Link>
              {state.result.reviewTicketCount > 0 ? (
                <Link href="/review" className="btn-ghost text-xs">Open review queue</Link>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
