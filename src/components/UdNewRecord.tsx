"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createUdRecordAction } from "@/app/actions/ud-automation";

/** Step 1 launcher: start a new UD or open an existing one, for the chosen factory. */
export function UdNewRecord({ factoryId }: { factoryId: string }) {
  const router = useRouter();
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [udNumber, setUdNumber] = useState("");
  const [title, setTitle] = useState("");
  const [error, setError] = useState("");
  const [pending, start] = useTransition();

  function submit() {
    setError("");
    start(async () => {
      const res = await createUdRecordAction({ factoryId, mode, udNumber: udNumber.trim(), title: title.trim() });
      if ("error" in res) {
        setError(res.error);
        return;
      }
      router.push(`/ud-automation/${res.id}?factory=${factoryId}`);
    });
  }

  return (
    <div className="card p-5">
      <h3 className="text-sm font-semibold text-slate-800">Start a UD workflow</h3>
      <p className="mb-3 mt-1 text-sm text-slate-500">Open UD — select an existing UD or start a new one.</p>

      <div className="mb-3 flex gap-2">
        <button
          type="button"
          onClick={() => setMode("new")}
          className={`btn-sm ${mode === "new" ? "btn-primary" : "btn-ghost"}`}
        >
          New UD
        </button>
        <button
          type="button"
          onClick={() => setMode("existing")}
          className={`btn-sm ${mode === "existing" ? "btn-primary" : "btn-ghost"}`}
        >
          Existing UD
        </button>
      </div>

      {mode === "existing" ? (
        <div className="mb-3">
          <label className="label">Existing UD number</label>
          <input className="input" value={udNumber} onChange={(e) => setUdNumber(e.target.value)} placeholder="e.g. UD-123456" />
        </div>
      ) : null}

      <div className="mb-3">
        <label className="label">Label (optional)</label>
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="A name to find this workflow later" />
      </div>

      {error ? <div className="mb-2 rounded-md border border-rose-200 bg-rose-50 p-2 text-sm text-rose-700">{error}</div> : null}

      <button type="button" className="btn-primary btn-sm" disabled={pending} onClick={submit}>
        {pending ? "Starting…" : "Start workflow"}
      </button>
    </div>
  );
}
