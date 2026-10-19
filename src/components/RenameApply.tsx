"use client";

import { useFormState, useFormStatus } from "react-dom";
import { applyRenameAction, type RenameApplyState } from "@/app/actions/rename-apply";

function Btn({ mode, label, primary }: { mode: string; label: string; primary?: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button name="mode" value={mode} className={primary ? "btn-primary text-xs" : "btn-ghost text-xs"} disabled={pending}>
      {pending ? "Working…" : label}
    </button>
  );
}

export function RenameApply({ jobId, canApply }: { jobId: string; canApply: boolean }) {
  const [state, action] = useFormState<RenameApplyState, FormData>(applyRenameAction, {});

  if (!canApply) {
    return <p className="px-4 py-3 text-xs text-slate-400">You need the rename-apply permission to copy renamed files.</p>;
  }

  return (
    <div className="px-4 py-3">
      <form action={action} className="flex items-center gap-2">
        <input type="hidden" name="jobId" value={jobId} />
        <Btn mode="dryrun" label="Dry-run" />
        <Btn mode="apply" label="Apply (copy renamed files)" primary />
        <span className="text-xs text-slate-400">Copies planned files into the output dir; originals untouched, no overwrite.</span>
      </form>
      {state.error ? <p className="mt-2 text-sm text-rose-600">{state.error}</p> : null}
      {state.result ? (
        <div className="mt-2 text-sm">
          <p className={state.result.dryRun ? "text-sky-700" : "text-green-700"}>
            {state.result.dryRun ? "Dry-run" : "Applied"}: copied {state.result.summary.copy}
            {", "}target-exists {state.result.summary["target-exists"]}
            {", "}missing-source {state.result.summary["missing-source"]}
            {", "}skipped {state.result.summary["skipped-not-planned"]}
            {", "}already-applied {state.result.summary["already-applied"]}.
          </p>
          <p className="text-xs text-slate-400">Output: {state.result.outputDir}</p>
          {state.result.copied.length ? (
            <ul className="ml-4 mt-1 list-disc text-xs text-slate-600">
              {state.result.copied.map((c, i) => (
                <li key={i} className="font-mono">{c.originalName} → {c.targetName}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
