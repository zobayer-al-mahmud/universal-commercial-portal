"use client";

import { useFormState, useFormStatus } from "react-dom";
import { saveCorrectedPdfAction, type EditPdfState } from "@/app/actions/booking-batch";

function Apply({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button className="btn-primary text-xs disabled:opacity-40" disabled={pending || disabled}>
      {pending ? "Editing PDF…" : "✓ Apply Booking Confirmation (edit PDF in place)"}
    </button>
  );
}

/**
 * Booking PDF editor. Applies the confirmation edit IN PLACE to the captured
 * Damco/Maersk portal PDF — title "Booking Requested" → "Booking Confirmation"
 * and Status "REQUESTED" → "CONFIRMED" — without adding a page or changing the
 * layout. UCP only allows this once the Damco portal status is verified as
 * CONFIRMED (heading + status), so the document never misrepresents an
 * unconfirmed booking.
 */
export function PdfEditor(props: {
  docId: string;
  batchId: string;
  initial: {
    title: string;
    soNumber: string;
    company: string;
    buyer: string;
    poNumber: string;
    countryCode: string;
    grossWeight: string;
    cartons: string;
    quantity: string;
    bookingStatus: string;
  };
  verifiedConfirmed: boolean;
  hasPortalPdf: boolean;
  portalHeading: string;
  portalField: string;
}) {
  const [state, action] = useFormState<EditPdfState, FormData>(saveCorrectedPdfAction, {});
  const blocked = !props.verifiedConfirmed || !props.hasPortalPdf;

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="docId" value={props.docId} />

      {/* Context */}
      <div className="grid gap-1 text-xs text-slate-600 sm:grid-cols-2">
        <div><span className="text-slate-400">SO / Booking:</span> {props.initial.soNumber || "—"}</div>
        <div><span className="text-slate-400">PO:</span> {props.initial.poNumber || "—"}</div>
        <div><span className="text-slate-400">Country / SKU:</span> {props.initial.countryCode || "—"}</div>
        <div><span className="text-slate-400">Portal status:</span> heading “{props.portalHeading || "?"}”, field “{props.portalField || "?"}”</div>
      </div>

      {/* What this does */}
      <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
        Applying edits the captured portal PDF <strong>in place</strong>: the title “Booking Requested” → “Booking Confirmation”
        and the Status field “REQUESTED” → “CONFIRMED”. No page is added; the original two-page layout, tables, borders, logos and
        all other text are preserved. The original uploaded PDF and the captured portal PDF are kept unchanged.
      </div>

      {/* Gate state */}
      {!props.hasPortalPdf ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
          No captured Damco portal PDF to edit yet. Run the one-click re-verify on the batch page to capture it first.
        </div>
      ) : !props.verifiedConfirmed ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
          The Damco portal has not been verified as <strong>CONFIRMED</strong> (heading + status) for this booking. UCP will not
          change the document to Confirmed until it is — run the one-click re-verify first. This prevents misrepresenting an
          unconfirmed booking.
        </div>
      ) : (
        <div className="rounded-md border border-green-200 bg-green-50 p-3 text-xs text-green-800">
          Damco verified <strong>CONFIRMED</strong> — you can apply the in-place confirmation edit.
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Apply disabled={blocked} />
        <a href={`/api/booking/doc/${props.docId}/corrected`} className="btn-ghost text-xs">⬇ Download corrected PDF</a>
        {state.error ? <span className="text-xs text-rose-600">{state.error}</span> : null}
        {state.ok && !state.error ? <span className="text-xs text-green-700">Done — the corrected PDF is ready to download.</span> : null}
      </div>
    </form>
  );
}
