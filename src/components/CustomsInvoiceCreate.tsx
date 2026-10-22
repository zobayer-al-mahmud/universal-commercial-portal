"use client";

import { useFormState, useFormStatus } from "react-dom";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { createInvoiceAction, type CustomsInvoiceCreateState } from "@/app/actions/customs-invoice";

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button className="btn-primary text-[10px]" disabled={pending}>
      {pending ? "Creating…" : "Create invoice"}
    </button>
  );
}

export function OrderNoCreateButton({ orderNo }: { orderNo: string }) {
  const router = useRouter();
  const [state, action] = useFormState<CustomsInvoiceCreateState, FormData>(createInvoiceAction, {});

  useEffect(() => {
    if (state.invoiceId) router.push(`/customs-invoice/${state.invoiceId}`);
  }, [state.invoiceId, router]);

  return (
    <form action={action} className="flex items-center gap-1">
      <input type="hidden" name="orderNo" value={orderNo} />
      <Submit />
      {state.error ? <span className="text-[10px] text-rose-600">{state.error}</span> : null}
    </form>
  );
}
