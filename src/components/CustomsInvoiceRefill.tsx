"use client";

import { useFormState, useFormStatus } from "react-dom";
import { refillInvoiceFromSourcesAction, type RefillInvoiceState } from "@/app/actions/customs-invoice";

/**
 * One-click "refill header from Sales Contract + Shipment Schedule" button for
 * an existing customs invoice. Only backfills fields that are still blank
 * on the stored invoice — user-edited values are left alone. Lets an invoice
 * that was created before the schedule row carried an Invoice No. / Expected
 * Delivery pick them up without a delete+recreate.
 */
export function CustomsInvoiceRefill({ invoiceId }: { invoiceId: string }) {
  const [state, action] = useFormState<RefillInvoiceState, FormData>(
    refillInvoiceFromSourcesAction,
    {},
  );
  return (
    <form action={action} className="inline-flex items-center gap-2">
      <input type="hidden" name="invoiceId" value={invoiceId} />
      <RefillButton />
      {state.error ? <span className="text-xs text-red-700">{state.error}</span> : null}
      {state.message ? <span className="text-xs text-slate-500">{state.message}</span> : null}
      {typeof state.updated === "number" && state.updated > 0 ? (
        <span className="text-xs text-emerald-700">Backfilled {state.updated} field{state.updated === 1 ? "" : "s"}.</span>
      ) : null}
    </form>
  );
}

function RefillButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className="btn-ghost text-xs">
      {pending ? "Refilling…" : "↺ Refill from sources"}
    </button>
  );
}
