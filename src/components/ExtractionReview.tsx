"use client";

import { useFormState, useFormStatus } from "react-dom";
import { applyExtractionCorrectionAction, type CorrectionState } from "@/app/actions/booking-batch";

function Save() {
  const { pending } = useFormStatus();
  return <button className="btn-primary text-xs" disabled={pending}>{pending ? "Saving & reprocessing…" : "Save correction & reprocess"}</button>;
}

export function ExtractionReview(props: {
  docId: string;
  poNumber: string;
  countryCode: string;
  grossWeight: string;
  cartons: string;
  quantity: string;
}) {
  const [state, action] = useFormState<CorrectionState, FormData>(applyExtractionCorrectionAction, {});
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-5">
      <input type="hidden" name="docId" value={props.docId} />
      <div>
        <label className="label text-xs">PO Number</label>
        <input name="poNumber" className="input text-xs" defaultValue={props.poNumber} />
      </div>
      <div>
        <label className="label text-xs">Country</label>
        <input name="countryCode" className="input text-xs" defaultValue={props.countryCode} />
      </div>
      <div>
        <label className="label text-xs">Gross Weight</label>
        <input name="grossWeight" className="input text-xs" defaultValue={props.grossWeight} />
      </div>
      <div>
        <label className="label text-xs">Total Cartons</label>
        <input name="cartons" className="input text-xs" defaultValue={props.cartons} />
      </div>
      <div>
        <label className="label text-xs">Total Quantity</label>
        <input name="quantity" className="input text-xs" defaultValue={props.quantity} />
      </div>
      <div className="sm:col-span-5 flex items-center gap-3">
        <Save />
        {state.error ? <span className="text-xs text-rose-600">{state.error}</span> : null}
        {state.ok ? <span className="text-xs text-green-700">Saved — document reprocessed.</span> : null}
      </div>
    </form>
  );
}
