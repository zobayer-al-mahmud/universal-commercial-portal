"use client";

import { useFormState, useFormStatus } from "react-dom";
import { editRowAction, type EditRowState } from "@/app/actions/shipment-schedule";
import type { GridRow } from "./ShipmentScheduleGrid";

const INITIAL: EditRowState = {};

/**
 * Whole-row inline editor. Every ShipmentScheduleRow field is editable
 * (buyer/contract/order/PCS/fob/style/… + PDF-extracted fields + invoice).
 * Save = one server action call → batched update + append-only edit history.
 */
export function ShipmentScheduleRowEditor({
  row,
  scheduleId,
  onDone,
}: {
  row: GridRow;
  scheduleId: string;
  onDone: () => void;
}) {
  const [state, action] = useFormState(editRowAction, INITIAL);

  // When the action succeeds, close the editor (handled via effect-free useFormStatus pattern:
  // we read state.ok on render and schedule a microtask to close).
  if (state.ok) {
    queueMicrotask(onDone);
  }

  const num = (v: number | null) => (v == null ? "" : String(v));

  return (
    <tr className="bg-sky-50">
      <td colSpan={16} className="p-3">
        <form action={action} className="space-y-3">
          <input type="hidden" name="rowId" value={row.id} />
          <input type="hidden" name="scheduleId" value={scheduleId} />
          <div className="text-xs font-semibold text-slate-700">Edit row (every field is editable). Save records an append-only history entry.</div>

          <div className="grid gap-2 text-xs sm:grid-cols-3 lg:grid-cols-4">
            <Field label="Buyer Code" name="buyerCode" defaultValue={row.buyerCode} />
            <Field label="Cont.No." name="contractNo" defaultValue={row.contractNo} />
            <Field label="Date" name="contractDate" defaultValue={row.contractDate} />
            <Field label="OrderNo." name="orderNo" defaultValue={row.orderNo} />
            <Field label="PCS" name="pcs" defaultValue={num(row.pcs)} inputMode="numeric" />
            <Field label="STYLE" name="style" defaultValue={row.style} />
            <Field label="FOB" name="fob" defaultValue={num(row.fob)} inputMode="decimal" />
            <Field label="COMPOSITION" name="composition" defaultValue={row.composition} />
            <Field label="CAT" name="cat" defaultValue={row.cat} />
            <Field label="HTS" name="hts" defaultValue={row.hts} />
            <Field label="INVOICE" name="invoiceNo" defaultValue={row.invoiceNo} />
            <Field label="Mode" name="transportMode" defaultValue={row.transportMode} />

            <div className="sm:col-span-3 lg:col-span-4 mt-2 border-t border-slate-200 pt-2 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
              Market / booking (from PDF — edit if the PDF was wrong)
            </div>
            <Field label="Market+Sub" name="marketSubCode" defaultValue={row.marketSubCode} />
            <Field label="Market" name="marketCode" defaultValue={row.marketCode} />
            <Field label="SKU/ITEM" name="skuItem" defaultValue={row.skuItem} />
            <Field label="PDF OrderNo" name="pdfOrderNo" defaultValue={row.pdfOrderNo} />
            <Field label="Booking Ref" name="bookingRef" defaultValue={row.bookingRef} />
            <Field label="BCN" name="bcn" defaultValue={row.bcn} />
            <Field label="Booking Status" name="bookingStatus" defaultValue={row.bookingStatus} />
            <Field label="Port of Loading" name="portOfLoading" defaultValue={row.portOfLoading} />
            <Field label="Port of Discharge" name="portOfDischarge" defaultValue={row.portOfDischarge} />
            <Field label="Place of Delivery" name="placeOfDelivery" defaultValue={row.placeOfDelivery} />
            <Field label="PCS (PDF)" name="pdfPcs" defaultValue={num(row.pdfPcs)} inputMode="numeric" />
            <Field label="Cartons" name="cartons" defaultValue={num(row.cartons)} inputMode="numeric" />
            <Field label="Gross wt (kg)" name="grossWeightKg" defaultValue={num(row.grossWeightKg)} inputMode="decimal" />
            <Field label="Measurement (cbm)" name="measurementCbm" defaultValue={num(row.measurementCbm)} inputMode="decimal" />
          </div>

          <div className="flex items-end gap-3 border-t border-slate-200 pt-2">
            <label className="block flex-1">
              <div className="mb-1 text-[10px] font-medium text-slate-500">Change reason (optional)</div>
              <input name="reason" placeholder="e.g. invoice allocated manually" className="input w-full text-xs" />
            </label>
            <SaveBtn />
            <button type="button" className="btn-ghost text-xs" onClick={onDone}>Cancel</button>
          </div>

          {state.errors && state.errors.length > 0 ? (
            <ul className="text-xs text-rose-700">
              {state.errors.map((e, i) => <li key={i}>• {e}</li>)}
            </ul>
          ) : null}
        </form>
      </td>
    </tr>
  );
}

function Field({
  label,
  name,
  defaultValue,
  inputMode,
}: {
  label: string;
  name: string;
  defaultValue: string;
  inputMode?: "numeric" | "decimal";
}) {
  return (
    <label className="block">
      <div className="mb-0.5 text-[10px] font-medium text-slate-500">{label}</div>
      <input
        name={name}
        defaultValue={defaultValue}
        inputMode={inputMode}
        className="input w-full text-xs"
      />
    </label>
  );
}

function SaveBtn() {
  const { pending } = useFormStatus();
  return (
    <button className="btn-primary text-xs" disabled={pending}>
      {pending ? "Saving…" : "💾 Save"}
    </button>
  );
}
