"use client";

import { useFormState, useFormStatus } from "react-dom";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  updateInvoiceAction,
  type CustomsInvoiceEditState,
} from "@/app/actions/customs-invoice";
import {
  INVOICE_FIELD_LABELS,
  INVOICE_FLOAT_FIELDS,
  INVOICE_INT_FIELDS,
  INVOICE_STRING_FIELDS,
  type InvoiceFields,
} from "@/server/customs-invoice/types";

const SECTIONS: { title: string; keys: (keyof InvoiceFields)[] }[] = [
  {
    title: "Header",
    keys: ["invoiceNumber", "invoiceDate", "contractNo", "contractDate", "hmOrderNo", "expNo", "expDate", "currency"],
  },
  {
    title: "Country / template",
    keys: ["marketCode", "marketSubCode", "countryCode", "countryOfOrigin", "countryOfFinalDestination"],
  },
  {
    title: "Transport",
    keys: ["portOfLoading", "portOfDischarge", "placeOfDelivery", "transportMode", "vesselName", "voyageNo", "sailingDate", "termsOfDelivery", "termsOfPayment"],
  },
  {
    title: "Parties",
    keys: ["exporterName", "buyerName", "consigneeName", "cargoDeliveryName", "issuingBank"],
  },
  {
    title: "Goods",
    keys: ["descriptionOfGoods", "styleNo", "buyerCode", "hsCode", "category", "packSet"],
  },
  {
    title: "Quantity / weights",
    keys: ["quantityPcs", "unitPrice", "totalCartons", "grossWeightKg", "netWeightKg", "measurementCbm", "dimension"],
  },
];

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button className="btn-primary text-xs" disabled={pending}>
      {pending ? "Saving…" : "💾 Save"}
    </button>
  );
}

function fieldKind(key: keyof InvoiceFields): "string" | "int" | "float" {
  if ((INVOICE_INT_FIELDS as readonly string[]).includes(key)) return "int";
  if ((INVOICE_FLOAT_FIELDS as readonly string[]).includes(key)) return "float";
  if ((INVOICE_STRING_FIELDS as readonly string[]).includes(key)) return "string";
  return "string";
}

function toInputValue(key: keyof InvoiceFields, v: unknown): string {
  if (v == null) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  return String(v);
}

export function CustomsInvoiceEditor({ invoiceId, initial }: { invoiceId: string; initial: InvoiceFields }) {
  const router = useRouter();
  const [state, action] = useFormState<CustomsInvoiceEditState, FormData>(updateInvoiceAction, {});
  const [current, setCurrent] = useState<InvoiceFields>(initial);

  // When server reports a successful save, refresh the server component so the
  // edit history + prefilled values re-sync.
  useEffect(() => {
    if (state.updated != null && state.updated >= 0 && !state.error) {
      router.refresh();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.updated, state.error]);

  // Re-hydrate when parent re-renders with new initial values (eg after a PDF upload).
  useEffect(() => {
    setCurrent(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(initial)]);

  return (
    <form action={action} className="card space-y-4 p-5">
      <input type="hidden" name="invoiceId" value={invoiceId} />
      {SECTIONS.map((s) => (
        <section key={s.title}>
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{s.title}</h4>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {s.keys.map((k) => {
              const kind = fieldKind(k);
              const v = current[k];
              const multi = k === "descriptionOfGoods" || k === "exporterName" || k === "buyerName" || k === "consigneeName" || k === "cargoDeliveryName" || k === "issuingBank";
              return (
                <label key={k} className="block">
                  <span className="label">{INVOICE_FIELD_LABELS[k]}</span>
                  {multi ? (
                    <textarea
                      name={k}
                      value={toInputValue(k, v)}
                      onChange={(e) => setCurrent({ ...current, [k]: e.target.value } as InvoiceFields)}
                      className="input h-20 text-xs"
                    />
                  ) : (
                    <input
                      name={k}
                      type={kind === "string" ? "text" : "number"}
                      step={kind === "float" ? "any" : undefined}
                      value={toInputValue(k, v)}
                      onChange={(e) => setCurrent({ ...current, [k]: e.target.value } as InvoiceFields)}
                      className="input text-xs"
                    />
                  )}
                </label>
              );
            })}
          </div>
        </section>
      ))}
      <div className="flex items-center gap-3 border-t border-slate-100 pt-3">
        <Submit />
        {state.updated != null ? <span className="text-xs text-green-700">Saved {state.updated} field(s).</span> : null}
        {state.error ? <span className="text-xs text-rose-600">{state.error}</span> : null}
      </div>
    </form>
  );
}
