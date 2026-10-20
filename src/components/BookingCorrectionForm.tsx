"use client";

import Link from "next/link";
import { useFormState, useFormStatus } from "react-dom";
import { bookingCorrectionAction, type BookingActionState } from "@/app/actions/booking-correction";

const ORIGINAL = `Order No: 698757
Market: VN
Market Code: VNW221
SO Number: SO-SAMPLE-001
Style: Sample Denim Trouser
Cartons: 120
PCS: 2400
Gross Weight: 864.55
Container No: SEKU5903184`;

const CORRECTED = `Order No: 698757
Market: VN
Market Code: VNW221
SO Number: SO-SAMPLE-001
Style: Sample Denim Trouser
Cartons: 118
PCS: 2400
Gross Weight: 860.10
Container No: MRKU5565050`;

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button className="btn-primary" disabled={pending}>
      {pending ? "Comparing…" : "Compare & verify"}
    </button>
  );
}

export function BookingCorrectionForm() {
  const [state, action] = useFormState<BookingActionState, FormData>(bookingCorrectionAction, {});
  return (
    <div className="space-y-4">
      <form action={action} className="card space-y-4 p-5">
        <div className="grid gap-4 lg:grid-cols-2">
          <div>
            <label className="label">Original booking (Label: value)</label>
            <textarea name="original" className="input h-56 font-mono text-[11px]" defaultValue={ORIGINAL} />
          </div>
          <div>
            <label className="label">Corrected booking (Label: value)</label>
            <textarea name="corrected" className="input h-56 font-mono text-[11px]" defaultValue={CORRECTED} />
          </div>
        </div>
        <p className="text-xs text-slate-400">
          Identity fields (Order No / Market / Market Code) are locked — changing them means a
          different booking and routes to review. Damco verification is read-only (mock); applying a
          correction to the portal is a gated step.
        </p>
        <Submit />
      </form>

      {state.error ? <div className="card p-4 text-sm text-rose-600">{state.error}</div> : null}
      {state.result ? (
        <div className="card p-5 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">Job:</span>
            <Link href={`/jobs/${state.result.jobId}`} className="font-mono text-ananta hover:underline">
              {state.result.jobId.slice(0, 10)}
            </Link>
            <span className="badge bg-slate-100 text-slate-700">{state.result.status}</span>
            <span className="badge bg-sky-100 text-sky-700">{state.result.bookingKey}</span>
            {state.result.duplicate ? <span className="badge bg-slate-200">duplicate</span> : null}
          </div>
          <ul className="ml-4 mt-2 list-disc text-slate-600">
            <li>Allowed corrections: <strong className="text-green-700">{state.result.allowedCount}</strong></li>
            <li>Disallowed (locked) changes: <strong className="text-rose-700">{state.result.disallowedCount}</strong></li>
            <li>Review tickets: {state.result.reviewTicketCount}</li>
            <li>Damco: {state.result.damcoMessage}</li>
          </ul>
          <Link href={`/jobs/${state.result.jobId}`} className="btn-ghost mt-3 text-xs">View correction diff</Link>
        </div>
      ) : null}
    </div>
  );
}
